// Hallazgos de la revisión de seguridad de M1 (docs/auditoria/seguridad-correcciones.md):
// S-01 (volumen de auditoría acotado por `g`), S-02 (los fallos del dispositivo conocido cuentan
// en `g`), S-05 (claves derivadas con HKDF) y S-06 (`login_cupos` fuera del backup de R2).
// Worker real y D1/R2 locales reales (sin mocks).
import {
  MAX_INTENTOS_LOGIN,
  MAX_INTENTOS_LOGIN_GLOBAL,
  MENSAJES_ERROR,
  uuidv7,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hmacTruncado } from '../src/auth/dispositivo';
import { ejecutarBackup, prefijoDelDia } from '../src/cron/backup';
import { TABLAS_BACKUP, TABLAS_EXCLUIDAS_BACKUP } from '../src/cron/tablas';
import { crearUsuarioConClave, peticion } from './auth-helpers';
import { leerManifest } from './fase6-cron-helpers';

const CREDENCIALES_INVALIDAS = {
  status: 401,
  cuerpo: { code: 'CREDENCIALES_INVALIDAS', message: MENSAJES_ERROR.CREDENCIALES_INVALIDAS },
};

function prefijo64(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16);
  return `2001:db8:${h()}:${h()}`;
}

function ipv4Aleatoria(): string {
  const o = () => Math.floor(Math.random() * 254) + 1;
  return `10.${String(o())}.${String(o())}.${String(o())}`;
}

function intentar(
  email: string,
  password: string,
  opciones: { ip?: string; cookie?: string } = {},
) {
  return peticion('/api/v1/auth/login', {
    body: { email, password, device_id: uuidv7() },
    ip: opciones.ip ?? ipv4Aleatoria(),
    headers: opciones.cookie === undefined ? {} : { Cookie: `mp_dispositivo=${opciones.cookie}` },
  });
}

async function cuerpoYEstado(respuesta: Response) {
  return { status: respuesta.status, cuerpo: await respuesta.json() };
}

async function cookieConocida(email: string, password: string): Promise<string> {
  const respuesta = await intentar(email, password);
  expect(respuesta.status).toBe(200);
  const linea = respuesta.headers.getSetCookie().find((l) => l.startsWith('mp_dispositivo='));
  return (linea?.split(';')[0] ?? '').slice('mp_dispositivo='.length);
}

async function cupo(userId: string, filtro: 'g' | 'd' | 'ip') {
  const condicion = filtro === 'g' ? "origen = 'g'" : `origen GLOB '${filtro}:*'`;
  return env.DB.prepare(
    `SELECT fallos, bloqueado_hasta FROM login_cupos WHERE user_id = ? AND ${condicion}`,
  )
    .bind(userId)
    .first<{ fallos: number; bloqueado_hasta: string | null }>();
}

async function bloqueosAuditados(userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT json_extract(datos_despues, '$.tipo') AS tipo FROM audit_log
     WHERE entidad = 'login_cupos' AND entidad_id = ? AND accion = 'login_cupos.bloqueado'
     ORDER BY seq`,
  )
    .bind(userId)
    .all<{ tipo: string }>();
  return results.map((r) => r.tipo);
}

/** 5 fallos desde cada uno de `redes` prefijos /64 (claves distintas para el limitador). */
async function agotarDesde(email: string, redes: string[]): Promise<void> {
  for (const red of redes) {
    await Promise.all(
      Array.from({ length: MAX_INTENTOS_LOGIN }, (_, i) =>
        intentar(email, `mala-${String(i)}`, { ip: `${red}::${String(i + 1)}` }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// S-01: todo bloqueo se audita (spec §5 d); el volumen lo acota `g`
// ---------------------------------------------------------------------------------------------

describe('S-01: volumen de auditoría de bloqueos acotado por g', () => {
  it('4 orígenes que agotan g dejan exactamente 4 origen + 1 global, y un 5.º origen no crea ninguna fila', async () => {
    const u = await crearUsuarioConClave();
    const redes = Array.from({ length: MAX_INTENTOS_LOGIN_GLOBAL / MAX_INTENTOS_LOGIN }, prefijo64);
    await agotarDesde(u.email, redes);
    expect(await cupo(u.id, 'g')).toMatchObject({ fallos: MAX_INTENTOS_LOGIN_GLOBAL });
    const tipos = await bloqueosAuditados(u.id);
    expect(tipos.filter((t) => t === 'origen')).toHaveLength(redes.length);
    expect(tipos.filter((t) => t === 'global')).toHaveLength(1);
    expect(tipos.length).toBeLessThanOrEqual(5);

    // Un 5.º origen en la misma ventana: sin cupo global no hay reserva, ni fila de IP, ni auditoría.
    const auditoriaAntes = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{
      n: number;
    }>();
    await agotarDesde(u.email, [prefijo64()]);
    const { results: ips } = await env.DB.prepare(
      `SELECT origen FROM login_cupos WHERE user_id = ? AND origen GLOB 'ip:*'`,
    )
      .bind(u.id)
      .all();
    expect(ips).toHaveLength(redes.length);
    expect(await bloqueosAuditados(u.id)).toEqual(tipos);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first()).toEqual(
      auditoriaAntes,
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// S-02: los fallos del dispositivo conocido también cuentan en `g`, sin que `g` lo bloquee
// ---------------------------------------------------------------------------------------------

describe('S-02: el dispositivo conocido cuenta en el tope global', () => {
  it('los fallos con la cookie suman en g', async () => {
    const u = await crearUsuarioConClave();
    const cookie = await cookieConocida(u.email, u.password);
    for (let i = 0; i < 3; i += 1) {
      expect(await cuerpoYEstado(await intentar(u.email, 'mala', { cookie }))).toEqual(
        CREDENCIALES_INVALIDAS,
      );
    }
    expect(await cupo(u.id, 'd')).toMatchObject({ fallos: 3 });
    expect(await cupo(u.id, 'g')).toMatchObject({ fallos: 3 });
    // Los fallos del dispositivo adelantan el bloqueo de los orígenes desconocidos: con 3 de g
    // gastados, 17 desconocidos bastan.
    await agotarDesde(u.email, [prefijo64(), prefijo64(), prefijo64()]);
    await Promise.all(
      Array.from({ length: 2 }, (_, i) =>
        intentar(u.email, 'mala', { ip: `${prefijo64()}::${String(i + 1)}` }),
      ),
    );
    expect(await cupo(u.id, 'g')).toMatchObject({ fallos: MAX_INTENTOS_LOGIN_GLOBAL });
    expect((await cupo(u.id, 'g'))?.bloqueado_hasta).not.toBeNull();
  }, 30_000);

  it('con g agotado por terceros, el dispositivo conocido sigue reservando y entrando (propiedad a)', async () => {
    const u = await crearUsuarioConClave('admin');
    const cookie = await cookieConocida(u.email, u.password);
    await agotarDesde(
      u.email,
      Array.from({ length: MAX_INTENTOS_LOGIN_GLOBAL / MAX_INTENTOS_LOGIN }, prefijo64),
    );
    expect((await cupo(u.id, 'g'))?.bloqueado_hasta).not.toBeNull();
    // Un fallo con la cookie se sigue contando en su cupo propio (g ya está bloqueado y no cambia).
    expect((await intentar(u.email, 'mala', { cookie })).status).toBe(401);
    expect(await cupo(u.id, 'd')).toMatchObject({ fallos: 1 });
    expect(await cupo(u.id, 'g')).toMatchObject({ fallos: MAX_INTENTOS_LOGIN_GLOBAL });
    expect((await intentar(u.email, u.password, { cookie })).status).toBe(200);
    expect(await cupo(u.id, 'd')).toMatchObject({ fallos: 0, bloqueado_hasta: null });
  }, 30_000);

  it('un login correcto con la cookie descuenta su propia reserva de g y no lo reinicia', async () => {
    const u = await crearUsuarioConClave();
    const cookie = await cookieConocida(u.email, u.password);
    await intentar(u.email, 'mala', { cookie });
    await intentar(u.email, 'mala', { cookie });
    expect((await intentar(u.email, u.password, { cookie })).status).toBe(200);
    expect(await cupo(u.id, 'g')).toMatchObject({ fallos: 2 });
  });

  it('el total de adivinanzas por ventana queda acotado: 20 en g más 5 por cada cookie válida', async () => {
    const u = await crearUsuarioConClave();
    const cookie = await cookieConocida(u.email, u.password);
    const intentos = [
      ...Array.from({ length: 10 }, () => () => intentar(u.email, 'mala', { cookie })),
      ...Array.from({ length: 40 }, () => () => intentar(u.email, 'mala')),
    ];
    for (let i = 0; i < intentos.length; i += 10) {
      await Promise.all(intentos.slice(i, i + 10).map((f) => f()));
    }
    const { results } = await env.DB.prepare(
      `SELECT origen, fallos FROM login_cupos WHERE user_id = ?`,
    )
      .bind(u.id)
      .all<{ origen: string; fallos: number }>();
    const desconocidos = results
      .filter((r) => r.origen.startsWith('ip:'))
      .reduce((n, r) => n + r.fallos, 0);
    const dispositivo = results.find((r) => r.origen.startsWith('d:'))?.fallos ?? 0;
    expect(dispositivo).toBe(MAX_INTENTOS_LOGIN);
    // Las reservas con la cookie consumieron g: los desconocidos tuvieron menos de 20.
    expect(desconocidos + dispositivo).toBeLessThanOrEqual(
      MAX_INTENTOS_LOGIN_GLOBAL + MAX_INTENTOS_LOGIN,
    );
    expect(results.find((r) => r.origen === 'g')?.fallos).toBe(MAX_INTENTOS_LOGIN_GLOBAL);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// S-05: claves derivadas con HKDF-SHA-256 (no con el mismo HMAC de `hashRefreshToken`)
// ---------------------------------------------------------------------------------------------

async function hkdfHmac(secreto: string, etiqueta: string, mensaje: string): Promise<Uint8Array> {
  const codificador = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', codificador.encode(secreto), 'HKDF', false, [
    'deriveKey',
  ]);
  const clave = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: codificador.encode(etiqueta) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', clave, codificador.encode(mensaje))).slice(
    0,
    16,
  );
}

describe('S-05: separación de claves', () => {
  it('las claves de la cookie y de la IP se derivan con HKDF y etiquetas distintas', async () => {
    const secreto = env.REFRESH_SECRET;
    for (const etiqueta of ['mp-dispositivo-v1', 'mp-ip-v1']) {
      expect(await hmacTruncado(secreto, etiqueta, 'mensaje')).toEqual(
        await hkdfHmac(secreto, etiqueta, 'mensaje'),
      );
    }
    expect(await hmacTruncado(secreto, 'mp-dispositivo-v1', 'x')).not.toEqual(
      await hmacTruncado(secreto, 'mp-ip-v1', 'x'),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// S-06: `login_cupos` (HMAC de IP, dato seudonimizado) no viaja al backup de R2
// ---------------------------------------------------------------------------------------------

describe('S-06: login_cupos fuera del backup', () => {
  it('no está en TABLAS_BACKUP, sí en la lista explícita de excluidas, y el manifest no la lista', async () => {
    expect(TABLAS_BACKUP.map((t) => t.nombre)).not.toContain('login_cupos');
    expect([...TABLAS_EXCLUIDAS_BACKUP]).toEqual(['login_cupos']);

    const u = await crearUsuarioConClave();
    await intentar(u.email, 'mala');
    expect(await cupo(u.id, 'g')).not.toBeNull();

    const fecha = '2026-12-24';
    await ejecutarBackup(env, new Date(`${fecha}T08:00:00.000Z`));
    const manifest = await leerManifest(fecha);
    expect(manifest?.tablas.map((t) => t.tabla)).not.toContain('login_cupos');
    const listado = await env.BACKUPS.list({ prefix: prefijoDelDia(fecha) });
    expect(listado.objects.some((o) => o.key.includes('login_cupos'))).toBe(false);
  }, 60_000);
});

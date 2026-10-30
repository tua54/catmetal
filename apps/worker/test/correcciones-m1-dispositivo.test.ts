// M1 (ADR 0018): cookie `mp_dispositivo` (firma, vencimiento, lectura robusta y renovación),
// normalización de la IP, desbloqueo de emergencia y purga de `login_cupos`. D1 local real.
import { MAX_INTENTOS_LOGIN, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  archivoSqlDesbloqueo,
  generarSqlDesbloqueo,
  normalizarEmail,
} from '../../../scripts/desbloqueo-emergencia-sql.mjs';
import { aBase64Url, bytesAleatorios } from '../src/auth/codificacion';
import { normalizarIp, origenDeDispositivo, origenDeIp } from '../src/auth/cupos';
import {
  diaUtc,
  entradaDelUsuario,
  firmarEntrada,
  MAX_BYTES_VALOR_DISPOSITIVO,
  MAX_ENTRADAS_DISPOSITIVO,
  nuevaEntrada,
  valoresCookieDispositivo,
} from '../src/auth/dispositivo';
import { ejecutarMantenimiento } from '../src/cron/mantenimiento';
import { crearUsuarioConClave, peticion } from './auth-helpers';
import { crearUsuario } from './fixtures-db';

// Pruebas con PBKDF2 y muchas peticiones: con la máquina cargada superan el límite por defecto de
// 5 s. Mismo valor que las demás pruebas pesadas del worker; no cambia ninguna aserción.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SECRETO = env.REFRESH_SECRET;
const AHORA_MS = Date.now();
const HOY = diaUtc(AHORA_MS);

function nonce(): string {
  return aBase64Url(bytesAleatorios(16));
}

/** Cambia un carácter de la firma (siempre distinto del original). */
function falsificar(texto: string): string {
  const i = texto.length - 5;
  const otro = texto[i] === 'A' ? 'B' : 'A';
  return `${texto.slice(0, i)}${otro}${texto.slice(i + 1)}`;
}

function ipv4Aleatoria(): string {
  const o = () => Math.floor(Math.random() * 254) + 1;
  return `10.${String(o())}.${String(o())}.${String(o())}`;
}

function intentar(email: string, password: string, cookie?: string, ip = ipv4Aleatoria()) {
  return peticion('/api/v1/auth/login', {
    body: { email, password, device_id: uuidv7() },
    ip,
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

function valorDispositivo(respuesta: Response): string | null {
  const linea = respuesta.headers.getSetCookie().find((l) => l.startsWith('mp_dispositivo='));
  return linea === undefined ? null : (linea.split(';')[0] ?? '').slice('mp_dispositivo='.length);
}

async function origenes(userId: string): Promise<{ origen: string; fallos: number }[]> {
  const { results } = await env.DB.prepare(
    'SELECT origen, fallos FROM login_cupos WHERE user_id = ? ORDER BY origen',
  )
    .bind(userId)
    .all<{ origen: string; fallos: number }>();
  return results;
}

// ---------------------------------------------------------------------------------------------
// IP normalizada
// ---------------------------------------------------------------------------------------------

describe('normalizarIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:cb00:7107', '203.0.113.7'],
    ['2001:db8:1:2::5', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    [undefined, 'local'],
    ['  ', 'local'],
    ['ip-de-prueba', 'ip-de-prueba'],
    ['1:2:3', '1:2:3'],
    ['1::2::3', '1::2::3'],
    ['::ffff:300.1.1.1', '::ffff:300.1.1.1'],
    ['999.1.1.1', '999.1.1.1'],
  ])('%s → %s', (ip, esperada) => {
    expect(normalizarIp(ip)).toBe(esperada);
  });

  it('el origen es un HMAC: igual dentro del /64, distinto entre /64, y sin la IP en claro', async () => {
    const a = await origenDeIp(SECRETO, '2001:db8:aa:bb::1');
    expect(await origenDeIp(SECRETO, '2001:db8:aa:bb:ffff::2')).toBe(a);
    expect(await origenDeIp(SECRETO, '2001:db8:aa:bc::1')).not.toBe(a);
    expect(a).toMatch(/^ip:[A-Za-z0-9_-]{22}$/);
    expect(a).not.toContain('2001');
    expect(
      await origenDeIp('otro-secreto-de-prueba-suficientemente-largo', '2001:db8:aa:bb::1'),
    ).not.toBe(a);
    expect(origenDeDispositivo('abc')).toBe('d:abc');
  });
});

// ---------------------------------------------------------------------------------------------
// Entradas de la cookie
// ---------------------------------------------------------------------------------------------

describe('entradas de mp_dispositivo', () => {
  it('una entrada válida se reconoce; falsificada, vencida, futura, de otro usuario o con otro secreto no', async () => {
    const userId = uuidv7();
    const valida = await nuevaEntrada(SECRETO, userId, AHORA_MS);
    expect(await entradaDelUsuario(SECRETO, [valida.texto], userId, AHORA_MS)).toEqual(valida);

    const falsificada = falsificar(valida.texto);
    const n = nonce();
    const vencida = await firmarEntrada(SECRETO, userId, HOY - 401, n);
    const limite = await firmarEntrada(SECRETO, userId, HOY - 400, n);
    const futura = await firmarEntrada(SECRETO, userId, HOY + 1, n);
    const otroSecreto = await firmarEntrada(
      'otro-secreto-de-prueba-suficientemente-largo',
      userId,
      HOY,
      n,
    );
    const deOtro = (await nuevaEntrada(SECRETO, uuidv7(), AHORA_MS)).texto;
    for (const texto of [falsificada, vencida, futura, otroSecreto, deOtro, 'v1.x', '']) {
      expect(await entradaDelUsuario(SECRETO, [texto], userId, AHORA_MS), texto).toBeNull();
    }
    // 400 días exactos todavía vale.
    expect(await entradaDelUsuario(SECRETO, [limite], userId, AHORA_MS)).not.toBeNull();
    // Cambiar el user_id invalida la firma.
    const ajena = valida.texto.replace(userId, uuidv7());
    expect(await entradaDelUsuario(SECRETO, [ajena], userId, AHORA_MS)).toBeNull();
  });

  it('lee todas las apariciones de la cookie y toma la primera entrada válida del usuario', async () => {
    const userId = uuidv7();
    const valida = await nuevaEntrada(SECRETO, userId, AHORA_MS);
    const cabecera = `mp_dispositivo=basura; mp_refresh=x; mp_dispositivo="${valida.texto}"`;
    const valores = valoresCookieDispositivo(cabecera);
    expect(valores).toEqual(['basura', valida.texto]);
    expect((await entradaDelUsuario(SECRETO, valores, userId, AHORA_MS))?.nonce).toBe(valida.nonce);
    expect(valoresCookieDispositivo(undefined)).toEqual([]);
    expect(valoresCookieDispositivo('otra=1; sin-igual; mp_dispositivo=')).toEqual([]);
  });

  it('ignora un valor de más de 4 KiB y revisa como máximo 16 entradas por valor', async () => {
    const userId = uuidv7();
    const valida = await nuevaEntrada(SECRETO, userId, AHORA_MS);
    const enorme = `${'x'.repeat(MAX_BYTES_VALOR_DISPOSITIVO)}~${valida.texto}`;
    expect(valoresCookieDispositivo(`mp_dispositivo=${enorme}`)).toEqual([]);

    const relleno = Array.from({ length: MAX_ENTRADAS_DISPOSITIVO }, () => 'v1.relleno');
    const tarde = [...relleno, valida.texto].join('~');
    expect(await entradaDelUsuario(SECRETO, [tarde], userId, AHORA_MS)).toBeNull();
    const aTiempo = [...relleno.slice(1), valida.texto].join('~');
    expect(await entradaDelUsuario(SECRETO, [aTiempo], userId, AHORA_MS)).not.toBeNull();
    // Muchas apariciones: se revisan como máximo 8.
    const muchas = Array.from({ length: 12 }, (_, i) => `mp_dispositivo=v${String(i)}`).join('; ');
    expect(valoresCookieDispositivo(muchas)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------------------------
// Login con entradas no válidas y renovación de la cookie
// ---------------------------------------------------------------------------------------------

describe('login con mp_dispositivo', () => {
  it('una entrada falsificada, vencida o de otro usuario cuenta como origen desconocido', async () => {
    const u = await crearUsuarioConClave();
    const otro = await crearUsuarioConClave();
    const n = nonce();
    const casos = [
      falsificar((await nuevaEntrada(SECRETO, u.id, AHORA_MS)).texto),
      await firmarEntrada(SECRETO, u.id, HOY - 401, n),
      (await nuevaEntrada(SECRETO, otro.id, AHORA_MS)).texto,
    ];
    const ip = ipv4Aleatoria();
    for (const entrada of casos) {
      expect((await intentar(u.email, 'mala', `mp_dispositivo=${entrada}`, ip)).status).toBe(401);
    }
    const filas = await origenes(u.id);
    expect(filas.filter((f) => f.origen.startsWith('d:'))).toEqual([]);
    expect(filas.find((f) => f.origen.startsWith('ip:'))?.fallos).toBe(casos.length);
    expect(filas.find((f) => f.origen === 'g')?.fallos).toBe(casos.length);
  });

  it('con varias apariciones de la cookie, la entrada válida se reconoce aunque vaya después', async () => {
    const u = await crearUsuarioConClave();
    const primera = await intentar(u.email, u.password);
    const valida = valorDispositivo(primera) ?? '';
    const cabecera = `mp_dispositivo=v1.plantada~basura; mp_dispositivo=${valida}`;
    expect((await intentar(u.email, 'mala', cabecera)).status).toBe(401);
    const filas = await origenes(u.id);
    expect(filas.filter((f) => f.origen.startsWith('d:'))).toEqual([
      { origen: expect.stringMatching(/^d:/) as string, fallos: 1 },
    ]);
  });

  it('la renovación pone primero la entrada nueva, conserva las válidas de otros y descarta las inválidas', async () => {
    const a = await crearUsuarioConClave();
    const b = await crearUsuarioConClave();
    const deA = valorDispositivo(await intentar(a.email, a.password)) ?? '';
    const viejaDeB = (await nuevaEntrada(SECRETO, b.id, AHORA_MS)).texto;
    const vencidaDeC = await firmarEntrada(SECRETO, uuidv7(), HOY - 500, nonce());
    const falsificada = falsificar(deA);
    const presentada = [deA, falsificada, viejaDeB, vencidaDeC].join('~');

    const respuesta = await intentar(b.email, b.password, `mp_dispositivo=${presentada}`);
    expect(respuesta.status).toBe(200);
    const entradas = (valorDispositivo(respuesta) ?? '').split('~');
    expect(entradas).toHaveLength(2);
    expect(entradas[0]?.split('.')[1]).toBe(b.id);
    expect(entradas[0]).not.toBe(viejaDeB);
    expect(entradas[1]).toBe(deA);
  });

  it('máximo 16 entradas: el usuario más antiguo de la tablet sale', async () => {
    const u = await crearUsuarioConClave();
    const otras = await Promise.all(
      Array.from(
        { length: MAX_ENTRADAS_DISPOSITIVO },
        async () => (await nuevaEntrada(SECRETO, uuidv7(), AHORA_MS)).texto,
      ),
    );
    const respuesta = await intentar(u.email, u.password, `mp_dispositivo=${otras.join('~')}`);
    const entradas = (valorDispositivo(respuesta) ?? '').split('~');
    expect(entradas).toHaveLength(MAX_ENTRADAS_DISPOSITIVO);
    expect(entradas[0]?.split('.')[1]).toBe(u.id);
    expect(entradas.slice(1)).toEqual(otras.slice(0, MAX_ENTRADAS_DISPOSITIVO - 1));
  });
});

// ---------------------------------------------------------------------------------------------
// Desbloqueo de emergencia (scripts/desbloqueo-emergencia-sql.mjs)
// ---------------------------------------------------------------------------------------------

async function aplicar(sentencias: readonly string[]): Promise<void> {
  for (const sentencia of sentencias) {
    await env.DB.prepare(sentencia).run();
  }
}

async function bloquearTodo(userId: string): Promise<void> {
  const ahora = new Date().toISOString();
  const hasta = new Date(Date.now() + 10 * 60_000).toISOString();
  const filas = [`d:${nonce()}`, `ip:${nonce()}`, 'g'];
  for (const origen of filas) {
    await env.DB.prepare(
      `INSERT INTO login_cupos (user_id, origen, fallos, ventana_inicio, bloqueado_hasta, reserva_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        userId,
        origen,
        origen === 'g' ? 20 : MAX_INTENTOS_LOGIN,
        ahora,
        hasta,
        uuidv7(),
        ahora,
        ahora,
      )
      .run();
  }
  await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
    .bind(hasta, userId)
    .run();
}

async function auditoriaDe(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT seq, entidad, accion, actor_id, device_id, datos_despues FROM audit_log
     WHERE entidad_id = ? ORDER BY seq`,
  )
    .bind(userId)
    .all<{
      seq: number;
      entidad: string;
      accion: string;
      actor_id: string | null;
      device_id: string | null;
      datos_despues: string;
    }>();
  return results;
}

describe('desbloqueo de emergencia', () => {
  it('desbloquea la cuenta, audita sin el correo, respeta los triggers y es idempotente', async () => {
    const u = await crearUsuarioConClave('admin');
    await bloquearTodo(u.id);
    expect((await intentar(u.email, u.password)).status).toBe(401);

    const sentencias = generarSqlDesbloqueo({ email: `  ${u.email.toUpperCase()} ` });
    expect(sentencias.join('\n')).not.toMatch(/\bDELETE\b/i);
    await aplicar(sentencias);

    const cupos = await env.DB.prepare(
      'SELECT fallos, bloqueado_hasta FROM login_cupos WHERE user_id = ?',
    )
      .bind(u.id)
      .all();
    expect(cupos.results).toEqual([
      { fallos: 0, bloqueado_hasta: null },
      { fallos: 0, bloqueado_hasta: null },
      { fallos: 0, bloqueado_hasta: null },
    ]);
    expect(
      await env.DB.prepare('SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?')
        .bind(u.id)
        .first(),
    ).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });

    const auditoria = await auditoriaDe(u.id);
    expect(auditoria.map((a) => [a.entidad, a.accion, a.actor_id, a.device_id])).toEqual([
      ['login_cupos', 'login_cupos.desbloqueo_emergencia', null, null],
      ['users', 'usuario.desbloqueado', null, null],
    ]);
    expect(JSON.parse(auditoria[0]?.datos_despues ?? '{}')).toEqual({
      user_id: u.id,
      tipo: 'todos',
      fallos: 0,
      bloqueado_hasta: null,
    });
    expect(JSON.parse(auditoria[1]?.datos_despues ?? '{}')).toEqual({
      id: u.id,
      intentos_fallidos: 0,
      bloqueado_hasta: null,
    });
    expect(auditoria.map((a) => a.datos_despues).join(' ')).not.toContain(u.email);
    // seq sin saltos (los triggers de audit_log aceptaron las filas).
    expect(auditoria[1]?.seq).toBe((auditoria[0]?.seq ?? 0) + 1);

    // El mismo archivo dos veces: sin error, sin filas nuevas.
    await aplicar(sentencias);
    expect(await auditoriaDe(u.id)).toHaveLength(2);

    expect((await intentar(u.email, u.password)).status).toBe(200);
  });

  it('con un correo inexistente no hace nada', async () => {
    const u = await crearUsuarioConClave();
    await bloquearTodo(u.id);
    const total = async () =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())?.n;
    const antes = await total();
    await aplicar(generarSqlDesbloqueo({ email: `nadie-${uuidv7()}@catmetal.test` }));
    expect(await total()).toBe(antes);
    const bloqueados = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM login_cupos WHERE user_id = ? AND bloqueado_hasta IS NOT NULL',
    )
      .bind(u.id)
      .first<{ n: number }>();
    expect(bloqueados?.n).toBe(3);
  });

  it('sin columnas heredadas que reiniciar solo audita el desbloqueo de los cupos', async () => {
    const u = await crearUsuarioConClave();
    await aplicar(generarSqlDesbloqueo({ email: u.email }));
    expect((await auditoriaDe(u.id)).map((a) => a.accion)).toEqual([
      'login_cupos.desbloqueo_emergencia',
    ]);
  });

  it('valida el correo y genera un archivo con comentarios y una sentencia por línea', () => {
    expect(() => generarSqlDesbloqueo({ email: 'no-es-correo' })).toThrow(/email/);
    expect(normalizarEmail(' A@B.CO ')).toBe('a@b.co');
    expect(normalizarEmail(42)).toBeNull();
    const contenido = archivoSqlDesbloqueo({
      email: "o'brien@catmetal.test",
      ahora: new Date('2026-10-30T12:00:00.000Z'),
    });
    const lineas = contenido.trim().split('\n');
    expect(lineas.filter((l) => l.startsWith('--'))).toHaveLength(2);
    expect(lineas.filter((l) => !l.startsWith('--'))).toHaveLength(4);
    expect(contenido).toContain("'o''brien@catmetal.test'");
    expect(contenido).toContain("'2026-10-30T12:00:00.000Z'");
  });
});

// ---------------------------------------------------------------------------------------------
// Purga del cron
// ---------------------------------------------------------------------------------------------

describe('purga de login_cupos', () => {
  it('borra solo las filas sin cambios hace más de 24 h y sin bloqueo vigente', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const userId = await crearUsuario();
    const ahora = new Date();
    const hace = (horas: number) => new Date(ahora.getTime() - horas * 3_600_000).toISOString();
    const futuro = new Date(ahora.getTime() + 600_000).toISOString();
    const casos = [
      { origen: 'ip:vieja', updated_at: hace(25), bloqueado_hasta: null, purgar: true },
      { origen: 'ip:vieja-vencida', updated_at: hace(30), bloqueado_hasta: hace(29), purgar: true },
      { origen: 'd:reciente', updated_at: hace(23), bloqueado_hasta: null, purgar: false },
      // Imposible en la práctica (el bloqueo dura 15 min), pero la condición lo protege.
      { origen: 'g', updated_at: hace(48), bloqueado_hasta: futuro, purgar: false },
    ];
    for (const caso of casos) {
      await env.DB.prepare(
        `INSERT INTO login_cupos (user_id, origen, fallos, ventana_inicio, bloqueado_hasta, reserva_id, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
        .bind(
          userId,
          caso.origen,
          caso.updated_at,
          caso.bloqueado_hasta,
          uuidv7(),
          caso.updated_at,
          caso.updated_at,
        )
        .run();
    }
    const resultado = await ejecutarMantenimiento(env, ahora);
    expect(resultado.login_cupos_purgados).toBeGreaterThanOrEqual(2);
    expect(resultado.purga_login_cupos_completa).toBe(true);
    const quedan = (await origenes(userId)).map((f) => f.origen).sort();
    expect(quedan).toEqual(
      casos
        .filter((c) => !c.purgar)
        .map((c) => c.origen)
        .sort(),
    );
    vi.restoreAllMocks();
  });
});

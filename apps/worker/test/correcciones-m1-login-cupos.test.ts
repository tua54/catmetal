// M1 (docs/correcciones-v1.1.md; ADR 0018): cupos de login por dispositivo conocido y por origen
// desconocido. Pruebas de regresión contra el Worker real y la D1 local real (sin mocks).
//
// Las IP de los "atacantes" son IPv6 de un mismo /64 con distinto sufijo: para el cupo en D1 son el
// MISMO origen (la IP se normaliza al prefijo /64), pero para el binding de Rate Limiting son claves
// distintas (`ip:email` con la IP tal cual). Así se prueba la segunda capa sin chocar con la primera.
import {
  MAX_INTENTOS_LOGIN,
  MAX_INTENTOS_LOGIN_GLOBAL,
  MENSAJES_ERROR,
  type ListaAuditoria,
  type RespuestaSesion,
  uuidv7,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { TIEMPO_MINIMO_LOGIN_FALLIDO_MS } from '../src/rutas/auth';
import { crearUsuarioConClave, peticion, refrescar, type UsuarioPrueba } from './auth-helpers';
import { api, sesion } from './fase2-helpers';
import { enVentanaDelLimitador } from './limitador-helpers';
import { pullTodo } from './fase3-helpers';

// Pruebas con PBKDF2 y muchas peticiones: con la máquina cargada superan el límite por defecto de
// 5 s. Mismo valor que las demás pruebas pesadas del worker; no cambia ninguna aserción.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CREDENCIALES_INVALIDAS = {
  status: 401,
  cuerpo: { code: 'CREDENCIALES_INVALIDAS', message: MENSAJES_ERROR.CREDENCIALES_INVALIDAS },
};

/** Prefijo IPv6 /64 nuevo: cada uno es un origen desconocido distinto para el cupo en D1. */
function prefijo64(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16);
  return `2001:db8:${h()}:${h()}`;
}

/** IP dentro de un /64 (sufijo 1..n): mismo origen en D1, otra clave en el limitador. */
function ipEn(prefijo: string, sufijo: number): string {
  return `${prefijo}::${sufijo.toString(16)}`;
}

function ipv4Aleatoria(): string {
  const o = () => Math.floor(Math.random() * 254) + 1;
  return `10.${String(o())}.${String(o())}.${String(o())}`;
}

interface OpcionesIntento {
  ip?: string;
  /** Valor crudo de la cabecera Cookie. */
  cookie?: string;
}

function intentar(email: string, password: string, opciones: OpcionesIntento = {}) {
  return peticion('/api/v1/auth/login', {
    body: { email, password, device_id: uuidv7() },
    ip: opciones.ip ?? ipv4Aleatoria(),
    headers: opciones.cookie === undefined ? {} : { Cookie: opciones.cookie },
  });
}

async function cuerpoYEstado(respuesta: Response) {
  return { status: respuesta.status, cuerpo: await respuesta.json() };
}

/** Valor de `mp_dispositivo` en los Set-Cookie de la respuesta, o null. */
function cookieDispositivo(respuesta: Response): { valor: string; atributos: string[] } | null {
  const cabecera = respuesta.headers
    .getSetCookie()
    .find((linea) => linea.startsWith('mp_dispositivo='));
  if (cabecera === undefined) {
    return null;
  }
  const [par = '', ...atributos] = cabecera.split(';').map((parte) => parte.trim());
  return { valor: par.slice('mp_dispositivo='.length), atributos };
}

/** Login correcto que devuelve la cookie del dispositivo conocido. */
async function loginConocido(u: UsuarioPrueba, ip = ipv4Aleatoria()): Promise<string> {
  const respuesta = await intentar(u.email, u.password, { ip });
  expect(respuesta.status, 'login inicial').toBe(200);
  const cookie = cookieDispositivo(respuesta);
  expect(cookie, 'mp_dispositivo').not.toBeNull();
  return cookie?.valor ?? '';
}

interface FilaCupo {
  origen: string;
  fallos: number;
  bloqueado_hasta: string | null;
}

async function cupos(userId: string): Promise<FilaCupo[]> {
  const { results } = await env.DB.prepare(
    'SELECT origen, fallos, bloqueado_hasta FROM login_cupos WHERE user_id = ? ORDER BY origen',
  )
    .bind(userId)
    .all<FilaCupo>();
  return results;
}

async function cupoGlobal(userId: string): Promise<FilaCupo | null> {
  return env.DB.prepare(
    `SELECT origen, fallos, bloqueado_hasta FROM login_cupos WHERE user_id = ? AND origen = 'g'`,
  )
    .bind(userId)
    .first<FilaCupo>();
}

async function auditoriaCupos(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT accion, actor_id, datos_despues FROM audit_log
     WHERE entidad = 'login_cupos' AND entidad_id = ? ORDER BY seq`,
  )
    .bind(userId)
    .all<{ accion: string; actor_id: string | null; datos_despues: string }>();
  return results.map((r) => ({
    accion: r.accion,
    actor_id: r.actor_id,
    datos: JSON.parse(r.datos_despues) as Record<string, unknown>,
  }));
}

/** Ejecuta las promesas por tandas (las 401 tardan ≥ 400 ms cada una). */
async function enTandas<T>(fabricas: (() => Promise<T>)[], tamano = 10): Promise<T[]> {
  const salida: T[] = [];
  for (let i = 0; i < fabricas.length; i += tamano) {
    salida.push(...(await Promise.all(fabricas.slice(i, i + tamano).map((f) => f()))));
  }
  return salida;
}

// ---------------------------------------------------------------------------------------------
// (a) El dispositivo conocido no se puede bloquear desde otros orígenes
// ---------------------------------------------------------------------------------------------

describe('M1 (a): dispositivo conocido', () => {
  it('tras 50 fallos desde orígenes desconocidos, el usuario legítimo entra desde su dispositivo conocido', async () => {
    const u = await crearUsuarioConClave('admin');
    const conocida = await loginConocido(u);
    const ipsAtacantes = Array.from({ length: 50 }, () => ipv4Aleatoria());

    const respuestas = await enTandas(
      ipsAtacantes.map(
        (ip, i) => async () => cuerpoYEstado(await intentar(u.email, `mala-${String(i)}`, { ip })),
      ),
    );
    for (const respuesta of respuestas) {
      expect(respuesta).toEqual(CREDENCIALES_INVALIDAS);
    }

    // Desde la MISMA IP que uno de los atacantes (NAT de planta), con su cookie: entra.
    const legitimo = await intentar(u.email, u.password, {
      ip: ipsAtacantes[0],
      cookie: `mp_dispositivo=${conocida}`,
    });
    expect(legitimo.status).toBe(200);

    // El tope global quedó agotado para los orígenes desconocidos.
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAX_INTENTOS_LOGIN_GLOBAL });
    expect((await cupoGlobal(u.id))?.bloqueado_hasta).not.toBeNull();
    // Sin la cookie, la contraseña correcta desde un origen nuevo ya no entra.
    expect(await cuerpoYEstado(await intentar(u.email, u.password))).toEqual(
      CREDENCIALES_INVALIDAS,
    );
  }, 60_000);

  it('con la IP agotada en el limitador (NAT compartido), el dispositivo conocido sigue entrando', async () => {
    // El limitador simulado cuenta por ventanas alineadas al reloj (N3, limitador-helpers.ts).
    await enVentanaDelLimitador();
    const u = await crearUsuarioConClave('jefe');
    const conocida = await loginConocido(u);
    const ipPlanta = ipv4Aleatoria();
    const estados: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      estados.push((await intentar(u.email, `mala-${String(i)}`, { ip: ipPlanta })).status);
    }
    expect(estados).toEqual([401, 401, 401, 401, 401, 429]);
    const legitimo = await intentar(u.email, u.password, {
      ip: ipPlanta,
      cookie: `mp_dispositivo=${conocida}`,
    });
    expect(legitimo.status).toBe(200);
  }, 20_000);

  it('el cupo del dispositivo es propio: 5 fallos con su cookie lo bloquean solo a él', async () => {
    const u = await crearUsuarioConClave();
    const conocida = await loginConocido(u);
    const ip = ipv4Aleatoria();
    // 6 intentos desde la misma IP y con la cookie: el limitador no aplica (el 6.º no es 429).
    for (let i = 0; i < MAX_INTENTOS_LOGIN; i += 1) {
      expect(
        await cuerpoYEstado(
          await intentar(u.email, `mala-${String(i)}`, {
            ip,
            cookie: `mp_dispositivo=${conocida}`,
          }),
        ),
      ).toEqual(CREDENCIALES_INVALIDAS);
    }
    const bloqueada = await intentar(u.email, u.password, {
      ip,
      cookie: `mp_dispositivo=${conocida}`,
    });
    expect(await cuerpoYEstado(bloqueada)).toEqual(CREDENCIALES_INVALIDAS);
    expect(cookieDispositivo(bloqueada)).toBeNull();

    // Sin la cookie, desde otro origen, la cuenta no está bloqueada.
    expect((await intentar(u.email, u.password)).status).toBe(200);

    const auditoria = await auditoriaCupos(u.id);
    expect(auditoria).toEqual([
      {
        accion: 'login_cupos.bloqueado',
        actor_id: null,
        datos: {
          user_id: u.id,
          tipo: 'dispositivo',
          fallos: MAX_INTENTOS_LOGIN,
          bloqueado_hasta: expect.any(String) as string,
        },
      },
    ]);
  });

  it('el login correcto entrega mp_dispositivo con todos sus atributos', async () => {
    const u = await crearUsuarioConClave();
    const respuesta = await intentar(u.email, u.password);
    expect(respuesta.status).toBe(200);
    const cookie = cookieDispositivo(respuesta);
    expect(cookie?.valor).toMatch(/^v1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(cookie?.valor.split('.')[1]).toBe(u.id);
    expect(cookie?.atributos).toEqual(
      expect.arrayContaining([
        'Max-Age=34560000',
        'Path=/api/v1/auth',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
      ]),
    );
  });

  it('logout y refresh no borran mp_dispositivo (el refresh exitoso la renueva, A8)', async () => {
    const u = await crearUsuarioConClave();
    const login = await intentar(u.email, u.password);
    const refresh = /mp_refresh=([^;]+)/.exec(login.headers.getSetCookie().join('\n'))?.[1] ?? '';
    const cuerpo = await login.json<RespuestaSesion>();

    // A8 (ADR 0018, enmienda 2): el refresh exitoso pone una entrada válida de su usuario, nunca
    // la borra (cubierto en detalle por correcciones-a8-refresh-cookie-dispositivo.test.ts).
    const rotado = await refrescar(refresh);
    expect(rotado.status).toBe(200);
    expect(cookieDispositivo(rotado)?.valor.split('.')[1]).toBe(u.id);
    expect(cookieDispositivo(rotado)?.atributos).not.toContain('Max-Age=0');

    // Un refresh inválido borra mp_refresh, pero no mp_dispositivo.
    const invalido = await refrescar('no-existe');
    expect(invalido.status).toBe(401);
    expect(invalido.headers.getSetCookie().some((l) => l.startsWith('mp_refresh='))).toBe(true);
    expect(cookieDispositivo(invalido)).toBeNull();

    const salida = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      token: cuerpo.access_token,
    });
    expect(salida.status).toBe(204);
    expect(cookieDispositivo(salida)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// (b) Las adivinanzas desde orígenes desconocidos quedan acotadas
// ---------------------------------------------------------------------------------------------

describe('M1 (b): origen desconocido', () => {
  it('el 6.º intento en 15 min desde un origen se rechaza aunque la contraseña sea correcta; otro origen sí entra', async () => {
    const u = await crearUsuarioConClave();
    const red = prefijo64();
    for (let i = 1; i <= MAX_INTENTOS_LOGIN; i += 1) {
      expect(
        await cuerpoYEstado(await intentar(u.email, `mala-${String(i)}`, { ip: ipEn(red, i) })),
      ).toEqual(CREDENCIALES_INVALIDAS);
    }
    const inicio = Date.now();
    const sexto = await intentar(u.email, u.password, { ip: ipEn(red, 6) });
    expect(await cuerpoYEstado(sexto)).toEqual(CREDENCIALES_INVALIDAS);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(TIEMPO_MINIMO_LOGIN_FALLIDO_MS);

    // Otro origen no está bloqueado: la cuenta no tiene bloqueo duro.
    expect((await intentar(u.email, u.password, { ip: ipv4Aleatoria() })).status).toBe(200);
    // Las columnas de la v1 ya no bloquean ni cuentan.
    const usuario = await env.DB.prepare(
      'SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(u.id)
      .first();
    expect(usuario).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });

    const auditoria = await auditoriaCupos(u.id);
    expect(auditoria).toEqual([
      {
        accion: 'login_cupos.bloqueado',
        actor_id: null,
        datos: {
          user_id: u.id,
          tipo: 'origen',
          fallos: MAX_INTENTOS_LOGIN,
          bloqueado_hasta: expect.any(String) as string,
        },
      },
    ]);
    // Ni la IP ni su HMAC llegan a la auditoría.
    const texto = JSON.stringify(auditoria);
    expect(texto).not.toContain(red);
    expect(texto).not.toContain('ip:');
  });

  it('una IPv4 mapeada en IPv6 es el mismo origen que la IPv4', async () => {
    const u = await crearUsuarioConClave();
    const ip = ipv4Aleatoria();
    await intentar(u.email, 'mala-1', { ip });
    await intentar(u.email, 'mala-2', { ip: `::ffff:${ip}` });
    const filas = (await cupos(u.id)).filter((c) => c.origen.startsWith('ip:'));
    expect(filas).toHaveLength(1);
    expect(filas[0]?.fallos).toBe(2);
  });

  it(`tope global de ${String(MAX_INTENTOS_LOGIN_GLOBAL)} fallos entre todos los orígenes desconocidos`, async () => {
    const u = await crearUsuarioConClave();
    const redes = Array.from({ length: MAX_INTENTOS_LOGIN_GLOBAL / MAX_INTENTOS_LOGIN }, prefijo64);
    await enTandas(
      redes.flatMap((red) =>
        Array.from(
          { length: MAX_INTENTOS_LOGIN },
          (_, i) => () => intentar(u.email, `mala-${String(i)}`, { ip: ipEn(red, i + 1) }),
        ),
      ),
    );
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAX_INTENTOS_LOGIN_GLOBAL });

    // El 21.º, desde un origen nuevo y con la contraseña correcta: rechazado, con el mismo mensaje.
    expect(await cuerpoYEstado(await intentar(u.email, u.password))).toEqual(
      CREDENCIALES_INVALIDAS,
    );
    // Sin cupo global no se crean filas de IP nuevas.
    await Promise.all([intentar(u.email, 'x'), intentar(u.email, 'y'), intentar(u.email, 'z')]);
    expect((await cupos(u.id)).filter((c) => c.origen.startsWith('ip:'))).toHaveLength(
      redes.length,
    );
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAX_INTENTOS_LOGIN_GLOBAL });
    const acciones = (await auditoriaCupos(u.id)).map((a) => `${a.accion}:${String(a.datos.tipo)}`);
    expect(acciones.filter((a) => a === 'login_cupos.bloqueado:global')).toHaveLength(1);
    expect(acciones.filter((a) => a === 'login_cupos.bloqueado:origen')).toHaveLength(redes.length);
  }, 30_000);

  it('una IP bloqueada no consume el cupo global', async () => {
    const u = await crearUsuarioConClave();
    const red = prefijo64();
    for (let i = 1; i <= 2 * MAX_INTENTOS_LOGIN; i += 1) {
      await intentar(u.email, `mala-${String(i)}`, { ip: ipEn(red, i) });
    }
    expect(await cupoGlobal(u.id)).toMatchObject({
      fallos: MAX_INTENTOS_LOGIN,
      bloqueado_hasta: null,
    });
  });

  it('un login correcto reinicia el cupo de su origen, pero no el global', async () => {
    const u = await crearUsuarioConClave();
    const ip = ipv4Aleatoria();
    for (let i = 1; i <= 3; i += 1) {
      await intentar(u.email, `mala-${String(i)}`, { ip });
    }
    expect((await intentar(u.email, u.password, { ip })).status).toBe(200);
    const filas = await cupos(u.id);
    expect(filas.find((c) => c.origen.startsWith('ip:'))).toMatchObject({
      fallos: 0,
      bloqueado_hasta: null,
    });
    // Los 3 fallos siguen contando en `g` (el login correcto no lo reinicia).
    expect(filas.find((c) => c.origen === 'g')).toMatchObject({ fallos: 3 });
  });

  it('reserva atómica: 10 intentos simultáneos desde un origen nunca pasan del límite', async () => {
    const u = await crearUsuarioConClave();
    const red = prefijo64();
    const respuestas = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        intentar(u.email, `mala-${String(i)}`, { ip: ipEn(red, i + 1) }),
      ),
    );
    expect(respuestas.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => 401));
    const filas = await cupos(u.id);
    expect(filas.find((c) => c.origen.startsWith('ip:'))?.fallos).toBe(MAX_INTENTOS_LOGIN);
    expect(filas.find((c) => c.origen === 'g')?.fallos).toBe(MAX_INTENTOS_LOGIN);
    expect((await auditoriaCupos(u.id)).map((a) => a.accion)).toEqual(['login_cupos.bloqueado']);
  });

  it('reserva atómica: 30 intentos simultáneos desde orígenes distintos dejan el global en 20', async () => {
    const u = await crearUsuarioConClave();
    const respuestas = await Promise.all(
      Array.from({ length: 30 }, (_, i) => intentar(u.email, `mala-${String(i)}`)),
    );
    expect(respuestas.every((r) => r.status === 401)).toBe(true);
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAX_INTENTOS_LOGIN_GLOBAL });
    expect((await cupos(u.id)).filter((c) => c.origen.startsWith('ip:'))).toHaveLength(
      MAX_INTENTOS_LOGIN_GLOBAL,
    );
    expect((await auditoriaCupos(u.id)).map((a) => a.datos.tipo)).toEqual(['global']);
  });

  it('ventana fija: vencidos la ventana y el bloqueo, el siguiente fallo vuelve a contar 1', async () => {
    const u = await crearUsuarioConClave();
    const ip = ipv4Aleatoria();
    await intentar(u.email, 'mala', { ip });
    const viejo = new Date(Date.now() - 16 * 60_000).toISOString();
    await env.DB.prepare(
      `UPDATE login_cupos SET fallos = 5, ventana_inicio = ?, bloqueado_hasta = ? WHERE user_id = ?`,
    )
      .bind(viejo, new Date(Date.now() - 60_000).toISOString(), u.id)
      .run();
    await intentar(u.email, 'mala-otra-vez', { ip });
    for (const fila of await cupos(u.id)) {
      expect(fila).toMatchObject({ fallos: 1, bloqueado_hasta: null });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// (d) Mensaje uniforme y piso de tiempo
// ---------------------------------------------------------------------------------------------

describe('M1 (d): respuesta uniforme', () => {
  it('inexistente, bloqueado por cupo, inactivo y contraseña errónea: mismo 401, ≥ piso y sin Set-Cookie', async () => {
    const u = await crearUsuarioConClave();
    const inactivo = await crearUsuarioConClave('supervisor', { activo: 0 });
    const bloqueado = await crearUsuarioConClave();
    const red = prefijo64();
    for (let i = 1; i <= MAX_INTENTOS_LOGIN; i += 1) {
      await intentar(bloqueado.email, 'mala', { ip: ipEn(red, i) });
    }
    const casos = [
      () => intentar(`nadie-${uuidv7()}@catmetal.test`, 'cualquier-clave'),
      () => intentar(u.email, 'cualquier-clave'),
      () => intentar(inactivo.email, inactivo.password),
      () => intentar(bloqueado.email, bloqueado.password, { ip: ipEn(red, 99) }),
    ];
    for (const caso of casos) {
      const inicio = Date.now();
      const respuesta = await caso();
      expect(Date.now() - inicio).toBeGreaterThanOrEqual(TIEMPO_MINIMO_LOGIN_FALLIDO_MS);
      expect(respuesta.headers.getSetCookie()).toEqual([]);
      expect(await cuerpoYEstado(respuesta)).toEqual(CREDENCIALES_INVALIDAS);
    }
  });

  it('una cuenta inactiva no crea cupos', async () => {
    const inactivo = await crearUsuarioConClave('supervisor', { activo: 0 });
    await intentar(inactivo.email, 'mala');
    expect(await cupos(inactivo.id)).toEqual([]);
  });

  it('un bloqueo heredado de la v1 en users ya no impide el login, y el login lo limpia', async () => {
    const u = await crearUsuarioConClave();
    await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
      .bind(new Date(Date.now() + 600_000).toISOString(), u.id)
      .run();
    expect((await intentar(u.email, u.password)).status).toBe(200);
    const fila = await env.DB.prepare(
      'SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(u.id)
      .first();
    expect(fila).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
  });
});

// ---------------------------------------------------------------------------------------------
// Auditoría de login_cupos: nunca viaja a las tablets ni la ve quien no es admin
// ---------------------------------------------------------------------------------------------

describe('M1: auditoría de login_cupos', () => {
  it('no llega por /sync/pull y solo la ve el admin en /audit', async () => {
    const jefe = await sesion('jefe');
    const supervisor = await sesion('supervisor');
    const admin = await sesion('admin');
    const victima = await crearUsuarioConClave('jefe');
    const red = prefijo64();
    for (let i = 1; i <= MAX_INTENTOS_LOGIN; i += 1) {
      await intentar(victima.email, 'mala', { ip: ipEn(red, i) });
    }
    expect((await auditoriaCupos(victima.id)).length).toBeGreaterThan(0);

    for (const quien of [jefe, supervisor, admin]) {
      const { cambios } = await pullTodo(quien.token, 0);
      expect(cambios.filter((c) => c.entidad === ('login_cupos' as string))).toEqual([]);
    }
    for (const quien of [jefe, supervisor]) {
      const respuesta = await api('/audit?limite=200', { token: quien.token });
      expect(respuesta.status).toBe(200);
      const lista = await respuesta.json<ListaAuditoria>();
      expect(lista.entradas.filter((e) => e.entidad === 'login_cupos')).toEqual([]);
    }
    const respuesta = await api('/audit?limite=200', { token: admin.token });
    const lista = await respuesta.json<ListaAuditoria>();
    expect(
      lista.entradas.some((e) => e.entidad === 'login_cupos' && e.entidad_id === victima.id),
    ).toBe(true);
  }, 30_000);

  it('N3: el admin filtra /audit por entidad=login_cupos; el jefe recibe 200 sin filas', async () => {
    const jefe = await sesion('jefe');
    const admin = await sesion('admin');
    const victima = await crearUsuarioConClave('jefe');
    const red = prefijo64();
    for (let i = 1; i <= MAX_INTENTOS_LOGIN; i += 1) {
      await intentar(victima.email, 'mala', { ip: ipEn(red, i) });
    }
    const delAdmin = await api('/audit?entidad=login_cupos&limite=200', { token: admin.token });
    expect(delAdmin.status).toBe(200);
    const lista = await delAdmin.json<ListaAuditoria>();
    expect(lista.entradas.length).toBeGreaterThan(0);
    expect(lista.entradas.every((e) => e.entidad === 'login_cupos')).toBe(true);
    expect(lista.entradas.some((e) => e.entidad_id === victima.id)).toBe(true);

    const delJefe = await api('/audit?entidad=login_cupos&limite=200', { token: jefe.token });
    expect(delJefe.status).toBe(200);
    expect((await delJefe.json<ListaAuditoria>()).entradas).toEqual([]);
  }, 30_000);

  it('el desbloqueo del admin reinicia todos los cupos del usuario, con auditoría', async () => {
    const admin = await sesion('admin');
    const u = await crearUsuarioConClave();
    const conocida = await loginConocido(u);
    for (let i = 0; i < MAX_INTENTOS_LOGIN; i += 1) {
      await intentar(u.email, 'mala', { cookie: `mp_dispositivo=${conocida}` });
    }
    const red = prefijo64();
    for (let i = 1; i <= MAX_INTENTOS_LOGIN; i += 1) {
      await intentar(u.email, 'mala', { ip: ipEn(red, i) });
    }
    expect((await cupos(u.id)).filter((c) => c.bloqueado_hasta !== null)).toHaveLength(2);

    const respuesta = await api(`/users/${u.id}`, {
      method: 'PATCH',
      token: admin.token,
      body: { desbloquear: true },
    });
    expect(respuesta.status).toBe(200);
    for (const fila of await cupos(u.id)) {
      expect(fila).toMatchObject({ fallos: 0, bloqueado_hasta: null });
    }
    const desbloqueos = (await auditoriaCupos(u.id)).filter(
      (a) => a.accion === 'login_cupos.desbloqueado',
    );
    expect(desbloqueos.map((a) => a.datos.tipo).sort()).toEqual(['dispositivo', 'origen']);
    expect(desbloqueos.every((a) => a.actor_id === admin.usuario.id)).toBe(true);

    // Ya puede entrar desde el dispositivo y desde el origen que estaban bloqueados.
    expect(
      (await intentar(u.email, u.password, { cookie: `mp_dispositivo=${conocida}` })).status,
    ).toBe(200);
    expect((await intentar(u.email, u.password, { ip: ipEn(red, 77) })).status).toBe(200);
  }, 30_000);
});

// POST /api/v1/auth/login: credenciales, bloqueo, rate limiting, dispositivos y cookie (ADR 0008).
import { BLOQUEO_MINUTOS, MENSAJES_ERROR, permisosDeRol, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { verificarAccessToken } from '../src/auth/tokens';
import {
  cookieRefresh,
  crearUsuarioConClave,
  esperarAuditoriaSinSecretos,
  iniciarSesion,
  perfil,
  peticion,
  type UsuarioPrueba,
} from './auth-helpers';

const contrasenasUsadas: string[] = [];
const tokensUsados: string[] = [];

async function usuario(rol: UsuarioPrueba['rol'] = 'supervisor', extra = {}) {
  const u = await crearUsuarioConClave(rol, extra);
  contrasenasUsadas.push(u.password);
  return u;
}

function intentar(email: string, password: string, ip = `ip-${crypto.randomUUID()}`) {
  return peticion('/api/v1/auth/login', {
    body: { email, password, device_id: uuidv7() },
    ip,
  });
}

async function cuerpoYEstado(respuesta: Response) {
  return { status: respuesta.status, cuerpo: await respuesta.json() };
}

const CREDENCIALES_INVALIDAS = {
  status: 401,
  cuerpo: { code: 'CREDENCIALES_INVALIDAS', message: MENSAJES_ERROR.CREDENCIALES_INVALIDAS },
};

describe('login correcto', () => {
  it('responde access token, perfil con permisos, device_id y la cookie con todos sus atributos', async () => {
    const u = await usuario('jefe');
    const sesion = await iniciarSesion(u);
    tokensUsados.push(sesion.refresh, sesion.cuerpo.access_token);

    expect(sesion.cuerpo.expira_en).toBe(900);
    expect(sesion.cuerpo.usuario).toEqual({
      id: u.id,
      nombre: 'Persona jefe',
      email: u.email,
      rol: 'jefe',
      permisos: permisosDeRol('jefe'),
    });
    const claims = await verificarAccessToken(env.JWT_SECRET, sesion.cuerpo.access_token);
    expect(claims?.sub).toBe(u.id);
    expect(claims?.did).toBe(sesion.deviceId);

    const cookie = cookieRefresh(sesion.respuesta);
    expect(cookie?.valor).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie?.atributos).toEqual(
      expect.arrayContaining([
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
        'Path=/api/v1/auth',
        'Max-Age=2592000',
      ]),
    );
    expect(sesion.respuesta.headers.get('Cache-Control')).toBe('no-store');

    const me = await perfil(sesion.cuerpo.access_token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual(sesion.cuerpo.usuario);
  });

  it('acepta el correo con mayúsculas y espacios (se normaliza)', async () => {
    const u = await usuario();
    await iniciarSesion({ email: `  ${u.email.toUpperCase()} `, password: u.password });
  });

  it('registra el dispositivo con instalacion_id, nombre y user_agent, y audita sesion.inicio', async () => {
    const u = await usuario();
    const instalacion = uuidv7();
    const sesion = await iniciarSesion(u, { instalacionId: instalacion });
    const dispositivo = await env.DB.prepare(
      'SELECT user_id, instalacion_id, nombre, user_agent FROM devices WHERE id = ?',
    )
      .bind(sesion.deviceId)
      .first();
    expect(dispositivo).toEqual({
      user_id: u.id,
      instalacion_id: instalacion,
      nombre: 'Tablet de planta',
      user_agent: 'Prueba/1.0',
    });
    const { results } = await env.DB.prepare(
      `SELECT accion, entidad FROM audit_log WHERE actor_id = ? ORDER BY seq`,
    )
      .bind(u.id)
      .all();
    expect(results).toEqual([
      { accion: 'dispositivo.registro', entidad: 'devices' },
      { accion: 'sesion.inicio', entidad: 'refresh_tokens' },
    ]);
  });

  it('si el device_id propuesto pertenece a otro usuario, asigna uno nuevo', async () => {
    const a = await usuario();
    const b = await usuario();
    const sesionA = await iniciarSesion(a);
    const sesionB = await iniciarSesion(b, { deviceId: sesionA.deviceId });
    expect(sesionB.deviceId).not.toBe(sesionA.deviceId);
    const fila = await env.DB.prepare('SELECT user_id FROM devices WHERE id = ?')
      .bind(sesionB.deviceId)
      .first();
    expect(fila).toEqual({ user_id: b.id });
    // La sesión de A sigue viva.
    expect((await perfil(sesionA.cuerpo.access_token)).status).toBe(200);
  });

  it('un nuevo login en el mismo dispositivo revoca la familia anterior', async () => {
    const u = await usuario();
    const primera = await iniciarSesion(u);
    const segunda = await iniciarSesion(u, { deviceId: primera.deviceId });
    expect(segunda.deviceId).toBe(primera.deviceId);
    expect((await perfil(primera.cuerpo.access_token)).status).toBe(401);
    expect((await perfil(segunda.cuerpo.access_token)).status).toBe(200);
  });
});

describe('credenciales inválidas', () => {
  it('usuario inexistente y contraseña incorrecta responden exactamente lo mismo', async () => {
    const u = await usuario();
    const malaClave = await cuerpoYEstado(await intentar(u.email, 'otra-clave-cualquiera'));
    const inexistente = await cuerpoYEstado(
      await intentar(`nadie-${uuidv7()}@catmetal.test`, 'otra-clave-cualquiera'),
    );
    expect(malaClave).toEqual(CREDENCIALES_INVALIDAS);
    expect(inexistente).toEqual(malaClave);
  });

  it('un usuario inactivo recibe la misma respuesta aun con la contraseña correcta', async () => {
    const u = await usuario('supervisor', { activo: 0 });
    expect(await cuerpoYEstado(await intentar(u.email, u.password))).toEqual(
      CREDENCIALES_INVALIDAS,
    );
  });

  it('no se audita el correo de intentos sobre cuentas inexistentes', async () => {
    const email = `fantasma-${uuidv7()}@catmetal.test`;
    await intentar(email, 'x');
    const fila = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE instr(COALESCE(datos_despues, ''), ?) > 0 OR instr(COALESCE(datos_antes, ''), ?) > 0`,
    )
      .bind(email, email)
      .first<{ n: number }>();
    expect(fila?.n).toBe(0);
  });

  it('un cuerpo inválido responde 400 VALIDACION', async () => {
    const respuesta = await peticion('/api/v1/auth/login', {
      body: { email: 'no-es-correo', password: '', device_id: 'x' },
    });
    expect(respuesta.status).toBe(400);
    expect(await respuesta.json()).toMatchObject({ code: 'VALIDACION' });
  });
});

describe('bloqueo de cuenta (5 intentos, 15 min)', () => {
  it('tras 5 fallos bloquea, audita, y responde idéntico aun con la contraseña correcta', async () => {
    const u = await usuario();
    for (let i = 1; i <= 4; i += 1) {
      expect(await cuerpoYEstado(await intentar(u.email, `mala-${String(i)}`))).toEqual(
        CREDENCIALES_INVALIDAS,
      );
    }
    const antes = await env.DB.prepare(
      'SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(u.id)
      .first();
    expect(antes).toEqual({ intentos_fallidos: 4, bloqueado_hasta: null });

    expect(await cuerpoYEstado(await intentar(u.email, 'mala-5'))).toEqual(CREDENCIALES_INVALIDAS);
    const bloqueado = await env.DB.prepare(
      'SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(u.id)
      .first<{ intentos_fallidos: number; bloqueado_hasta: string }>();
    expect(bloqueado?.intentos_fallidos).toBe(5);
    const minutos = (Date.parse(bloqueado?.bloqueado_hasta ?? '') - Date.now()) / 60_000;
    expect(minutos).toBeGreaterThan(BLOQUEO_MINUTOS - 1);
    expect(minutos).toBeLessThanOrEqual(BLOQUEO_MINUTOS);

    const auditoria = await env.DB.prepare(
      `SELECT accion, actor_id FROM audit_log WHERE entidad = 'users' AND entidad_id = ?`,
    )
      .bind(u.id)
      .all();
    expect(auditoria.results).toEqual([{ accion: 'usuario.bloqueado', actor_id: null }]);

    // Durante el bloqueo: misma respuesta con la contraseña correcta, y el contador no cambia.
    expect(await cuerpoYEstado(await intentar(u.email, u.password))).toEqual(
      CREDENCIALES_INVALIDAS,
    );
    expect(await cuerpoYEstado(await intentar(u.email, 'mala-6'))).toEqual(CREDENCIALES_INVALIDAS);
    const durante = await env.DB.prepare('SELECT intentos_fallidos FROM users WHERE id = ?')
      .bind(u.id)
      .first();
    expect(durante).toEqual({ intentos_fallidos: 5 });
  });

  it('al vencer el bloqueo, la contraseña correcta entra y reinicia el contador', async () => {
    const u = await usuario();
    const vencido = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
      .bind(vencido, u.id)
      .run();
    await iniciarSesion(u, { ip: `ip-${crypto.randomUUID()}` });
    const fila = await env.DB.prepare(
      'SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(u.id)
      .first();
    expect(fila).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
  });

  it('al vencer el bloqueo, un fallo reinicia el contador a 1 (no vuelve a bloquear)', async () => {
    const u = await usuario();
    await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), u.id)
      .run();
    await intentar(u.email, 'mala');
    const fila = await env.DB.prepare(
      'SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(u.id)
      .first();
    expect(fila).toEqual({ intentos_fallidos: 1, bloqueado_hasta: null });
  });

  it('un login correcto reinicia los intentos fallidos previos', async () => {
    const u = await usuario();
    await intentar(u.email, 'mala-1');
    await intentar(u.email, 'mala-2');
    await iniciarSesion(u);
    const fila = await env.DB.prepare('SELECT intentos_fallidos FROM users WHERE id = ?')
      .bind(u.id)
      .first();
    expect(fila).toEqual({ intentos_fallidos: 0 });
  });
});

describe('rate limiting (IP + email, 5 por 60 s)', () => {
  it('la sexta petición con la misma IP y correo responde 429 DEMASIADOS_INTENTOS', async () => {
    // El limitador simulado de Miniflare cuenta por ventanas alineadas al minuto del reloj de pared
    // (docs/notas-plataforma.md). Las 7 peticiones tardan unos 3 s (cada 401 espera 400 ms, H-02):
    // si quedan menos de 10 s del minuto actual, se espera al siguiente para que todas caigan en la
    // misma ventana. Antes la prueba fallaba de forma intermitente al cruzar el cambio de minuto.
    const restanteMs = 60_000 - (Date.now() % 60_000);
    if (restanteMs < 10_000) {
      await new Promise((resolver) => setTimeout(resolver, restanteMs + 200));
    }
    const email = `limite-${uuidv7()}@catmetal.test`;
    const ip = `ip-${crypto.randomUUID()}`;
    const estados: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      estados.push((await intentar(email, 'x', ip)).status);
    }
    expect(estados).toEqual([401, 401, 401, 401, 401, 429]);
    const ultima = await intentar(email, 'x', ip);
    expect(await ultima.json()).toEqual({
      code: 'DEMASIADOS_INTENTOS',
      message: MENSAJES_ERROR.DEMASIADOS_INTENTOS,
    });
    // Otra IP con el mismo correo no está limitada por esa clave.
    expect((await intentar(email, 'x')).status).toBe(401);
    // Tiempo máximo propio: la espera al minuto siguiente puede durar hasta ~10 s.
  }, 20_000);

  it('sin cf-connecting-ip usa la clave "local"', async () => {
    const email = `local-${uuidv7()}@catmetal.test`;
    const estados: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const respuesta = await peticion('/api/v1/auth/login', {
        body: { email, password: 'x', device_id: uuidv7() },
      });
      estados.push(respuesta.status);
    }
    expect(estados.at(-1)).toBe(429);
  });
});

describe('auditoría de login', () => {
  it('no contiene contraseñas, hashes, tokens ni secretos', async () => {
    await esperarAuditoriaSinSecretos([...contrasenasUsadas, ...tokensUsados]);
  });
});

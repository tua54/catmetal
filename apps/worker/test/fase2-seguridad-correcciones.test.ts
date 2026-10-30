// Correcciones de la revisión de seguridad de la Fase 2 (docs/auditoria/seguridad-fase-2.md,
// tarea 2.8): H-01, H-02, H-03, H-04, H-05, H-07, H-10, H-11 y H-12. H-06 está en
// auth-middleware.test.ts. D1, R2 y Rate Limiting son los locales reales (sin mocks).
import {
  type ListaAuditoria,
  MAX_EVIDENCIA_BYTES,
  MAX_INTENTOS_LOGIN,
  MENSAJES_ERROR,
  type Usuario,
  uuidv7,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { sha256Hex } from '../src/dominio/evidencias';
import { LIMITE_CUERPO_BYTES } from '../src/middleware/limite-cuerpo';
import { diagnosticarSecretos, LONGITUD_MINIMA_SECRETO } from '../src/middleware/secretos';
import { TIEMPO_MINIMO_LOGIN_FALLIDO_MS } from '../src/rutas/auth';
import { borrarObjetoHuerfano } from '../src/rutas/evidencias';
import {
  BASE,
  crearUsuarioConClave,
  iniciarSesion,
  ORIGEN,
  perfil,
  peticion,
  refrescar,
  type UsuarioPrueba,
} from './auth-helpers';
import {
  archivo,
  cuerpoConsumo,
  cuerpoNovedad,
  escenarioOrden,
  jpeg,
  novedadOk,
  registrarOk,
  subir,
} from './fase2-consumos-helpers';
import { api, esperarError, sesion, type SesionDeRol } from './fase2-helpers';

function intentar(email: string, password: string, ip = `ip-${crypto.randomUUID()}`) {
  return peticion('/api/v1/auth/login', {
    body: { email, password, device_id: uuidv7() },
    ip,
  });
}

async function estadoBloqueo(id: string) {
  return env.DB.prepare('SELECT intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?')
    .bind(id)
    .first<{ intentos_fallidos: number; bloqueado_hasta: string | null }>();
}

async function accionesDeUsuario(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT accion FROM audit_log WHERE entidad = 'users' AND entidad_id = ? ORDER BY seq`,
  )
    .bind(id)
    .all<{ accion: string }>();
  return results.map((r) => r.accion);
}

// ---------------------------------------------------------------------------------------------
// H-01: reserva atómica del intento antes del PBKDF2
// ---------------------------------------------------------------------------------------------

describe('H-01: intentos de login concurrentes', () => {
  it('20 intentos incorrectos simultáneos (IP distintas) dejan exactamente 5 y la cuenta bloqueada', async () => {
    const u = await crearUsuarioConClave();
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, (_, i) => intentar(u.email, `mala-${String(i)}`)),
    );
    expect(respuestas.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 401));
    const fila = await estadoBloqueo(u.id);
    expect(fila?.intentos_fallidos).toBe(MAX_INTENTOS_LOGIN);
    expect(fila?.bloqueado_hasta).not.toBeNull();
    expect(Date.parse(fila?.bloqueado_hasta ?? '')).toBeGreaterThan(Date.now());
    // Un único evento de bloqueo, aunque varios intentos calculen el mismo milisegundo.
    expect(await accionesDeUsuario(u.id)).toEqual(['usuario.bloqueado']);
    // Bloqueada: la contraseña correcta tampoco entra, y el contador no se mueve.
    expect((await intentar(u.email, u.password)).status).toBe(401);
    expect((await estadoBloqueo(u.id))?.intentos_fallidos).toBe(MAX_INTENTOS_LOGIN);
  });

  it('8 logins concurrentes con la contraseña correcta dejan la cuenta desbloqueada y en 0', async () => {
    const u = await crearUsuarioConClave();
    const respuestas = await Promise.all(
      Array.from({ length: 8 }, () => intentar(u.email, u.password)),
    );
    // Si 5 reservas coinciden en vuelo, la quinta bloquea y las siguientes reciben 401; cada login
    // que reservó y verificó reinicia el contador, así que al final la cuenta queda en 0.
    expect(respuestas.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    expect(await estadoBloqueo(u.id)).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
  });

  it('un login correcto tras fallos reinicia el contador', async () => {
    const u = await crearUsuarioConClave();
    await Promise.all([intentar(u.email, 'mala-1'), intentar(u.email, 'mala-2')]);
    expect((await estadoBloqueo(u.id))?.intentos_fallidos).toBe(2);
    await iniciarSesion(u, { ip: `ip-${crypto.randomUUID()}` });
    expect(await estadoBloqueo(u.id)).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
    // Sin bloqueo previo no hay evento de desbloqueo.
    expect(await accionesDeUsuario(u.id)).toEqual([]);
  });

  it('la contraseña correcta en el quinto intento entra: la reserva bloqueó y el login lo deshace (auditado)', async () => {
    const u = await crearUsuarioConClave();
    for (let i = 1; i < MAX_INTENTOS_LOGIN; i += 1) {
      expect((await intentar(u.email, `mala-${String(i)}`)).status).toBe(401);
    }
    const sesionIniciada = await iniciarSesion(u, { ip: `ip-${crypto.randomUUID()}` });
    expect((await perfil(sesionIniciada.cuerpo.access_token)).status).toBe(200);
    expect(await estadoBloqueo(u.id)).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
    expect(await accionesDeUsuario(u.id)).toEqual(['usuario.bloqueado', 'usuario.desbloqueado']);
    const desbloqueo = await env.DB.prepare(
      `SELECT actor_id, datos_despues FROM audit_log
       WHERE entidad = 'users' AND entidad_id = ? AND accion = 'usuario.desbloqueado'`,
    )
      .bind(u.id)
      .first<{ actor_id: string; datos_despues: string }>();
    expect(desbloqueo?.actor_id).toBe(u.id);
    expect(JSON.parse(desbloqueo?.datos_despues ?? '{}')).toEqual({
      id: u.id,
      intentos_fallidos: 0,
      bloqueado_hasta: null,
    });
  });

  it('una cuenta inactiva no reserva intentos (el contador no cambia)', async () => {
    const u = await crearUsuarioConClave('supervisor', { activo: 0 });
    await Promise.all([intentar(u.email, 'mala'), intentar(u.email, u.password)]);
    expect(await estadoBloqueo(u.id)).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
  });
});

// ---------------------------------------------------------------------------------------------
// H-02: tiempo mínimo uniforme en las 401 del login
// ---------------------------------------------------------------------------------------------

describe('H-02: tiempo mínimo de las respuestas 401 del login', () => {
  async function duracion(respuestaPromesa: () => Promise<Response>) {
    const inicio = Date.now();
    const respuesta = await respuestaPromesa();
    const ms = Date.now() - inicio;
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'CREDENCIALES_INVALIDAS' });
    return ms;
  }

  it('cuenta inexistente, contraseña mala, cuenta inactiva y cuenta bloqueada tardan ≥ el mínimo', async () => {
    const u = await crearUsuarioConClave();
    const inactivo = await crearUsuarioConClave('supervisor', { activo: 0 });
    const bloqueado = await crearUsuarioConClave();
    await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
      .bind(new Date(Date.now() + 600_000).toISOString(), bloqueado.id)
      .run();
    const casos = [
      () => intentar(`nadie-${uuidv7()}@catmetal.test`, 'cualquier-clave'),
      () => intentar(u.email, 'cualquier-clave'),
      () => intentar(inactivo.email, inactivo.password),
      () => intentar(bloqueado.email, bloqueado.password),
    ];
    for (const caso of casos) {
      expect(await duracion(caso)).toBeGreaterThanOrEqual(TIEMPO_MINIMO_LOGIN_FALLIDO_MS);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// H-03: PATCH /users/:id parcial y con guarda
// ---------------------------------------------------------------------------------------------

describe('H-03: edición concurrente de usuarios', () => {
  let admin: SesionDeRol;
  beforeAll(async () => {
    admin = await sesion('admin');
  });

  function editarUsuario(id: string, cuerpo: Record<string, unknown>) {
    return api(`/users/${id}`, { method: 'PATCH', token: admin.token, body: cuerpo });
  }

  /** Reintenta una vez si responde 409 CONFLICTO (lo que haría la PWA tras releer). */
  async function editarConReintento(id: string, cuerpo: Record<string, unknown>) {
    const primera = await editarUsuario(id, cuerpo);
    if (primera.status !== 409) {
      return { primera: primera.status, final: primera };
    }
    expect(await primera.json()).toEqual({
      code: 'CONFLICTO',
      message: MENSAJES_ERROR.CONFLICTO,
    });
    return { primera: 409, final: await editarUsuario(id, cuerpo) };
  }

  it('desactivar y renombrar a la vez: queda desactivado, renombrado y sin sesiones', async () => {
    for (let ronda = 0; ronda < 3; ronda += 1) {
      const otro = await crearUsuarioConClave();
      const sesionOtro = await iniciarSesion(otro, { ip: `ip-${crypto.randomUUID()}` });
      const nombre = `Renombrado ${String(ronda)}`;
      const [desactivar, renombrar] = await Promise.all([
        editarConReintento(otro.id, { activo: false }),
        editarConReintento(otro.id, { nombre }),
      ]);
      expect(desactivar.final.status).toBe(200);
      expect(renombrar.final.status).toBe(200);
      const fila = await env.DB.prepare('SELECT nombre, activo FROM users WHERE id = ?')
        .bind(otro.id)
        .first();
      expect(fila).toEqual({ nombre, activo: 0 });
      expect((await perfil(sesionOtro.cuerpo.access_token)).status).toBe(401);
      expect((await refrescar(sesionOtro.refresh)).status).toBe(401);
      const vigentes = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revocado_at IS NULL',
      )
        .bind(otro.id)
        .first<{ n: number }>();
      expect(vigentes?.n).toBe(0);
      // Una fila de auditoría por edición aplicada (ni duplicadas ni de la que perdió).
      const ediciones = (await accionesDeUsuario(otro.id)).filter((a) => a === 'usuario.editar');
      expect(ediciones).toHaveLength(2);
    }
  });

  it('renombrar no toca activo, rol ni el bloqueo (solo cambian los campos enviados)', async () => {
    const otro = await crearUsuarioConClave();
    const hasta = new Date(Date.now() + 600_000).toISOString();
    await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
      .bind(hasta, otro.id)
      .run();
    const respuesta = await editarUsuario(otro.id, { nombre: 'Solo El Nombre' });
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json<Usuario>()).toMatchObject({
      nombre: 'Solo El Nombre',
      activo: true,
      rol: 'supervisor',
      intentos_fallidos: 5,
      bloqueado_hasta: hasta,
    });
    const fila = await env.DB.prepare(
      'SELECT nombre, rol, activo, intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(otro.id)
      .first();
    expect(fila).toEqual({
      nombre: 'Solo El Nombre',
      rol: 'supervisor',
      activo: 1,
      intentos_fallidos: 5,
      bloqueado_hasta: hasta,
    });
  });

  it('dos ediciones seguidas en el mismo milisegundo de lectura no se pisan (updated_at estrictamente creciente)', async () => {
    const otro = await crearUsuarioConClave();
    const futuro = new Date(Date.now() + 60_000).toISOString();
    // Un updated_at "en el futuro" fuerza la rama en que el reloj no avanzó desde la lectura.
    await env.DB.prepare('UPDATE users SET updated_at = ? WHERE id = ?')
      .bind(futuro, otro.id)
      .run();
    const respuesta = await editarUsuario(otro.id, { nombre: 'Con Reloj Atrasado' });
    expect(respuesta.status).toBe(200);
    const cuerpo = await respuesta.json<Usuario>();
    expect(cuerpo.updated_at > futuro).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// H-04 y H-11: alcance de la auditoría y sin correo (ADR 0013)
// ---------------------------------------------------------------------------------------------

describe('H-04: GET /audit sin entidades de administración para quien no es admin', () => {
  let admin: SesionDeRol;
  let jefe: SesionDeRol;
  let supervisor: SesionDeRol;
  const ADMINISTRACION = ['users', 'devices', 'refresh_tokens'];

  beforeAll(async () => {
    [admin, jefe, supervisor] = await Promise.all([
      sesion('admin'),
      sesion('jefe'),
      sesion('supervisor'),
    ]);
    // Genera auditoría de `users` (creación por la API).
    const creado = await api('/users', {
      token: admin.token,
      body: {
        nombre: 'Para Auditoría',
        email: `audit-${uuidv7()}@catmetal.test`,
        rol: 'supervisor',
        password: `Clave-${crypto.randomUUID()}`,
      },
    });
    expect(creado.status).toBe(201);
  });

  async function todas(token: string, query = ''): Promise<ListaAuditoria['entradas']> {
    const entradas: ListaAuditoria['entradas'] = [];
    let cursor: number | null = null;
    do {
      const sufijo = cursor === null ? '' : `&cursor=${String(cursor)}`;
      const respuesta = await api(`/audit?limite=200${query}${sufijo}`, { token });
      expect(respuesta.status).toBe(200);
      const pagina = await respuesta.json<ListaAuditoria>();
      entradas.push(...pagina.entradas);
      cursor = pagina.siguiente_cursor;
    } while (cursor !== null);
    return entradas;
  }

  it('el jefe no ve users, devices ni refresh_tokens; pedirlas por ?entidad= da lista vacía', async () => {
    const entradas = await todas(jefe.token);
    expect(entradas.length).toBeGreaterThan(0);
    expect(entradas.filter((e) => ADMINISTRACION.includes(e.entidad))).toEqual([]);
    for (const entidad of ADMINISTRACION) {
      const respuesta = await api(`/audit?entidad=${entidad}`, { token: jefe.token });
      expect(respuesta.status).toBe(200);
      expect(await respuesta.json()).toEqual({ entradas: [], siguiente_cursor: null });
    }
  });

  it('el supervisor tampoco ve sus propias filas de sesión o dispositivo', async () => {
    const entradas = await todas(supervisor.token);
    expect(entradas.filter((e) => ADMINISTRACION.includes(e.entidad))).toEqual([]);
  });

  it('el admin sí ve las tres entidades de administración', async () => {
    for (const entidad of ADMINISTRACION) {
      const entradas = await todas(admin.token, `&entidad=${entidad}`);
      expect(entradas.length, entidad).toBeGreaterThan(0);
    }
  });

  it('H-11: la auditoría de users no copia el correo (crear y editar)', async () => {
    const email = `sin-correo-${uuidv7()}@catmetal.test`;
    const creado = await api('/users', {
      token: admin.token,
      body: { nombre: 'Sin Correo', email, rol: 'supervisor', password: `Clave-${uuidv7()}` },
    });
    const usuario = await creado.json<Usuario>();
    await api(`/users/${usuario.id}`, {
      method: 'PATCH',
      token: admin.token,
      body: { nombre: 'Sin Correo Editado' },
    });
    const { results } = await env.DB.prepare(
      `SELECT accion, datos_antes, datos_despues FROM audit_log
       WHERE entidad = 'users' AND entidad_id = ? ORDER BY seq`,
    )
      .bind(usuario.id)
      .all<{ accion: string; datos_antes: string | null; datos_despues: string | null }>();
    expect(results.map((r) => r.accion)).toEqual(['usuario.crear', 'usuario.editar']);
    for (const fila of results) {
      for (const texto of [fila.datos_antes, fila.datos_despues]) {
        if (texto !== null) {
          expect(JSON.parse(texto)).not.toHaveProperty('email');
          expect(texto.includes(email)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// H-05: límite de tamaño del cuerpo
// ---------------------------------------------------------------------------------------------

describe('H-05: límite de tamaño del cuerpo en /api/v1/*', () => {
  const ERROR_413 = {
    code: 'LOTE_DEMASIADO_GRANDE',
    message: MENSAJES_ERROR.LOTE_DEMASIADO_GRANDE,
  };

  it('un login de 100 KB responde 413 sin tocar D1 (ni el contador de intentos)', async () => {
    const u = await crearUsuarioConClave();
    const respuesta = await intentar(u.email, 'x'.repeat(100 * 1024));
    expect(respuesta.status).toBe(413);
    expect(await respuesta.json()).toEqual(ERROR_413);
    expect(await estadoBloqueo(u.id)).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
  });

  it('sin Content-Length (streaming) también corta al pasar el límite', async () => {
    const u = await crearUsuarioConClave();
    const texto = JSON.stringify({
      email: u.email,
      password: 'x'.repeat(LIMITE_CUERPO_BYTES),
      device_id: uuidv7(),
    });
    const bytes = new TextEncoder().encode(texto);
    const cuerpo = new ReadableStream<Uint8Array>({
      start(controlador) {
        for (let i = 0; i < bytes.length; i += 8192) {
          controlador.enqueue(bytes.subarray(i, i + 8192));
        }
        controlador.close();
      },
    });
    const respuesta = await app.fetch(
      new Request(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Origin: ORIGEN, 'Content-Type': 'application/json' },
        body: cuerpo,
      }),
      env,
    );
    expect(respuesta.status).toBe(413);
    expect(await respuesta.json()).toEqual(ERROR_413);
    expect(await estadoBloqueo(u.id)).toEqual({ intentos_fallidos: 0, bloqueado_hasta: null });
  });

  it('un cuerpo justo por debajo del límite pasa al validador (400, no 413)', async () => {
    const respuesta = await peticion('/api/v1/auth/login', {
      body: { relleno: 'x'.repeat(LIMITE_CUERPO_BYTES - 100) },
    });
    expect(respuesta.status).toBe(400);
  });

  it('POST /sync/push tiene su propio límite de 2 MB (100 KB pasa el filtro; 3 MB no)', async () => {
    const pasa = await peticion('/api/v1/sync/push', { body: { relleno: 'x'.repeat(100 * 1024) } });
    expect(pasa.status).not.toBe(413);
    const grande = await peticion('/api/v1/sync/push', {
      body: { relleno: 'x'.repeat(3 * 1024 * 1024) },
    });
    expect(grande.status).toBe(413);
    expect(await grande.json()).toEqual(ERROR_413);
  });

  describe('PUT /evidences/:id queda fuera del límite de 64 KB', () => {
    let jefe: SesionDeRol;
    let supervisor: SesionDeRol;
    beforeAll(async () => {
      [jefe, supervisor] = await Promise.all([sesion('jefe'), sesion('supervisor')]);
    });

    it('una evidencia de 1 MB se sube', async () => {
      const foto = await archivo('image/jpeg', jpeg(1024 * 1024));
      const esc = await escenarioOrden(jefe, supervisor);
      const consumo = await registrarOk(supervisor.token, cuerpoConsumo(esc.orden, esc.material));
      await novedadOk(supervisor.token, consumo.id, cuerpoNovedad(consumo.id, [foto]));
      const respuesta = await subir(supervisor.token, foto.id, foto.bytes, 'image/jpeg');
      expect(respuesta.status).toBe(200);
      expect(await respuesta.json()).toMatchObject({ id: foto.id, subido: true });
    });

    it('H-12: si el tamaño no es el declarado responde 400 VALIDACION y no escribe en R2', async () => {
      const real = jpeg(2048);
      const sha256 = await sha256Hex(real);
      const id = uuidv7();
      const esc = await escenarioOrden(jefe, supervisor);
      const consumo = await registrarOk(supervisor.token, cuerpoConsumo(esc.orden, esc.material));
      // Declarada con 4096 bytes pero con el sha256 del archivo real de 2048.
      await novedadOk(
        supervisor.token,
        consumo.id,
        cuerpoNovedad(consumo.id, [
          { id, mime: 'image/jpeg', bytes: new Uint8Array(4096), sha256 },
        ]),
      );
      const cuerpo = await esperarError(
        await subir(supervisor.token, id, real, 'image/jpeg'),
        400,
        'VALIDACION',
      );
      expect(cuerpo.details).toEqual([
        {
          campo: 'tamano_bytes',
          mensaje: 'El tamaño de la foto no coincide con el declarado al registrar la novedad.',
        },
      ]);
      expect(await env.EVIDENCE.get(`evidencias/${esc.orden}/${id}`)).toBeNull();
      expect(MAX_EVIDENCIA_BYTES).toBeGreaterThan(LIMITE_CUERPO_BYTES);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Extra (revisión 2.5): borrado del objeto huérfano de R2
// ---------------------------------------------------------------------------------------------

describe('borrarObjetoHuerfano', () => {
  it('borra el objeto de R2 local', async () => {
    const clave = `evidencias/prueba/${uuidv7()}`;
    await env.EVIDENCE.put(clave, new Uint8Array([1, 2, 3]));
    await borrarObjetoHuerfano(env.EVIDENCE, clave);
    expect(await env.EVIDENCE.get(clave)).toBeNull();
  });

  it('no lanza si la clave no existe', async () => {
    await expect(
      borrarObjetoHuerfano(env.EVIDENCE, `evidencias/prueba/${uuidv7()}`),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// H-07: secretos fuertes y distintos
// ---------------------------------------------------------------------------------------------

describe('H-07: validación de JWT_SECRET y REFRESH_SECRET', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fuerte = (letra: string) => letra.repeat(LONGITUD_MINIMA_SECRETO);

  function salud(secretos: { JWT_SECRET: string; REFRESH_SECRET: string }) {
    return app.fetch(new Request(`${BASE}/api/v1/health`), { ...env, ...secretos });
  }

  it('los secretos de las pruebas cumplen la regla', () => {
    expect(diagnosticarSecretos(env.JWT_SECRET, env.REFRESH_SECRET)).toEqual({
      jwt_suficiente: true,
      refresh_suficiente: true,
      distintos: true,
    });
  });

  it.each([
    ['JWT corto', { JWT_SECRET: 'corto', REFRESH_SECRET: fuerte('r') }],
    ['refresh corto', { JWT_SECRET: fuerte('j'), REFRESH_SECRET: 'x'.repeat(42) }],
    ['iguales', { JWT_SECRET: fuerte('s'), REFRESH_SECRET: fuerte('s') }],
  ])('%s: la API responde 500 ERROR_INTERNO y el log no contiene el valor', async (_caso, sec) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const respuesta = await salud(sec);
    expect(respuesta.status).toBe(500);
    expect(await respuesta.json()).toEqual({
      code: 'ERROR_INTERNO',
      message: MENSAJES_ERROR.ERROR_INTERNO,
    });
    const lineas = log.mock.calls.map((llamada) => String(llamada[0]));
    const evento = lineas.find((l) => l.includes('secretos_invalidos'));
    expect(evento).toBeDefined();
    for (const linea of lineas) {
      expect(linea.includes(sec.JWT_SECRET)).toBe(false);
      expect(linea.includes(sec.REFRESH_SECRET)).toBe(false);
    }
    // También el login: nada se firma con un secreto débil.
    const login = await app.fetch(
      new Request(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Origin: ORIGEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', password: 'x', device_id: uuidv7() }),
      }),
      { ...env, ...sec },
    );
    expect(login.status).toBe(500);
  });

  it('con secretos válidos vuelve a responder (la memoria es por par de valores)', async () => {
    expect((await salud({ JWT_SECRET: 'corto', REFRESH_SECRET: 'corto' })).status).toBe(500);
    expect((await salud({ JWT_SECRET: fuerte('a'), REFRESH_SECRET: fuerte('b') })).status).toBe(
      200,
    );
    expect(
      (await salud({ JWT_SECRET: env.JWT_SECRET, REFRESH_SECRET: env.REFRESH_SECRET })).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// H-10: logout en una tablet compartida
// ---------------------------------------------------------------------------------------------

describe('H-10: logout con cookie y Bearer de usuarios distintos', () => {
  async function dosSesiones(): Promise<{
    a: Awaited<ReturnType<typeof iniciarSesion>>;
    b: Awaited<ReturnType<typeof iniciarSesion>>;
    ua: UsuarioPrueba;
    ub: UsuarioPrueba;
  }> {
    const [ua, ub] = await Promise.all([crearUsuarioConClave(), crearUsuarioConClave()]);
    const a = await iniciarSesion(ua, { ip: `ip-${crypto.randomUUID()}` });
    const b = await iniciarSesion(ub, { ip: `ip-${crypto.randomUUID()}` });
    return { a, b, ua, ub };
  }

  it('revoca la familia del Bearer (B) y también la de la cookie presentada (A)', async () => {
    const { a, b, ub } = await dosSesiones();
    const respuesta = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      cookie: a.refresh,
      token: b.cuerpo.access_token,
    });
    expect(respuesta.status).toBe(204);
    expect((await perfil(b.cuerpo.access_token)).status).toBe(401);
    expect((await refrescar(b.refresh)).status).toBe(401);
    expect((await perfil(a.cuerpo.access_token)).status).toBe(401);
    expect((await refrescar(a.refresh)).status).toBe(401);
    const cierreB = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE accion = 'sesion.cierre' AND actor_id = ?`,
    )
      .bind(ub.id)
      .first<{ n: number }>();
    expect(cierreB?.n).toBe(1);
  });

  it('con cookie y Bearer del mismo usuario solo revoca la familia de la cookie (sin cambios)', async () => {
    const { a, b } = await dosSesiones();
    const respuesta = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      cookie: a.refresh,
      token: a.cuerpo.access_token,
    });
    expect(respuesta.status).toBe(204);
    expect((await perfil(a.cuerpo.access_token)).status).toBe(401);
    // La sesión de otro usuario no se toca.
    expect((await perfil(b.cuerpo.access_token)).status).toBe(200);
  });
});

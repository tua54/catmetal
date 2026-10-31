// Administración de usuarios: /api/v1/users (solo admin.gestionar). Nunca se borra.
import { MENSAJES_ERROR, type Usuario, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  crearUsuarioConClave,
  esperarAuditoriaSinSecretos,
  iniciarSesion,
  perfil,
  peticion,
  refrescar,
} from './auth-helpers';

const secretos: string[] = [];

async function sesionDe(rol: 'supervisor' | 'jefe' | 'admin') {
  const u = await crearUsuarioConClave(rol);
  secretos.push(u.password);
  const sesion = await iniciarSesion(u);
  secretos.push(sesion.refresh, sesion.cuerpo.access_token);
  return { u, token: sesion.cuerpo.access_token, refresh: sesion.refresh };
}

function nuevoUsuario(extra: Record<string, unknown> = {}) {
  const password = `Clave-nueva-${crypto.randomUUID()}`;
  secretos.push(password);
  return {
    nombre: 'Operario Nuevo',
    email: `nuevo-${uuidv7()}@catmetal.test`,
    rol: 'supervisor',
    password,
    ...extra,
  };
}

async function crearPorApi(token: string, datos = nuevoUsuario()) {
  const respuesta = await peticion('/api/v1/users', { token, body: datos });
  expect(respuesta.status).toBe(201);
  return { datos, usuario: await respuesta.json<Usuario>() };
}

function editar(token: string, id: string, body: Record<string, unknown>) {
  return peticion(`/api/v1/users/${id}`, { method: 'PATCH', token, body });
}

describe('permisos', () => {
  it.each(['supervisor', 'jefe'] as const)('un %s recibe 403 en GET, POST y PATCH', async (rol) => {
    const { token, u } = await sesionDe(rol);
    expect((await peticion('/api/v1/users', { token })).status).toBe(403);
    expect((await peticion('/api/v1/users', { token, body: nuevoUsuario() })).status).toBe(403);
    expect((await editar(token, u.id, { nombre: 'Yo' })).status).toBe(403);
  });

  it('sin sesión responde 401', async () => {
    expect((await peticion('/api/v1/users')).status).toBe(401);
  });
});

describe('crear', () => {
  it('crea un usuario con el correo normalizado, sin password_hash en la respuesta, y lo audita', async () => {
    const { token, u: admin } = await sesionDe('admin');
    const datos = nuevoUsuario({ email: `  MAYUS-${uuidv7()}@Catmetal.TEST ` });
    const { usuario } = await crearPorApi(token, datos);
    expect(usuario).toMatchObject({
      nombre: 'Operario Nuevo',
      email: datos.email.trim().toLowerCase(),
      rol: 'supervisor',
      activo: true,
      intentos_fallidos: 0,
      bloqueado_hasta: null,
    });
    expect(usuario).not.toHaveProperty('password_hash');

    // Puede iniciar sesión con la contraseña asignada.
    await iniciarSesion({ email: usuario.email, password: datos.password });

    const auditoria = await env.DB.prepare(
      `SELECT accion, actor_id, datos_despues FROM audit_log WHERE entidad = 'users' AND entidad_id = ?`,
    )
      .bind(usuario.id)
      .first<{ accion: string; actor_id: string; datos_despues: string }>();
    expect(auditoria?.accion).toBe('usuario.crear');
    expect(auditoria?.actor_id).toBe(admin.id);
    expect(JSON.parse(auditoria?.datos_despues ?? '{}')).not.toHaveProperty('password_hash');
  });

  it('un correo duplicado (aunque cambie mayúsculas) responde 409 CONFLICTO', async () => {
    const { token } = await sesionDe('admin');
    const { datos } = await crearPorApi(token);
    const respuesta = await peticion('/api/v1/users', {
      token,
      body: nuevoUsuario({ email: datos.email.toUpperCase() }),
    });
    expect(respuesta.status).toBe(409);
    expect(await respuesta.json()).toEqual({
      code: 'CONFLICTO',
      message: MENSAJES_ERROR.CONFLICTO,
      details: { campo: 'email' },
    });
  });

  it('datos inválidos responden 400 VALIDACION (contraseña corta, rol inválido)', async () => {
    const { token } = await sesionDe('admin');
    for (const extra of [{ password: 'corta' }, { rol: 'gerente' }, { email: 'no-es-correo' }]) {
      const respuesta = await peticion('/api/v1/users', { token, body: nuevoUsuario(extra) });
      expect(respuesta.status).toBe(400);
      expect(await respuesta.json()).toMatchObject({ code: 'VALIDACION' });
    }
  });

  it('una contraseña común o de un carácter repetido responde 400 VALIDACION y no crea nada (F6-07)', async () => {
    const { token } = await sesionDe('admin');
    for (const [password, mensaje] of [
      ['Contraseña123', 'La contraseña es demasiado común y fácil de adivinar. Elija otra.'],
      ['catmetal2026', 'La contraseña es demasiado común y fácil de adivinar. Elija otra.'],
      ['1234567890', 'La contraseña es demasiado común y fácil de adivinar. Elija otra.'],
      ['zzzzzzzzzzzz', 'La contraseña no puede ser un mismo carácter repetido.'],
    ] as const) {
      const datos = nuevoUsuario({ password });
      const respuesta = await peticion('/api/v1/users', { token, body: datos });
      expect(respuesta.status, password).toBe(400);
      expect(await respuesta.json()).toMatchObject({
        code: 'VALIDACION',
        details: [{ campo: 'password', mensaje }],
      });
      const fila = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
        .bind(datos.email)
        .first();
      expect(fila, password).toBeNull();
    }
  });
});

describe('listar', () => {
  it('pagina por cursor (id) sin repetir ni saltar, y nunca expone password_hash', async () => {
    const { token } = await sesionDe('admin');
    for (let i = 0; i < 3; i += 1) {
      await crearPorApi(token);
    }
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    const vistos: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limite=2' : `?limite=2&cursor=${cursor}`;
      const respuesta = await peticion(`/api/v1/users${query}`, { token });
      expect(respuesta.status).toBe(200);
      const pagina = await respuesta.json<{
        usuarios: Usuario[];
        siguiente_cursor: string | null;
      }>();
      expect(pagina.usuarios.length).toBeLessThanOrEqual(2);
      for (const usuario of pagina.usuarios) {
        expect(usuario).not.toHaveProperty('password_hash');
        expect(typeof usuario.activo).toBe('boolean');
        vistos.push(usuario.id);
      }
      cursor = pagina.siguiente_cursor;
    } while (cursor !== null);
    expect(vistos).toHaveLength(total?.n ?? -1);
    expect(new Set(vistos).size).toBe(vistos.length);
    expect([...vistos].sort()).toEqual(vistos);
  });

  it('un límite inválido responde 400', async () => {
    const { token } = await sesionDe('admin');
    for (const limite of ['0', '101', 'abc']) {
      expect((await peticion(`/api/v1/users?limite=${limite}`, { token })).status).toBe(400);
    }
  });
});

describe('editar', () => {
  it('cambia el nombre sin cerrar sesiones', async () => {
    const { token } = await sesionDe('admin');
    const otro = await sesionDe('supervisor');
    const respuesta = await editar(token, otro.u.id, { nombre: 'Nombre Corregido' });
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toMatchObject({ id: otro.u.id, nombre: 'Nombre Corregido' });
    expect((await perfil(otro.token)).status).toBe(200);
  });

  it('cambiar el rol revoca todas las sesiones del usuario', async () => {
    const { token } = await sesionDe('admin');
    const otro = await sesionDe('supervisor');
    const respuesta = await editar(token, otro.u.id, { rol: 'jefe' });
    expect(await respuesta.json()).toMatchObject({ rol: 'jefe' });
    expect((await perfil(otro.token)).status).toBe(401);
    expect((await refrescar(otro.refresh)).status).toBe(401);
  });

  it('desactivar revoca las sesiones e impide el login; reactivar lo permite', async () => {
    const { token } = await sesionDe('admin');
    const otro = await sesionDe('supervisor');
    expect(await (await editar(token, otro.u.id, { activo: false })).json()).toMatchObject({
      activo: false,
    });
    expect((await perfil(otro.token)).status).toBe(401);
    const login = await peticion('/api/v1/auth/login', {
      body: { email: otro.u.email, password: otro.u.password, device_id: uuidv7() },
    });
    expect(login.status).toBe(401);
    await editar(token, otro.u.id, { activo: true });
    await iniciarSesion(otro.u);
  });

  it('restablecer la contraseña revoca las sesiones; la nueva funciona y la vieja no', async () => {
    const { token } = await sesionDe('admin');
    const otro = await sesionDe('supervisor');
    const nueva = `Restablecida-${crypto.randomUUID()}`;
    secretos.push(nueva);
    expect((await editar(token, otro.u.id, { password: nueva })).status).toBe(200);
    expect((await perfil(otro.token)).status).toBe(401);
    await iniciarSesion({ email: otro.u.email, password: nueva });
    const vieja = await peticion('/api/v1/auth/login', {
      body: { email: otro.u.email, password: otro.u.password, device_id: uuidv7() },
    });
    expect(vieja.status).toBe(401);
    const auditoria = await env.DB.prepare(
      `SELECT datos_despues FROM audit_log WHERE accion = 'usuario.editar' AND entidad_id = ?`,
    )
      .bind(otro.u.id)
      .first<{ datos_despues: string }>();
    expect(JSON.parse(auditoria?.datos_despues ?? '{}')).toMatchObject({
      password_restablecida: true,
    });
  });

  it('restablecer con una contraseña común responde 400 VALIDACION y conserva la anterior (F6-07)', async () => {
    const { token } = await sesionDe('admin');
    const otro = await sesionDe('supervisor');
    const respuesta = await editar(token, otro.u.id, { password: 'Password123' });
    expect(respuesta.status).toBe(400);
    expect(await respuesta.json()).toMatchObject({
      code: 'VALIDACION',
      details: [{ campo: 'password' }],
    });
    // Nada cambió: la sesión sigue viva y la contraseña anterior sigue funcionando.
    expect((await perfil(otro.token)).status).toBe(200);
    await iniciarSesion({ email: otro.u.email, password: otro.u.password });
  });

  it('el login no aplica la política: una contraseña común incorrecta es CREDENCIALES_INVALIDAS', async () => {
    const otro = await crearUsuarioConClave('supervisor');
    const respuesta = await peticion('/api/v1/auth/login', {
      body: { email: otro.email, password: 'password123', device_id: uuidv7() },
    });
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'CREDENCIALES_INVALIDAS' });
  });

  it('desbloquear reinicia intentos y bloqueado_hasta', async () => {
    const { token } = await sesionDe('admin');
    const otro = await crearUsuarioConClave('supervisor');
    await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
      .bind(new Date(Date.now() + 600_000).toISOString(), otro.id)
      .run();
    const respuesta = await editar(token, otro.id, { desbloquear: true });
    expect(await respuesta.json()).toMatchObject({ intentos_fallidos: 0, bloqueado_hasta: null });
    await iniciarSesion(otro);
  });

  it('un cuerpo vacío o con valores inválidos responde 400; un id inexistente, 404', async () => {
    const { token } = await sesionDe('admin');
    const otro = await crearUsuarioConClave();
    expect((await editar(token, otro.id, {})).status).toBe(400);
    expect((await editar(token, otro.id, { desbloquear: false })).status).toBe(400);
    expect((await editar(token, otro.id, { rol: 'gerente' })).status).toBe(400);
    const inexistente = await editar(token, uuidv7(), { nombre: 'Nadie' });
    expect(inexistente.status).toBe(404);
    expect(await inexistente.json()).toMatchObject({ code: 'NO_ENCONTRADO' });
  });
});

describe('último administrador activo', () => {
  it('no se puede quitar el rol ni desactivar al último admin activo (422 ULTIMO_ADMIN)', async () => {
    const { token, u } = await sesionDe('admin');
    // Deja a este admin como el único activo.
    await env.DB.prepare(`UPDATE users SET activo = 0 WHERE rol = 'admin' AND id <> ?`)
      .bind(u.id)
      .run();
    for (const cambio of [{ rol: 'jefe' }, { activo: false }]) {
      const respuesta = await editar(token, u.id, cambio);
      expect(respuesta.status).toBe(422);
      expect(await respuesta.json()).toEqual({
        code: 'ULTIMO_ADMIN',
        message: MENSAJES_ERROR.ULTIMO_ADMIN,
      });
    }
    const fila = await env.DB.prepare('SELECT rol, activo FROM users WHERE id = ?')
      .bind(u.id)
      .first();
    expect(fila).toEqual({ rol: 'admin', activo: 1 });
    // Sin cambios ni auditoría parcial, y la sesión sigue viva.
    expect((await perfil(token)).status).toBe(200);
    const auditoria = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE accion = 'usuario.editar' AND entidad_id = ?`,
    )
      .bind(u.id)
      .first<{ n: number }>();
    expect(auditoria?.n).toBe(0);
    // Otros cambios del último admin sí se permiten.
    expect((await editar(token, u.id, { nombre: 'Admin Único' })).status).toBe(200);
  });

  it('con otro admin activo, sí se puede quitar el rol a un admin', async () => {
    const primero = await sesionDe('admin');
    const segundo = await sesionDe('admin');
    const respuesta = await editar(primero.token, segundo.u.id, { rol: 'jefe' });
    expect(respuesta.status).toBe(200);
  });
});

describe('nunca se borra', () => {
  it('DELETE /users/:id no existe (404) y el usuario sigue en la base', async () => {
    const { token } = await sesionDe('admin');
    const otro = await crearUsuarioConClave();
    const respuesta = await peticion(`/api/v1/users/${otro.id}`, { method: 'DELETE', token });
    expect(respuesta.status).toBe(404);
    const fila = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(otro.id).first();
    expect(fila).toEqual({ id: otro.id });
  });
});

describe('auditoría de administración', () => {
  it('no contiene contraseñas, hashes, tokens ni secretos', async () => {
    await esperarAuditoriaSinSecretos(secretos);
  });
});

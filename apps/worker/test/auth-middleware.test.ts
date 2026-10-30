// Middlewares: CSRF por Origin, autenticación (rol y estado actuales de D1) y permisos.
import { MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { emitirAccessToken } from '../src/auth/tokens';
import { origenesPermitidos } from '../src/middleware/origen';
import { BASE, crearUsuarioConClave, iniciarSesion, perfil, peticion } from './auth-helpers';

describe('CSRF por Origin', () => {
  const cuerpoLogin = () => ({
    email: `csrf-${uuidv7()}@catmetal.test`,
    password: 'x',
    device_id: uuidv7(),
  });

  it.each([
    ['sin Origin', null],
    ['con un Origin ajeno', 'https://atacante.example'],
    ['con "null"', 'null'],
    ['con el mismo host en http', 'http://catmetal.test'],
  ])('POST /auth/login %s responde 403 ORIGEN_INVALIDO', async (_caso, origen) => {
    const respuesta = await peticion('/api/v1/auth/login', { body: cuerpoLogin(), origen });
    expect(respuesta.status).toBe(403);
    expect(await respuesta.json()).toEqual({
      code: 'ORIGEN_INVALIDO',
      message: MENSAJES_ERROR.ORIGEN_INVALIDO,
    });
  });

  it('también protege /auth/refresh, /auth/logout, /users y rutas inexistentes de /api', async () => {
    for (const ruta of [
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
      '/api/v1/users',
      '/api/v1/nada',
      '/api',
    ]) {
      const respuesta = await peticion(ruta, { method: 'POST', origen: null });
      expect(respuesta.status, ruta).toBe(403);
    }
  });

  it('con el propio origen o uno de ORIGENES_DEV la petición pasa el filtro', async () => {
    for (const origen of [BASE, 'http://localhost:5173', 'http://127.0.0.1:5173']) {
      const respuesta = await peticion('/api/v1/auth/login', { body: cuerpoLogin(), origen });
      expect(respuesta.status, origen).toBe(401);
    }
  });

  it('GET no exige Origin', async () => {
    const respuesta = await peticion('/api/v1/health', { origen: null });
    expect(respuesta.status).toBe(200);
  });

  it('origenesPermitidos ignora entradas vacías y espacios', () => {
    expect([
      ...origenesPermitidos('https://a.test/x?y=1', ' http://localhost:5173 , ,', 'local'),
    ]).toEqual(['https://a.test', 'http://localhost:5173']);
    expect([...origenesPermitidos('https://a.test/', '', 'local')]).toEqual(['https://a.test']);
  });

  it('H-06: en local solo acepta orígenes loopback por HTTP con puerto', () => {
    const dev = [
      'http://localhost:5173',
      'http://127.0.0.1:8787',
      'http://b.test',
      'https://localhost:5173',
      'http://localhost',
      'http://localhost:5173/',
      'http://localhost:99999',
      'http://localhost.evil.test:5173',
      'http://127.0.0.1.evil.test:5173',
    ].join(',');
    expect([...origenesPermitidos('https://a.test/', dev, 'local')]).toEqual([
      'https://a.test',
      'http://localhost:5173',
      'http://127.0.0.1:8787',
    ]);
  });

  it('H-06: fuera de local ignora ORIGENES_DEV aunque traiga orígenes loopback', () => {
    for (const entorno of ['staging', 'production', '']) {
      expect([...origenesPermitidos('https://a.test/', 'http://localhost:5173', entorno)]).toEqual([
        'https://a.test',
      ]);
    }
  });

  it('H-06: con ENTORNO de producción, la app rechaza el Origin del proxy de Vite', async () => {
    const envProduccion = { ...env, ENTORNO: 'production' } as unknown as Env;
    const pedir = (origen: string) =>
      app.fetch(
        new Request(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: { Origin: origen, 'Content-Type': 'application/json' },
          body: JSON.stringify(cuerpoLogin()),
        }),
        envProduccion,
      );
    const vite = await pedir('http://localhost:5173');
    expect(vite.status).toBe(403);
    expect(await vite.json()).toMatchObject({ code: 'ORIGEN_INVALIDO' });
    // El propio origen sigue funcionando (credenciales inválidas → 401, no 403).
    expect((await pedir(BASE)).status).toBe(401);
  });
});

describe('autenticar', () => {
  it('sin Authorization, con basura o con otro esquema responde 401 NO_AUTENTICADO', async () => {
    for (const token of [undefined, 'basura', 'a.b.c']) {
      const respuesta = await peticion('/api/v1/auth/me', { token });
      expect(respuesta.status).toBe(401);
      expect(await respuesta.json()).toEqual({
        code: 'NO_AUTENTICADO',
        message: MENSAJES_ERROR.NO_AUTENTICADO,
      });
    }
    const basic = await peticion('/api/v1/auth/me', { headers: { Authorization: 'Basic abc' } });
    expect(basic.status).toBe(401);
  });

  it('un JWT válido de una familia inexistente responde 401 SESION_REVOCADA', async () => {
    const u = await crearUsuarioConClave();
    const token = await emitirAccessToken(env.JWT_SECRET, {
      sub: u.id,
      did: uuidv7(),
      fam: uuidv7(),
    });
    const respuesta = await perfil(token);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'SESION_REVOCADA' });
  });

  it('un JWT válido de otro dispositivo de la misma familia no sirve', async () => {
    const u = await crearUsuarioConClave();
    const sesion = await iniciarSesion(u);
    const familia = await env.DB.prepare(
      'SELECT familia_id FROM refresh_tokens WHERE device_id = ?',
    )
      .bind(sesion.deviceId)
      .first<{ familia_id: string }>();
    const token = await emitirAccessToken(env.JWT_SECRET, {
      sub: u.id,
      did: uuidv7(),
      fam: familia?.familia_id ?? '',
    });
    expect((await perfil(token)).status).toBe(401);
  });

  it('un usuario desactivado pierde el acceso de inmediato (sin esperar a que venza el JWT)', async () => {
    const u = await crearUsuarioConClave('jefe');
    const sesion = await iniciarSesion(u);
    expect((await perfil(sesion.cuerpo.access_token)).status).toBe(200);
    await env.DB.prepare('UPDATE users SET activo = 0 WHERE id = ?').bind(u.id).run();
    const respuesta = await perfil(sesion.cuerpo.access_token);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'SESION_REVOCADA' });
  });

  it('el rol se toma de D1 en cada petición: un cambio de rol se refleja sin nuevo login', async () => {
    const u = await crearUsuarioConClave('admin');
    const sesion = await iniciarSesion(u);
    expect((await peticion('/api/v1/users', { token: sesion.cuerpo.access_token })).status).toBe(
      200,
    );

    await env.DB.prepare(`UPDATE users SET rol = 'jefe' WHERE id = ?`).bind(u.id).run();
    const denegado = await peticion('/api/v1/users', { token: sesion.cuerpo.access_token });
    expect(denegado.status).toBe(403);
    expect(await denegado.json()).toEqual({
      code: 'PERMISO_DENEGADO',
      message: MENSAJES_ERROR.PERMISO_DENEGADO,
    });
    const me = await perfil(sesion.cuerpo.access_token);
    expect(await me.json()).toMatchObject({ rol: 'jefe' });
  });
});

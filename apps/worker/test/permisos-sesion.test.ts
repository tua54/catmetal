// Tarea 1.4: permisos sobre los endpoints reales de la Fase 1 (/api/v1/users) y negativas
// transversales de autenticación (token ausente, manipulado, de otro secreto, alg none, revocado).
// Fila de la §3: "Gestionar usuarios, materiales, asignaciones y tolerancia" (solo admin).
import { MENSAJES_ERROR, PERMISOS, type Usuario, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { aBase64Url } from '../src/auth/codificacion';
import { emitirAccessToken } from '../src/auth/tokens';
import { peticion } from './auth-helpers';
import { crearAppDePrueba, llamar, type SesionDeRol, sesionReal } from './permisos-helpers';

const codificador = new TextEncoder();

function nuevoUsuario() {
  return {
    nombre: 'Operario Permisos',
    email: `perm-${uuidv7()}@catmetal.test`,
    rol: 'supervisor',
    password: `Clave-nueva-${crypto.randomUUID()}`,
  };
}

interface ClaimsLeidos {
  sub: string;
  did: string;
  fam: string;
}

/** Lee los claims de un JWT sin verificarlo (solo para armar tokens falsos en las pruebas). */
function claimsDe(token: string): ClaimsLeidos {
  const payload = token.split('.')[1] ?? '';
  const texto = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
  return JSON.parse(texto) as ClaimsLeidos;
}

function jsonBase64Url(valor: unknown): string {
  return aBase64Url(codificador.encode(JSON.stringify(valor)));
}

describe('§3 Gestionar usuarios — endpoints reales /api/v1/users', () => {
  const sesiones = {} as Record<'supervisor' | 'jefe' | 'admin', SesionDeRol>;

  beforeAll(async () => {
    for (const rol of ['supervisor', 'jefe', 'admin'] as const) {
      sesiones[rol] = await sesionReal(rol);
    }
  });

  it('§3 Gestionar usuarios — admin permitido: GET 200, POST 201 y PATCH 200', async () => {
    const { token } = sesiones.admin;
    expect((await peticion('/api/v1/users', { token })).status).toBe(200);

    const creado = await peticion('/api/v1/users', { token, body: nuevoUsuario() });
    expect(creado.status).toBe(201);
    const usuario = await creado.json<Usuario>();

    const editado = await peticion(`/api/v1/users/${usuario.id}`, {
      method: 'PATCH',
      token,
      body: { nombre: 'Nombre editado' },
    });
    expect(editado.status).toBe(200);
    expect(await editado.json()).toMatchObject({ id: usuario.id, nombre: 'Nombre editado' });
  });

  it.each(['jefe', 'supervisor'] as const)(
    '§3 Gestionar usuarios — %s denegado: GET, POST y PATCH responden 403 PERMISO_DENEGADO',
    async (rol) => {
      const { token, usuario } = sesiones[rol];
      const antes = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
      const intentos = [
        await peticion('/api/v1/users', { token }),
        await peticion('/api/v1/users', { token, body: nuevoUsuario() }),
        await peticion(`/api/v1/users/${usuario.id}`, {
          method: 'PATCH',
          token,
          body: { rol: 'admin' },
        }),
      ];
      for (const respuesta of intentos) {
        expect(respuesta.status).toBe(403);
        expect(await respuesta.json()).toEqual({
          code: 'PERMISO_DENEGADO',
          message: MENSAJES_ERROR.PERMISO_DENEGADO,
        });
      }
      // La denegación no tuvo efectos: no se creó ningún usuario y el rol no cambió.
      const despues = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{
        n: number;
      }>();
      expect(despues?.n).toBe(antes?.n);
      const fila = await env.DB.prepare('SELECT rol FROM users WHERE id = ?')
        .bind(usuario.id)
        .first<{ rol: string }>();
      expect(fila?.rol).toBe(rol);
    },
  );

  it('§3 Gestionar usuarios — sin token responde 401 NO_AUTENTICADO en GET, POST y PATCH', async () => {
    const intentos = [
      await peticion('/api/v1/users'),
      await peticion('/api/v1/users', { body: nuevoUsuario() }),
      await peticion(`/api/v1/users/${uuidv7()}`, { method: 'PATCH', body: { nombre: 'X' } }),
    ];
    for (const respuesta of intentos) {
      expect(respuesta.status).toBe(401);
      expect(await respuesta.json()).toMatchObject({ code: 'NO_AUTENTICADO' });
    }
  });

  it('un admin degradado a jefe por otro admin pierde la sesión de inmediato (ADR 0008: cambiar el rol revoca las familias)', async () => {
    const degradado = await sesionReal('admin');
    expect((await peticion('/api/v1/users', { token: degradado.token })).status).toBe(200);

    const cambio = await peticion(`/api/v1/users/${degradado.usuario.id}`, {
      method: 'PATCH',
      token: sesiones.admin.token,
      body: { rol: 'jefe' },
    });
    expect(cambio.status).toBe(200);

    const respuesta = await peticion('/api/v1/users', { token: degradado.token });
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toEqual({
      code: 'SESION_REVOCADA',
      message: MENSAJES_ERROR.SESION_REVOCADA,
    });
  });

  it('el rol se toma de D1: un admin degradado a jefe en D1 recibe 403 con su mismo token', async () => {
    const degradado = await sesionReal('admin');
    expect((await peticion('/api/v1/users', { token: degradado.token })).status).toBe(200);
    // Cambio directo en D1 (sin revocar sesiones): aísla que el rol sale de D1 y no del token.
    await env.DB.prepare(`UPDATE users SET rol = 'jefe' WHERE id = ?`)
      .bind(degradado.usuario.id)
      .run();

    const respuesta = await peticion('/api/v1/users', { token: degradado.token });
    expect(respuesta.status).toBe(403);
    expect(await respuesta.json()).toEqual({
      code: 'PERMISO_DENEGADO',
      message: MENSAJES_ERROR.PERMISO_DENEGADO,
    });
    // Con su mismo token conserva los permisos del jefe y pierde los de admin.
    const app = crearAppDePrueba();
    expect((await llamar(app, 'consumos.validar', degradado.token)).status).toBe(200);
    expect((await llamar(app, 'admin.gestionar', degradado.token)).status).toBe(403);
  });

  it('el rol se toma de D1: un supervisor ascendido a admin accede sin nuevo login', async () => {
    const ascendido = await sesionReal('supervisor');
    expect((await peticion('/api/v1/users', { token: ascendido.token })).status).toBe(403);
    await env.DB.prepare(`UPDATE users SET rol = 'admin' WHERE id = ?`)
      .bind(ascendido.usuario.id)
      .run();
    expect((await peticion('/api/v1/users', { token: ascendido.token })).status).toBe(200);
  });
});

describe('negativas transversales de autenticación (middleware real)', () => {
  const app = crearAppDePrueba();
  // Un jefe real tiene `consumos.validar`: un token aceptado daría 200 en esta ruta.
  const PERMISO_RUTA = 'consumos.validar';
  let sesion: SesionDeRol;
  let claims: ClaimsLeidos;

  beforeAll(async () => {
    sesion = await sesionReal('jefe');
    claims = claimsDe(sesion.token);
  });

  async function esperar401(token: string, code: 'NO_AUTENTICADO' | 'SESION_REVOCADA') {
    const respuesta = await llamar(app, PERMISO_RUTA, token);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toEqual({ code, message: MENSAJES_ERROR[code] });
  }

  function firmarHs256(emisor: string, audiencia: string, expiracion: string | number) {
    const ahora = Math.floor(Date.now() / 1000);
    return new SignJWT({ did: claims.did, fam: claims.fam })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(emisor)
      .setAudience(audiencia)
      .setSubject(claims.sub)
      .setIssuedAt(typeof expiracion === 'number' ? ahora - 3600 : ahora)
      .setExpirationTime(expiracion)
      .sign(codificador.encode(env.JWT_SECRET));
  }

  it('control: el token real del jefe sí pasa', async () => {
    expect((await llamar(app, PERMISO_RUTA, sesion.token)).status).toBe(200);
  });

  it('sin Authorization responde 401 NO_AUTENTICADO en cada permiso', async () => {
    for (const permiso of PERMISOS) {
      const respuesta = await llamar(app, permiso);
      expect(respuesta.status, permiso).toBe(401);
      expect(await respuesta.json()).toMatchObject({ code: 'NO_AUTENTICADO' });
    }
  });

  it('un esquema distinto de Bearer responde 401 NO_AUTENTICADO', async () => {
    const respuesta = await llamar(app, PERMISO_RUTA, undefined, {
      Authorization: `Basic ${sesion.token}`,
    });
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'NO_AUTENTICADO' });
  });

  it('un token con la firma alterada responde 401', async () => {
    const [cabecera = '', payload = '', firma = ''] = sesion.token.split('.');
    // Se cambia el primer carácter de la firma (el último solo aporta bits de relleno).
    const alterada = `${firma.startsWith('A') ? 'B' : 'A'}${firma.slice(1)}`;
    await esperar401(`${cabecera}.${payload}.${alterada}`, 'NO_AUTENTICADO');
  });

  it('un token con el payload de otro usuario y la firma vieja responde 401', async () => {
    const admin = await sesionReal('admin');
    const [cabecera = '', , firma = ''] = sesion.token.split('.');
    const payloadAjeno = admin.token.split('.')[1] ?? '';
    await esperar401(`${cabecera}.${payloadAjeno}.${firma}`, 'NO_AUTENTICADO');
  });

  it('un token firmado con otro secreto responde 401', async () => {
    const falso = await emitirAccessToken(
      'otro-secreto-que-no-es-el-del-worker-0123456789',
      claims,
    );
    await esperar401(falso, 'NO_AUTENTICADO');
  });

  it('un token con alg none (con o sin tercer segmento) responde 401', async () => {
    const ahora = Math.floor(Date.now() / 1000);
    const cabecera = jsonBase64Url({ alg: 'none', typ: 'JWT' });
    const payload = jsonBase64Url({
      ...claims,
      iss: 'catmetal-mp',
      aud: 'catmetal-mp-api',
      iat: ahora,
      exp: ahora + 900,
    });
    await esperar401(`${cabecera}.${payload}.`, 'NO_AUTENTICADO');
    await esperar401(`${cabecera}.${payload}`, 'NO_AUTENTICADO');
  });

  it('un token HS256 con el secreto correcto pero emisor o audiencia ajenos responde 401', async () => {
    await esperar401(await firmarHs256('otro-emisor', 'catmetal-mp-api', '15m'), 'NO_AUTENTICADO');
    await esperar401(await firmarHs256('catmetal-mp', 'otra-audiencia', '15m'), 'NO_AUTENTICADO');
    // Control: con emisor y audiencia correctos el mismo método de firma sí pasa.
    expect(
      (await llamar(app, PERMISO_RUTA, await firmarHs256('catmetal-mp', 'catmetal-mp-api', '15m')))
        .status,
    ).toBe(200);
  });

  it('un token vencido responde 401', async () => {
    const vencido = await firmarHs256(
      'catmetal-mp',
      'catmetal-mp-api',
      Math.floor(Date.now() / 1000) - 60,
    );
    await esperar401(vencido, 'NO_AUTENTICADO');
  });

  it('un usuario desactivado responde 401 SESION_REVOCADA con un token todavía vigente', async () => {
    const activo = await sesionReal('jefe');
    expect((await llamar(app, PERMISO_RUTA, activo.token)).status).toBe(200);
    await env.DB.prepare('UPDATE users SET activo = 0 WHERE id = ?').bind(activo.usuario.id).run();
    await esperar401(activo.token, 'SESION_REVOCADA');
  });

  it('un usuario desactivado desde la API de admin pierde el acceso en el siguiente request', async () => {
    const admin = await sesionReal('admin');
    const victima = await sesionReal('jefe');
    expect((await llamar(app, PERMISO_RUTA, victima.token)).status).toBe(200);
    const baja = await peticion(`/api/v1/users/${victima.usuario.id}`, {
      method: 'PATCH',
      token: admin.token,
      body: { activo: false },
    });
    expect(baja.status).toBe(200);
    await esperar401(victima.token, 'SESION_REVOCADA');
  });
});

// POST /api/v1/auth/refresh y /logout: rotación, reutilización, ventana de gracia y concurrencia
// (ADR 0008 puntos 2 y 3).
import { MENSAJES_ERROR, type RespuestaSesion, VENTANA_GRACIA_REFRESH_MS } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hashRefreshToken } from '../src/auth/tokens';
import {
  cookieRefresh,
  crearUsuarioConClave,
  esperarAuditoriaSinSecretos,
  iniciarSesion,
  perfil,
  peticion,
  refrescar,
} from './auth-helpers';

const secretos: string[] = [];

async function nuevaSesion() {
  const u = await crearUsuarioConClave('supervisor');
  secretos.push(u.password);
  const sesion = await iniciarSesion(u);
  secretos.push(sesion.refresh, sesion.cuerpo.access_token);
  return { u, sesion };
}

async function filaToken(token: string) {
  const hash = await hashRefreshToken(env.REFRESH_SECRET, token);
  return env.DB.prepare(
    'SELECT id, familia_id, revocado_at, reemplazado_por, created_at FROM refresh_tokens WHERE token_hash = ?',
  )
    .bind(hash)
    .first<{
      id: string;
      familia_id: string;
      revocado_at: string | null;
      reemplazado_por: string | null;
      created_at: string;
    }>();
}

async function vigentesDeFamilia(familiaId: string): Promise<number> {
  const fila = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM refresh_tokens WHERE familia_id = ? AND revocado_at IS NULL',
  )
    .bind(familiaId)
    .first<{ n: number }>();
  return fila?.n ?? -1;
}

async function exitoso(respuesta: Response) {
  expect(respuesta.status).toBe(200);
  const cuerpo = await respuesta.json<RespuestaSesion>();
  const refresh = cookieRefresh(respuesta)?.valor ?? '';
  secretos.push(refresh, cuerpo.access_token);
  return { cuerpo, refresh };
}

/** Lleva la creación del sucesor fuera de la ventana de gracia. */
async function envejecer(tokenId: string) {
  const viejo = new Date(Date.now() - VENTANA_GRACIA_REFRESH_MS - 5000).toISOString();
  await env.DB.prepare('UPDATE refresh_tokens SET created_at = ? WHERE id = ?')
    .bind(viejo, tokenId)
    .run();
}

describe('rotación', () => {
  it('emite un token nuevo de la misma familia; el viejo queda revocado y reemplazado_por = nuevo', async () => {
    const { u, sesion } = await nuevaSesion();
    const antes = await filaToken(sesion.refresh);
    const { cuerpo, refresh } = await exitoso(await refrescar(sesion.refresh));

    expect(refresh).not.toBe(sesion.refresh);
    expect(cuerpo.usuario.id).toBe(u.id);
    expect(cuerpo.device_id).toBe(sesion.deviceId);
    const viejo = await filaToken(sesion.refresh);
    const nuevo = await filaToken(refresh);
    expect(viejo?.revocado_at).not.toBeNull();
    expect(viejo?.reemplazado_por).toBe(nuevo?.id);
    expect(nuevo?.familia_id).toBe(antes?.familia_id);
    expect(nuevo?.revocado_at).toBeNull();
    expect(await vigentesDeFamilia(antes?.familia_id ?? '')).toBe(1);
    // El access token nuevo funciona, y el anterior de la misma familia también (familia vigente).
    expect((await perfil(cuerpo.access_token)).status).toBe(200);
    expect((await perfil(sesion.cuerpo.access_token)).status).toBe(200);

    const auditoria = await env.DB.prepare(
      `SELECT accion FROM audit_log WHERE entidad = 'refresh_tokens' AND entidad_id = ?`,
    )
      .bind(nuevo?.id ?? '')
      .all();
    expect(auditoria.results).toEqual([{ accion: 'sesion.rotacion' }]);
  });

  it('sin cookie o con un token desconocido responde 401 TOKEN_INVALIDO', async () => {
    const sinCookie = await peticion('/api/v1/auth/refresh', { method: 'POST' });
    expect(sinCookie.status).toBe(401);
    expect(await sinCookie.json()).toEqual({
      code: 'TOKEN_INVALIDO',
      message: MENSAJES_ERROR.TOKEN_INVALIDO,
    });
    const desconocido = await refrescar('token-que-no-existe');
    expect(desconocido.status).toBe(401);
    expect(await desconocido.json()).toMatchObject({ code: 'TOKEN_INVALIDO' });
    expect(cookieRefresh(desconocido)?.atributos).toContain('Max-Age=0');
  });

  it('un refresh vencido responde 401 TOKEN_INVALIDO', async () => {
    const { sesion } = await nuevaSesion();
    const fila = await filaToken(sesion.refresh);
    await env.DB.prepare('UPDATE refresh_tokens SET expira_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), fila?.id ?? '')
      .run();
    const respuesta = await refrescar(sesion.refresh);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'TOKEN_INVALIDO' });
  });

  it('un usuario desactivado no puede refrescar', async () => {
    const { u, sesion } = await nuevaSesion();
    await env.DB.prepare('UPDATE users SET activo = 0 WHERE id = ?').bind(u.id).run();
    const respuesta = await refrescar(sesion.refresh);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'SESION_REVOCADA' });
  });
});

describe('reutilización y ventana de gracia', () => {
  it('reutilizar un token rotado fuera de la ventana revoca toda la familia y corta el access token', async () => {
    const { sesion } = await nuevaSesion();
    const { refresh: segundo, cuerpo } = await exitoso(await refrescar(sesion.refresh));
    const sucesor = await filaToken(segundo);
    await envejecer(sucesor?.id ?? '');

    const respuesta = await refrescar(sesion.refresh);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toEqual({
      code: 'SESION_REVOCADA',
      message: MENSAJES_ERROR.SESION_REVOCADA,
    });
    expect(await vigentesDeFamilia(sucesor?.familia_id ?? '')).toBe(0);
    // El access token de esa familia deja de servir de inmediato, y el refresh legítimo también.
    expect((await perfil(cuerpo.access_token)).status).toBe(401);
    expect((await refrescar(segundo)).status).toBe(401);

    const auditoria = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE accion = 'sesion.reutilizacion' AND entidad_id = ?`,
    )
      .bind((await filaToken(sesion.refresh))?.id ?? '')
      .first<{ n: number }>();
    expect(auditoria?.n).toBe(1);
  });

  it('un reintento dentro de 30 s (respuesta perdida) no revoca la familia y entrega un token válido', async () => {
    const { sesion } = await nuevaSesion();
    const { refresh: perdido } = await exitoso(await refrescar(sesion.refresh));
    const { refresh: reintento, cuerpo } = await exitoso(await refrescar(sesion.refresh));

    expect(reintento).not.toBe(perdido);
    const filaPerdido = await filaToken(perdido);
    const filaReintento = await filaToken(reintento);
    expect(filaPerdido?.revocado_at).not.toBeNull();
    expect(filaPerdido?.reemplazado_por).toBe(filaReintento?.id);
    expect(filaReintento?.revocado_at).toBeNull();
    expect(await vigentesDeFamilia(filaReintento?.familia_id ?? '')).toBe(1);
    expect((await perfil(cuerpo.access_token)).status).toBe(200);
    // El token del reintento sigue rotando con normalidad.
    await exitoso(await refrescar(reintento));
  });

  it('un token revocado por logout (sin sucesor) responde SESION_REVOCADA', async () => {
    const { sesion } = await nuevaSesion();
    await peticion('/api/v1/auth/logout', { method: 'POST', cookie: sesion.refresh });
    const respuesta = await refrescar(sesion.refresh);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'SESION_REVOCADA' });
  });

  it('dos refresh concurrentes con el mismo token no dejan dos sucesores vigentes', async () => {
    const { sesion } = await nuevaSesion();
    const familia = (await filaToken(sesion.refresh))?.familia_id ?? '';
    const respuestas = await Promise.all([refrescar(sesion.refresh), refrescar(sesion.refresh)]);
    for (const respuesta of respuestas) {
      expect([200, 401]).toContain(respuesta.status);
      if (respuesta.status === 200) {
        secretos.push(cookieRefresh(respuesta)?.valor ?? '');
      }
    }
    expect(await vigentesDeFamilia(familia)).toBeLessThanOrEqual(1);
  });

  it('varias rondas de refresh concurrentes mantienen como máximo un token vigente', async () => {
    const { sesion } = await nuevaSesion();
    const familia = (await filaToken(sesion.refresh))?.familia_id ?? '';
    await Promise.all(Array.from({ length: 5 }, () => refrescar(sesion.refresh)));
    expect(await vigentesDeFamilia(familia)).toBeLessThanOrEqual(1);
  });
});

describe('logout', () => {
  it('revoca la familia, invalida el access token, borra la cookie y es idempotente', async () => {
    const { u, sesion } = await nuevaSesion();
    const respuesta = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      cookie: sesion.refresh,
    });
    expect(respuesta.status).toBe(204);
    expect(cookieRefresh(respuesta)?.atributos).toEqual(
      expect.arrayContaining(['Max-Age=0', 'Path=/api/v1/auth']),
    );
    expect((await perfil(sesion.cuerpo.access_token)).status).toBe(401);

    const otra = await peticion('/api/v1/auth/logout', { method: 'POST', cookie: sesion.refresh });
    expect(otra.status).toBe(204);
    const cierres = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE accion = 'sesion.cierre' AND actor_id = ?`,
    )
      .bind(u.id)
      .first<{ n: number }>();
    expect(cierres?.n).toBe(1);
  });

  it('sin cookie usa la familia del access token', async () => {
    const { sesion } = await nuevaSesion();
    const respuesta = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      token: sesion.cuerpo.access_token,
    });
    expect(respuesta.status).toBe(204);
    expect((await perfil(sesion.cuerpo.access_token)).status).toBe(401);
    expect((await refrescar(sesion.refresh)).status).toBe(401);
  });

  it('sin cookie ni token responde 204 sin hacer nada', async () => {
    const respuesta = await peticion('/api/v1/auth/logout', { method: 'POST' });
    expect(respuesta.status).toBe(204);
  });
});

describe('auditoría de sesiones', () => {
  it('no contiene contraseñas, hashes, tokens ni secretos', async () => {
    await esperarAuditoriaSinSecretos(secretos);
  });
});

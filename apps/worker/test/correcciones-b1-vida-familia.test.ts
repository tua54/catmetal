// B1 (docs/correcciones-v1.1.md; docs/spec.md §5 v2.1): la familia de refresh tiene una vida
// máxima ABSOLUTA de 30 días contados desde el login con contraseña. Las rotaciones (y los
// reintentos dentro de la ventana de gracia) no la extienden; al vencer se exige la contraseña.
//
// El paso del tiempo se simula corriendo hacia atrás TODAS las marcas de los tokens de la familia
// (created_at, updated_at, expira_at, revocado_at): equivale a que haya pasado ese tiempo.
import { REFRESH_TOKEN_TTL_S, type RespuestaSesion } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { hashRefreshToken } from '../src/auth/tokens';
import {
  cookieRefresh,
  crearUsuarioConClave,
  esperarAuditoriaSinSecretos,
  iniciarSesion,
  refrescar,
} from './auth-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MIN_MS = 60_000;
const DIA_MS = 24 * 60 * MIN_MS;
const secretos: string[] = [];

interface FilaToken {
  id: string;
  familia_id: string;
  expira_at: string;
  created_at: string;
}

async function filaToken(token: string): Promise<FilaToken> {
  const hash = await hashRefreshToken(env.REFRESH_SECRET, token);
  const fila = await env.DB.prepare(
    'SELECT id, familia_id, expira_at, created_at FROM refresh_tokens WHERE token_hash = ?',
  )
    .bind(hash)
    .first<FilaToken>();
  expect(fila).not.toBeNull();
  return fila as FilaToken;
}

function restar(iso: string | null, ms: number): string | null {
  return iso === null ? null : new Date(Date.parse(iso) - ms).toISOString();
}

/** Simula que pasaron `ms` milisegundos para la familia: corre hacia atrás todas sus marcas. */
async function pasarTiempo(familiaId: string, ms: number): Promise<void> {
  const { results } = await env.DB.prepare(
    'SELECT id, created_at, updated_at, expira_at, revocado_at FROM refresh_tokens WHERE familia_id = ?',
  )
    .bind(familiaId)
    .all<{
      id: string;
      created_at: string;
      updated_at: string;
      expira_at: string;
      revocado_at: string | null;
    }>();
  await env.DB.batch(
    results.map((fila) =>
      env.DB.prepare(
        `UPDATE refresh_tokens SET created_at = ?, updated_at = ?, expira_at = ?, revocado_at = ?
         WHERE id = ?`,
      ).bind(
        restar(fila.created_at, ms),
        restar(fila.updated_at, ms),
        restar(fila.expira_at, ms),
        restar(fila.revocado_at, ms),
        fila.id,
      ),
    ),
  );
}

async function exitoso(respuesta: Response): Promise<{ refresh: string; maxAge: number }> {
  expect(respuesta.status, 'refresh').toBe(200);
  const cuerpo = await respuesta.json<RespuestaSesion>();
  const cookie = cookieRefresh(respuesta);
  expect(cookie).not.toBeNull();
  const atributo = cookie?.atributos.find((a) => a.startsWith('Max-Age='));
  expect(atributo).toBeDefined();
  secretos.push(cookie?.valor ?? '', cuerpo.access_token);
  return { refresh: cookie?.valor ?? '', maxAge: Number(atributo?.slice('Max-Age='.length)) };
}

async function nuevaSesion() {
  const u = await crearUsuarioConClave('supervisor');
  secretos.push(u.password);
  const sesion = await iniciarSesion(u);
  secretos.push(sesion.refresh, sesion.cuerpo.access_token);
  const inicial = await filaToken(sesion.refresh);
  return { u, sesion, inicial };
}

describe('B1: vida máxima absoluta de la familia de refresh', () => {
  it('las rotaciones no extienden la familia: a los 30 días + 1 min del login el refresh se rechaza aunque la última rotación sea reciente', async () => {
    const { sesion, inicial } = await nuevaSesion();
    const familia = inicial.familia_id;
    // El login da exactamente 30 días.
    expect(Date.parse(inicial.expira_at) - Date.parse(inicial.created_at)).toBe(
      REFRESH_TOKEN_TTL_S * 1000,
    );

    let actual = sesion.refresh;
    // Rotaciones a los 10, 20 y 29 días y 23 h del login.
    for (const avance of [10 * DIA_MS, 10 * DIA_MS, 9 * DIA_MS + 23 * 60 * MIN_MS]) {
      await pasarTiempo(familia, avance);
      const rotado = await exitoso(await refrescar(actual));
      actual = rotado.refresh;
      const fila = await filaToken(actual);
      expect(fila.familia_id).toBe(familia);
      // El vencimiento del token rotado es el de la familia (login + 30 días), corrido igual que
      // las demás marcas: nunca "ahora + 30 días".
      const loginCorrido = await env.DB.prepare('SELECT expira_at FROM refresh_tokens WHERE id = ?')
        .bind(inicial.id)
        .first<{ expira_at: string }>();
      expect(fila.expira_at).toBe(loginCorrido?.expira_at);
      // La cookie no dura más que lo que le queda a la familia.
      const restanteS = (Date.parse(fila.expira_at) - Date.now()) / 1000;
      expect(rotado.maxAge).toBeGreaterThan(0);
      expect(rotado.maxAge).toBeLessThanOrEqual(Math.ceil(restanteS));
    }
    // Tras la rotación de los 29 d 23 h, a la familia le queda ~1 h: la cookie lo refleja.
    const ultima = await filaToken(actual);
    expect(Date.parse(ultima.expira_at) - Date.now()).toBeLessThanOrEqual(60 * MIN_MS);

    // 61 min después (login + 30 días + 1 min): la última rotación fue hace solo 61 min, pero la
    // familia venció. Se exige la contraseña.
    await pasarTiempo(familia, 61 * MIN_MS);
    const vencido = await refrescar(actual);
    expect(vencido.status).toBe(401);
    expect(await vencido.json()).toMatchObject({ code: 'TOKEN_INVALIDO' });
    expect(cookieRefresh(vencido)?.atributos).toContain('Max-Age=0');
  });

  it('una familia de antes de la corrección (rotaciones con 30 días nuevos) se corta por la fecha del login', async () => {
    const { sesion, inicial } = await nuevaSesion();
    // Así quedaba con el código anterior: login hace 31 días y rotación hace 2 días con 30 días
    // nuevos (el token vigente vence dentro de 28 días).
    await pasarTiempo(inicial.familia_id, 29 * DIA_MS);
    const rotado = await exitoso(await refrescar(sesion.refresh));
    await pasarTiempo(inicial.familia_id, 2 * DIA_MS);
    const fila = await filaToken(rotado.refresh);
    await env.DB.prepare('UPDATE refresh_tokens SET expira_at = ? WHERE id = ?')
      .bind(new Date(Date.now() + 28 * DIA_MS).toISOString(), fila.id)
      .run();

    const respuesta = await refrescar(rotado.refresh);
    expect(respuesta.status).toBe(401);
    expect(await respuesta.json()).toMatchObject({ code: 'TOKEN_INVALIDO' });
  });

  it('el reintento dentro de la ventana de gracia tampoco extiende la familia', async () => {
    const { sesion, inicial } = await nuevaSesion();
    await pasarTiempo(inicial.familia_id, 20 * DIA_MS);
    await exitoso(await refrescar(sesion.refresh));
    // Respuesta perdida: el cliente reintenta con el token ya rotado (dentro de los 30 s).
    const reintento = await exitoso(await refrescar(sesion.refresh));
    const fila = await filaToken(reintento.refresh);
    const login = await env.DB.prepare('SELECT expira_at FROM refresh_tokens WHERE id = ?')
      .bind(inicial.id)
      .first<{ expira_at: string }>();
    expect(fila.expira_at).toBe(login?.expira_at);
    expect(reintento.maxAge).toBeLessThanOrEqual(10 * 24 * 60 * 60);
    expect(reintento.maxAge).toBeGreaterThan(10 * 24 * 60 * 60 - 60);
  });

  it('el login sigue dando una cookie de 30 días completos', async () => {
    const { sesion } = await nuevaSesion();
    expect(cookieRefresh(sesion.respuesta)?.atributos).toContain(
      `Max-Age=${String(REFRESH_TOKEN_TTL_S)}`,
    );
  });

  it('la auditoría de las rotaciones no contiene secretos', async () => {
    await esperarAuditoriaSinSecretos(secretos);
  });
});

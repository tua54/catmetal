// A3 (docs/correcciones-v1.2.md; ADR 0026, enmienda 1): con la versión mínima subida, un cliente
// desactualizado SIEMPRE puede cerrar sesión y revocar su familia de refresh. Solo
// `POST /api/v1/auth/logout` (método y ruta exactos) queda fuera de la exigencia; `/auth/refresh`,
// `/auth/login` y cualquier otro método sobre `/auth/logout` siguen respondiendo 426.
//
// Worker real (la app de src/app.ts con el `env` real, solo con `VERSION_MINIMA_CLIENTE` cambiada),
// sesiones reales y D1 local real, sin mocks. Determinista: no depende de tiempos ni de azar.
import { CABECERA_VERSION_CLIENTE, MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { hashRefreshToken } from '../src/auth/tokens';
import {
  BASE,
  crearUsuarioConClave,
  iniciarSesion,
  ORIGEN,
  type SesionPrueba,
} from './auth-helpers';
import { ultimoSeq } from './fase2-helpers';

// Logins reales con PBKDF2: con la máquina cargada superan el límite por defecto de 5 s (mismo
// valor que las demás pruebas pesadas del worker; no cambia ninguna aserción).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MINIMA = '2';

interface Llamada {
  method: string;
  /** Valor de `X-Version-Cliente`; `undefined` = sin cabecera (cliente v1.0, cuenta como 1). */
  version?: string;
  token?: string;
  refresh?: string;
  body?: unknown;
}

/** Llama a la app real con `VERSION_MINIMA_CLIENTE = 2`. */
async function llamar(ruta: string, opciones: Llamada): Promise<Response> {
  const headers = new Headers({ Origin: ORIGEN });
  if (opciones.version !== undefined) {
    headers.set(CABECERA_VERSION_CLIENTE, opciones.version);
  }
  if (opciones.token !== undefined) {
    headers.set('Authorization', `Bearer ${opciones.token}`);
  }
  if (opciones.refresh !== undefined) {
    headers.set('Cookie', `mp_refresh=${opciones.refresh}`);
  }
  let body: string | undefined;
  if (opciones.body !== undefined) {
    body = JSON.stringify(opciones.body);
    headers.set('Content-Type', 'application/json');
  }
  return app.request(
    `${BASE}/api/v1${ruta}`,
    { method: opciones.method, headers, body },
    { ...env, VERSION_MINIMA_CLIENTE: MINIMA },
  );
}

async function esperar426(respuesta: Response): Promise<void> {
  expect(respuesta.status).toBe(426);
  expect(await respuesta.json()).toEqual({
    code: 'CLIENTE_DESACTUALIZADO',
    message: MENSAJES_ERROR.CLIENTE_DESACTUALIZADO,
    details: { version_minima: Number(MINIMA) },
  });
}

/** Filas de la familia del refresh presentado: cuántas hay y cuántas siguen sin revocar. */
async function estadoFamilia(refresh: string): Promise<{ total: number; vivas: number }> {
  const hash = await hashRefreshToken(env.REFRESH_SECRET, refresh);
  const fila = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN revocado_at IS NULL THEN 1 ELSE 0 END) AS vivas
     FROM refresh_tokens
     WHERE familia_id = (SELECT familia_id FROM refresh_tokens WHERE token_hash = ?)`,
  )
    .bind(hash)
    .first<{ total: number; vivas: number | null }>();
  return { total: fila?.total ?? 0, vivas: fila?.vivas ?? 0 };
}

async function sesionNueva(): Promise<SesionPrueba> {
  return iniciarSesion(await crearUsuarioConClave('supervisor'));
}

describe('A3: el logout de un cliente desactualizado no exige la versión mínima', () => {
  it('POST /auth/logout sin cabecera (v1) con la mínima en 2 → 204 y la familia queda revocada', async () => {
    const s = await sesionNueva();
    expect(await estadoFamilia(s.refresh)).toEqual({ total: 1, vivas: 1 });

    const respuesta = await llamar('/auth/logout', {
      method: 'POST',
      token: s.cuerpo.access_token,
      refresh: s.refresh,
    });
    expect(respuesta.status).toBe(204);
    // Como siempre: borra la cookie de refresh.
    expect(respuesta.headers.getSetCookie().some((l) => l.startsWith('mp_refresh=;'))).toBe(true);
    expect(await estadoFamilia(s.refresh)).toEqual({ total: 1, vivas: 0 });
    // Y audita el cierre, igual que con un cliente al día.
    const cierre = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE accion = 'sesion.cierre' AND actor_id = ?`,
    )
      .bind(s.cuerpo.usuario.id)
      .first<{ n: number }>();
    expect(cierre?.n).toBe(1);
  });

  it('también con una versión explícita menor (1) y solo con el access token', async () => {
    const s = await sesionNueva();
    const respuesta = await llamar('/auth/logout', {
      method: 'POST',
      version: '1',
      token: s.cuerpo.access_token,
    });
    expect(respuesta.status).toBe(204);
    expect(await estadoFamilia(s.refresh)).toEqual({ total: 1, vivas: 0 });
  });

  it('POST /auth/refresh sigue exigiendo la versión: 426 y la familia no rota', async () => {
    const s = await sesionNueva();
    const antes = await ultimoSeq();
    await esperar426(await llamar('/auth/refresh', { method: 'POST', refresh: s.refresh }));
    expect(await estadoFamilia(s.refresh)).toEqual({ total: 1, vivas: 1 });
    expect(await ultimoSeq()).toBe(antes);
  });

  it('POST /auth/login sigue exigiendo la versión: 426', async () => {
    const usuario = await crearUsuarioConClave('supervisor');
    await esperar426(
      await llamar('/auth/login', {
        method: 'POST',
        body: { email: usuario.email, password: usuario.password, device_id: uuidv7() },
      }),
    );
  });

  it('otro método sobre /auth/logout, u otra ruta parecida, sigue con 426 y no procesa nada', async () => {
    const s = await sesionNueva();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      await esperar426(
        await llamar('/auth/logout', { method, token: s.cuerpo.access_token, refresh: s.refresh }),
      );
    }
    for (const ruta of ['/auth/logout/', '/auth/logout/x', '/auth/LOGOUT', '/auth/me']) {
      await esperar426(
        await llamar(ruta, { method: 'POST', token: s.cuerpo.access_token, refresh: s.refresh }),
      );
    }
    expect(await estadoFamilia(s.refresh)).toEqual({ total: 1, vivas: 1 });
  });
});

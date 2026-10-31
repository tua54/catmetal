// A6, parte del servidor (docs/correcciones-v1.2.md; ADR 0029): el token de página del snapshot
// lleva el `user_id` y el `rol` del actor que lo pidió, y al continuar el servidor exige que
// coincidan con la sesión actual. Un token de otro usuario, de otro rol (cambio de rol a mitad de
// la descarga) o del formato anterior (sin esos campos) recibe el mismo 400 `VALIDACION`
// (campo `pagina`) que un token inválido; el cliente v1.1 empieza el snapshot de cero.
//
// Worker real, sesiones reales y D1 local real (sin mocks). Determinista: se siembran
// MAX_ENTIDADES_SNAPSHOT + 1 materiales (visibilidad global), así todo snapshot `inicial` tiene al
// menos dos páginas para cualquier usuario.
import { MAX_ENTIDADES_SNAPSHOT, type SnapshotResponse, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { aBase64Url } from '../src/auth/codificacion';
import { esperarError, sesion, type SesionDeRol } from './fase2-helpers';
import { snapshotCompleto, snapshotDe, snapshotOk } from './fase3-helpers';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let supervisorA: SesionDeRol;
let supervisorB: SesionDeRol;

beforeAll(async () => {
  [supervisorA, supervisorB] = await Promise.all([sesion('supervisor'), sesion('supervisor')]);
  const t = new Date().toISOString();
  const sentencias = Array.from({ length: MAX_ENTIDADES_SNAPSHOT + 1 }, (_, i) => {
    const id = uuidv7();
    return env.DB.prepare(
      `INSERT INTO materials (id, codigo, nombre, unidad, costo_unitario_cop, activo, created_at, updated_at)
       VALUES (?, ?, ?, 'kg', 100, 1, ?, ?)`,
    ).bind(id, `MP-A6-${id}`, `Material A6 ${String(i)}`, t, t);
  });
  await env.DB.batch(sentencias);
});

/** Primera página del snapshot `inicial` del usuario y su token de continuación (no nulo). */
async function primeraPagina(s: SesionDeRol): Promise<{ pagina: SnapshotResponse; token: string }> {
  const pagina = await snapshotOk(s.token, 'alcance=inicial');
  expect(pagina.siguiente_pagina, 'el snapshot debe tener más de una página').not.toBeNull();
  return { pagina, token: pagina.siguiente_pagina ?? '' };
}

/** El mismo 400 que un token inválido: `VALIDACION` con el detalle en el campo `pagina`. */
async function esperarPaginaInvalida(respuesta: Response): Promise<void> {
  const cuerpo = await esperarError(respuesta, 400, 'VALIDACION');
  expect(cuerpo.details).toEqual([{ campo: 'pagina', mensaje: 'La página no es válida.' }]);
}

function continuar(s: SesionDeRol, token: string): Promise<Response> {
  return snapshotDe(s.token, `alcance=inicial&pagina=${encodeURIComponent(token)}`);
}

function tokenCrudo(valor: Record<string, unknown>): string {
  return aBase64Url(new TextEncoder().encode(JSON.stringify(valor)));
}

describe('A6: el token de página está ligado al usuario y al rol', () => {
  it('un token emitido para el supervisor A, usado por el supervisor B → 400 VALIDACION (pagina)', async () => {
    const { token } = await primeraPagina(supervisorA);
    await esperarPaginaInvalida(await continuar(supervisorB, token));
    // El dueño del token sigue pudiendo continuar.
    expect((await continuar(supervisorA, token)).status).toBe(200);
  });

  it('un token emitido como jefe, usado tras degradar al usuario a supervisor → 400', async () => {
    const jefe = await sesion('jefe');
    const { token } = await primeraPagina(jefe);
    // `autenticar` lee el rol ACTUAL de D1 en cada petición: la misma sesión ya es de supervisor.
    await env.DB.prepare(`UPDATE users SET rol = 'supervisor' WHERE id = ?`)
      .bind(jefe.usuario.id)
      .run();
    await esperarPaginaInvalida(await continuar(jefe, token));
  });

  it('un token del formato anterior (sin user_id ni rol) → 400, con versión 2 o sin versión', async () => {
    const { token } = await primeraPagina(supervisorA);
    const actual = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;
    const base = { cursor: actual.cursor, entidad: actual.entidad, ultimo_id: actual.ultimo_id };
    await esperarPaginaInvalida(await continuar(supervisorA, tokenCrudo({ version: 2, ...base })));
    await esperarPaginaInvalida(await continuar(supervisorA, tokenCrudo(base)));
  });

  it('el mismo usuario con el mismo rol pagina hasta el final sin repetir', async () => {
    const { paginas, entidades } = await snapshotCompleto(supervisorB.token, 'alcance=inicial');
    expect(paginas.length).toBeGreaterThanOrEqual(2);
    expect(paginas.at(-1)?.siguiente_pagina).toBeNull();
    const claves = entidades.map((e) => `${e.entidad}:${e.id}`);
    expect(new Set(claves).size).toBe(claves.length);
    expect(entidades.filter((e) => e.entidad === 'materials').length).toBeGreaterThan(
      MAX_ENTIDADES_SNAPSHOT,
    );
  });
});

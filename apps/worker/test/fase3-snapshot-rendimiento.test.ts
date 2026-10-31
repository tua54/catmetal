// Revisión de la Fase 3, M5 (Fase 6): rendimiento de `GET /sync/snapshot`.
// - Cada página consulta solo la entidad en curso (y las siguientes, una a una, si se agota).
// - `validations` se pagina por el id de su consumo, siguiendo un índice: sin B-tree temporal.
// - El snapshot completo de un supervisor con > 1000 entidades trae todo, sin repetir.
// Worker real, sesiones reales y D1 local real (sin mocks).
import { MAX_ENTIDADES_SNAPSHOT } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { aBase64Url } from '../src/auth/codificacion';
import type { Contexto } from '../src/dominio/contexto';
import { descriptorDe } from '../src/sync/entidades';
import { codificarPagina, consultaDePagina } from '../src/sync/snapshot';
import { escenarioOrden } from './fase2-consumos-helpers';
import { esperarError, nuevaOrden, sesion, type SesionDeRol } from './fase2-helpers';
import { dbConConteo, llamarConDb, snapshotCompleto, snapshotDe } from './fase3-helpers';
import { sentenciaInsert, valoresConsumo, valoresValidacion } from './fixtures-db';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;
let jefe: SesionDeRol;
let orden: string;
let ajena: string;
let sinAsignar: string;
let material: string;

const CONSUMOS_ASIGNADA = 700;
const VALIDADOS_ASIGNADA = 650;
const CONSUMOS_PROPIOS_SIN_ASIGNAR = 40;

async function enLotes(sentencias: D1PreparedStatement[]) {
  for (let i = 0; i < sentencias.length; i += 100) {
    await env.DB.batch(sentencias.slice(i, i + 100));
  }
}

/** Consumos (SQL directo) y validaciones en orden INVERSO al de los consumos. */
async function consumosValidados(
  s: SesionDeRol,
  orderId: string,
  total: number,
  validados: number,
): Promise<string[]> {
  const escena = {
    supervisor: s.usuario.id,
    dispositivo: s.deviceId,
    jefe: jefe.usuario.id,
    dispositivoJefe: jefe.deviceId,
    material,
    orden: orderId,
  };
  const valores = Array.from({ length: total }, () => valoresConsumo(escena));
  await enLotes(valores.map((v) => sentenciaInsert('consumptions', v)));
  const ids = valores.map((v) => String(v.id));
  // Validaciones creadas al revés: su id (UUID v7) crece al contrario que el de su consumo, así
  // que paginar por `v.id` o por `v.consumption_id` da órdenes distintos.
  await enLotes(
    ids
      .slice(0, validados)
      .reverse()
      .map((id) =>
        sentenciaInsert('validations', valoresValidacion(id, jefe.usuario.id, 'aprobado')),
      ),
  );
  return ids;
}

beforeAll(async () => {
  [supervisor, otroSupervisor, jefe] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
  ]);
  const escena = await escenarioOrden(jefe, supervisor, { cantidad: 1_000_000 });
  orden = escena.orden;
  material = escena.material;
  ajena = (await escenarioOrden(jefe, otroSupervisor)).orden;
  sinAsignar = await nuevaOrden(jefe.usuario.id);
  await consumosValidados(supervisor, orden, CONSUMOS_ASIGNADA, VALIDADOS_ASIGNADA);
  await consumosValidados(otroSupervisor, ajena, 30, 30);
  await consumosValidados(supervisor, sinAsignar, CONSUMOS_PROPIOS_SIN_ASIGNAR, 20);
});

function contexto(s: SesionDeRol, rol: 'supervisor' | 'jefe'): Contexto {
  return {
    db: env.DB,
    actor: { id: s.usuario.id, rol },
    deviceId: s.deviceId,
    ahora: new Date().toISOString(),
    alertaReloj: false,
  };
}

async function plan(sql: string, parametros: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...parametros)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join(' | ');
}

describe('plan de consulta de las validaciones (EXPLAIN QUERY PLAN en la D1 local)', () => {
  const validaciones = descriptorDe('validations');

  it.each([
    ['supervisor, alcance inicial', 'supervisor', 'inicial', 'validations_consumption_id_unico'],
    ['jefe, alcance inicial', 'jefe', 'inicial', 'validations_consumption_id_unico'],
    ['supervisor, alcance orden', 'supervisor', 'orden', 'consumptions_order_id_id'],
  ] as const)(
    '%s: sigue un índice y no usa TEMP B-TREE FOR ORDER BY',
    async (_n, rol, alcance, indice) => {
      if (validaciones === undefined) {
        throw new Error('falta el descriptor de validations');
      }
      const s = rol === 'jefe' ? jefe : supervisor;
      const query = alcance === 'orden' ? { alcance, order_id: orden } : ({ alcance } as const);
      for (const ultimo of [null, '0']) {
        const { sql, parametros } = consultaDePagina(
          contexto(s, rol),
          validaciones,
          query,
          ultimo,
          501,
        );
        const detalle = await plan(sql, parametros);
        expect(detalle, detalle).not.toContain('TEMP B-TREE');
        expect(detalle, detalle).toContain(indice);
      }
    },
  );
});

describe('snapshot completo de un supervisor con más de 1000 entidades', () => {
  it('trae todo lo visible, sin repetir, con el mismo cursor y validaciones en el orden de su consumo', async () => {
    const { paginas, entidades } = await snapshotCompleto(supervisor.token, 'alcance=inicial');

    expect(entidades.length).toBeGreaterThan(1000);
    expect(paginas.length).toBeGreaterThanOrEqual(3);
    expect(new Set(paginas.map((p) => p.cursor)).size).toBe(1);
    expect(paginas.slice(0, -1).every((p) => p.entidades.length === MAX_ENTIDADES_SNAPSHOT)).toBe(
      true,
    );
    const claves = entidades.map((e) => `${e.entidad}:${e.id}`);
    expect(new Set(claves).size).toBe(claves.length);

    // Lo visible según la base (mismas reglas): consumos de la orden asignada + los propios.
    const esperadas = async (sql: string) =>
      (await env.DB.prepare(sql).bind(orden, supervisor.usuario.id).all<{ id: string }>()).results
        .map((f) => f.id)
        .sort();
    const visibles = `(c.order_id = ? OR c.registrado_por = ?)`;
    const consumos = await esperadas(`SELECT c.id FROM consumptions AS c WHERE ${visibles}`);
    const validaciones = await esperadas(
      `SELECT v.id FROM validations AS v JOIN consumptions AS c ON c.id = v.consumption_id WHERE ${visibles}`,
    );
    const de = (entidad: string) => entidades.filter((e) => e.entidad === entidad);
    expect(consumos).toHaveLength(CONSUMOS_ASIGNADA + CONSUMOS_PROPIOS_SIN_ASIGNAR);
    expect(
      de('consumptions')
        .map((e) => e.id)
        .sort(),
    ).toEqual(consumos);
    expect(validaciones).toHaveLength(VALIDADOS_ASIGNADA + 20);
    expect(
      de('validations')
        .map((e) => e.id)
        .sort(),
    ).toEqual(validaciones);
    // Nada de la orden ajena.
    expect(entidades.some((e) => e.datos.order_id === ajena)).toBe(false);

    // Las validaciones llegan en el orden del id de su consumo y cruzan páginas.
    const porConsumo = de('validations').map((e) => String(e.datos.consumption_id));
    expect(porConsumo).toEqual([...porConsumo].sort());
    const paginasConValidaciones = paginas.filter((p) =>
      p.entidades.some((e) => e.entidad === 'validations'),
    );
    expect(paginasConValidaciones.length).toBeGreaterThanOrEqual(2);
  });

  it('el snapshot de la orden también trae todo sin repetir', async () => {
    const { entidades } = await snapshotCompleto(
      supervisor.token,
      `alcance=orden&order_id=${orden}`,
    );
    const claves = entidades.map((e) => `${e.entidad}:${e.id}`);
    expect(new Set(claves).size).toBe(claves.length);
    expect(entidades.filter((e) => e.entidad === 'consumptions')).toHaveLength(CONSUMOS_ASIGNADA);
    expect(entidades.filter((e) => e.entidad === 'validations')).toHaveLength(VALIDADOS_ASIGNADA);
  });

  it('cada página hace pocas consultas a D1 (solo la entidad en curso y las que siguen si se agota)', async () => {
    let pagina: string | null = null;
    let paginas = 0;
    do {
      const { db, conteo } = dbConConteo();
      const ruta: string =
        pagina === null
          ? '/sync/snapshot?alcance=inicial'
          : `/sync/snapshot?alcance=inicial&pagina=${encodeURIComponent(pagina)}`;
      const respuesta = await llamarConDb(db, ruta, { token: supervisor.token });
      expect(respuesta.status).toBe(200);
      const cuerpo = await respuesta.json<{ siguiente_pagina: string | null }>();
      // 1 autenticación + 1 batch (MAX(seq)/época + entidad en curso) + ≤ 9 entidades siguientes.
      expect(conteo.llamadas, JSON.stringify(conteo)).toBeLessThanOrEqual(11);
      expect(conteo.ejecutadas).toBeLessThanOrEqual(13);
      pagina = cuerpo.siguiente_pagina;
      paginas += 1;
    } while (pagina !== null && paginas < 20);
    expect(pagina).toBeNull();
  });
});

describe('compatibilidad del token de página', () => {
  const viejo = (token: Record<string, unknown>) =>
    aBase64Url(new TextEncoder().encode(JSON.stringify(token)));

  it('un token sin versión (anterior a M5) de validations se rechaza con 400', async () => {
    await esperarError(
      await snapshotDe(
        supervisor.token,
        `alcance=inicial&pagina=${viejo({ cursor: 1, entidad: 'validations', ultimo_id: 'a' })}`,
      ),
      400,
      'VALIDACION',
    );
  });

  // A6 (ADR 0029): desde la versión 3 el token lleva `user_id` y `rol`; uno sin versión o de la
  // versión 2 (sin identidad) ya no vale para ninguna entidad: el cliente reinicia el snapshot.
  it('un token sin versión o de la versión 2 de otra entidad también se rechaza (A6)', async () => {
    for (const token of [
      viejo({ cursor: 1, entidad: 'materials', ultimo_id: 'a' }),
      viejo({ version: 2, cursor: 1, entidad: 'materials', ultimo_id: 'a' }),
    ]) {
      await esperarError(
        await snapshotDe(supervisor.token, `alcance=inicial&pagina=${token}`),
        400,
        'VALIDACION',
      );
    }
  });

  it('una versión desconocida se rechaza; la actual se acepta', async () => {
    await esperarError(
      await snapshotDe(
        supervisor.token,
        `alcance=inicial&pagina=${viejo({ version: 99, cursor: 1, entidad: 'materials', ultimo_id: 'a' })}`,
      ),
      400,
      'VALIDACION',
    );
    const actual = codificarPagina({
      cursor: 1,
      entidad: 'validations',
      ultimo_id: 'a',
      user_id: supervisor.usuario.id,
      rol: 'supervisor',
    });
    const r = await snapshotDe(supervisor.token, `alcance=inicial&pagina=${actual}`);
    expect(r.status).toBe(200);
  });
});

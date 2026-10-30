// Tarea 3.1 — Un lote de 25 mutaciones no excede los límites de D1 (docs/spec.md §6 Worker 2;
// docs/notas-plataforma.md): ≤ 1000 consultas por invocación y ≤ 100 parámetros por sentencia.
//
// Se cuenta con un proxy sobre `env.DB` que DELEGA cada llamada en la D1 local real (no es un mock:
// las sentencias se ejecutan de verdad y las pruebas comprueban sus efectos).
import { MAX_MUTACIONES_POR_LOTE, type ResultadoMutacion } from '@catmetal/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { escenarioOrden } from './fase2-consumos-helpers';
import { sesion, type SesionDeRol } from './fase2-helpers';
import {
  contar,
  crearConsumo,
  crearNovedadMut,
  dbConConteo,
  decidirMut,
  editarConsumoMut,
  llamarConDb,
  type MutacionPrueba,
  pushOk,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LIMITE_CONSULTAS = 1000;
const LIMITE_PARAMETROS = 100;

let supervisor: SesionDeRol;
let jefe: SesionDeRol;

beforeAll(async () => {
  [supervisor, jefe] = await Promise.all([sesion('supervisor'), sesion('jefe')]);
});

async function pushContado(s: SesionDeRol, mutaciones: MutacionPrueba[]) {
  const { db, conteo } = dbConConteo();
  const respuesta = await llamarConDb(db, '/sync/push', {
    token: s.token,
    body: { user_id: s.usuario.id, mutaciones },
  });
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  const { resultados } = await respuesta.json<{ resultados: ResultadoMutacion[] }>();
  return { resultados, conteo };
}

describe('lote de 25 mutaciones dentro de los límites de D1', () => {
  it('supervisor: 10 creaciones, 8 ediciones y 7 novedades', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 10_000 });
    const previos = await pushOk(
      supervisor.token,
      supervisor.usuario.id,
      Array.from({ length: 15 }, () => crearConsumo(orden, material)),
    );
    const ids = previos.map((r) => String(r.servidor?.id));
    const lote = [
      ...Array.from({ length: 10 }, () => crearConsumo(orden, material)),
      ...ids.slice(0, 8).map((id) => editarConsumoMut(id, 1)),
      ...ids.slice(8, 15).map((id) => crearNovedadMut(id)),
    ];
    expect(lote).toHaveLength(MAX_MUTACIONES_POR_LOTE);

    const { resultados, conteo } = await pushContado(supervisor, lote);

    expect(resultados.map((r) => r.resultado)).toEqual(Array(25).fill('aplicada'));
    expect(conteo.ejecutadas, JSON.stringify(conteo)).toBeLessThanOrEqual(LIMITE_CONSULTAS);
    expect(conteo.llamadas).toBeLessThanOrEqual(LIMITE_CONSULTAS);
    expect(conteo.maxParametros, JSON.stringify(conteo)).toBeLessThanOrEqual(LIMITE_PARAMETROS);
    expect(conteo.maxMarcadores, JSON.stringify(conteo)).toBeLessThanOrEqual(LIMITE_PARAMETROS);
    // El proxy contó de verdad (autenticación + lecturas + un batch por mutación).
    expect(conteo.llamadas).toBeGreaterThan(25);
    expect(conteo.ejecutadas).toBeGreaterThan(conteo.llamadas);
    expect(
      await contar(
        'sync_mutations',
        'mutation_id IN (SELECT value FROM json_each(?))',
        JSON.stringify(lote.map((m) => m.mutation_id)),
      ),
    ).toBe(25);
  });

  it('jefe: creaciones, novedades, aprobaciones y rechazos', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 10_000 });
    const previos = await pushOk(
      supervisor.token,
      supervisor.usuario.id,
      Array.from({ length: 12 }, () => crearConsumo(orden, material)),
    );
    const ids = previos.map((r) => String(r.servidor?.id));
    const lote = [
      ...Array.from({ length: 7 }, () => crearConsumo(orden, material)),
      ...ids.slice(0, 6).map((id) => crearNovedadMut(id)),
      ...ids.slice(6, 12).map((id, i) => decidirMut(i % 2 === 0 ? 'aprobar' : 'rechazar', id, 1)),
      ...ids.slice(0, 6).map((id) => decidirMut('aprobar', id, 1)),
    ];
    expect(lote).toHaveLength(MAX_MUTACIONES_POR_LOTE);

    const { resultados, conteo } = await pushContado(jefe, lote);

    expect(resultados.map((r) => r.resultado)).toEqual(Array(25).fill('aplicada'));
    expect(conteo.ejecutadas, JSON.stringify(conteo)).toBeLessThanOrEqual(LIMITE_CONSULTAS);
    expect(conteo.maxParametros, JSON.stringify(conteo)).toBeLessThanOrEqual(LIMITE_PARAMETROS);
    expect(conteo.maxMarcadores, JSON.stringify(conteo)).toBeLessThanOrEqual(LIMITE_PARAMETROS);
  });

  it('un lote de 25 rechazos (camino de error) también cabe en los límites', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const lote = Array.from({ length: 25 }, () =>
      // Edición de un consumo que no existe: NO_ENCONTRADO + búsqueda de creación rechazada.
      editarConsumoMut(crearConsumo(orden, material).payload.id as string, 1),
    );
    const { resultados, conteo } = await pushContado(supervisor, lote);
    expect(resultados.map((r) => r.code)).toEqual(Array(25).fill('NO_ENCONTRADO'));
    expect(conteo.ejecutadas, JSON.stringify(conteo)).toBeLessThanOrEqual(LIMITE_CONSULTAS);
    expect(conteo.maxParametros).toBeLessThanOrEqual(LIMITE_PARAMETROS);
  });
});

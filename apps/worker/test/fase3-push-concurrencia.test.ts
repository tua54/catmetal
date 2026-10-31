// Tarea 3.1 — Carreras reales entre pushes concurrentes (docs/spec.md §6 Worker 1; revisión H4).
//
// `dbConBarrera` retiene las escrituras de `sync_mutations` hasta que las dos peticiones llegan a
// ellas: ambas leyeron el mismo estado (ninguna mutación guardada) y escriben a la vez. La D1 local
// real las serializa; la idempotencia la tiene que garantizar la base (PK de `sync_mutations` y de
// la entidad dentro del mismo batch), no la lectura previa.
import { type ResultadoMutacion, uuidv7 } from '@catmetal/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { escenarioOrden } from './fase2-consumos-helpers';
import { asignar, nuevaOrden, sesion, type SesionDeRol } from './fase2-helpers';
import {
  contar,
  crearConsumo,
  crearNovedadMut,
  dbConBarrera,
  filaSync,
  llamarConDb,
  pushOk,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;
let jefe: SesionDeRol;

beforeAll(async () => {
  [supervisor, otroSupervisor, jefe] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
  ]);
});

async function pushCon(db: D1Database, s: SesionDeRol, mutaciones: unknown[]) {
  const respuesta = await llamarConDb(db, '/sync/push', {
    token: s.token,
    body: { user_id: s.usuario.id, mutaciones },
  });
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  return (await respuesta.json<{ resultados: ResultadoMutacion[] }>()).resultados;
}

describe('reintento concurrente del mismo lote', () => {
  it('dos pushes que escriben a la vez la misma creación: una sola fila y la misma respuesta', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material);
    const db = dbConBarrera(2, 'INSERT INTO sync_mutations');

    const [a, b] = await Promise.all([pushCon(db, supervisor, [m]), pushCon(db, supervisor, [m])]);

    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ resultado: 'aplicada', servidor: { id: m.payload.id } });
    expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(1);
    expect(await contar('sync_mutations', 'mutation_id = ?', m.mutation_id)).toBe(1);
    expect(
      await contar('audit_log', "entidad = 'consumptions' AND entidad_id = ?", m.payload.id),
    ).toBe(1);
  });

  it('dos pushes que guardan a la vez el mismo rechazo: una sola fila y la misma respuesta', async () => {
    const ajena = await nuevaOrden(jefe.usuario.id); // no asignada → rechazada
    const { material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(ajena, material);
    const db = dbConBarrera(2, 'ON CONFLICT (mutation_id) DO NOTHING');

    const [a, b] = await Promise.all([pushCon(db, supervisor, [m]), pushCon(db, supervisor, [m])]);

    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ resultado: 'rechazada', code: 'NO_ENCONTRADO' });
    expect(await contar('sync_mutations', 'mutation_id = ?', m.mutation_id)).toBe(1);
  });

  it('la novedad repetida en concurrencia tampoco duplica la novedad ni sus evidencias', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const [c] = await pushOk(supervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const n = crearNovedadMut(String(c?.servidor?.id));
    const db = dbConBarrera(2, 'INSERT INTO sync_mutations');

    const [a, b] = await Promise.all([pushCon(db, supervisor, [n]), pushCon(db, supervisor, [n])]);

    expect(a).toEqual(b);
    expect(a[0]?.resultado).toBe('aplicada');
    expect(await contar('incidents', 'id = ?', n.payload.id)).toBe(1);
    expect(await contar('evidences', 'incident_id = ?', n.payload.id)).toBe(1);
    expect((await filaSync(n.mutation_id))?.resultado).toBe('aplicada');
  });
});

describe('contención entre supervisores (tolerancia S7, revisión H4)', () => {
  it('dos creaciones a la vez sobre el mismo material: la que pierde la carrera se rearma y ambas se aplican con el acumulado correcto', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    await asignar(orden, otroSupervisor.usuario.id, jefe.usuario.id);
    const db = dbConBarrera(2, 'INSERT INTO sync_mutations');
    const ma = crearConsumo(orden, material, { cantidad: 60 });
    const mb = crearConsumo(orden, material, { cantidad: 60 });

    const [a, b] = await Promise.all([
      pushCon(db, supervisor, [ma]),
      pushCon(db, otroSupervisor, [mb]),
    ]);

    expect([a[0]?.resultado, b[0]?.resultado]).toEqual(['aplicada', 'aplicada']);
    // 60 + 60 = 120 > 105: exactamente uno (el segundo en escribir) requiere novedad.
    const marcas = [a[0]?.servidor?.requiere_novedad, b[0]?.servidor?.requiere_novedad];
    expect(marcas.sort()).toEqual([false, true]);
    expect(await contar('consumptions', 'order_id = ?', orden)).toBe(2);
  });
});

describe('mutaciones sin mutation_id', () => {
  it('una creación sin mutation_id (pero con id legible) arrastra a sus dependientes del lote', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const crear = crearConsumo(orden, material);
    const sinId: Record<string, unknown> = { ...crear };
    delete sinId.mutation_id;
    const resultados = await pushOk(supervisor.token, supervisor.usuario.id, [
      sinId,
      crearNovedadMut(String(crear.payload.id)),
      { mutation_id: uuidv7(), tipo: 'consumo.crear', client_created_at: 'x', payload: 'nada' },
    ]);
    expect(resultados.map((r) => r.code)).toEqual([
      'VALIDACION',
      'DEPENDENCIA_RECHAZADA',
      'VALIDACION',
    ]);
  });
});

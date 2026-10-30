// B12 (docs/correcciones-v1.1.md): presupuesto de consultas por invocación de `/sync/push`.
//
// D1 (Workers Paid) admite como máximo 1000 consultas por invocación. En contención, cada mutación
// puede gastar hasta `MAX_INTENTOS` intentos completos (lecturas del comando + su batch), así que un
// lote de 25 puede acercarse al límite. El push lleva un presupuesto y corta el lote limpiamente
// ANTES de agotarlo: las mutaciones que no alcanzó quedan sin resultado (el cliente las reenvía) y
// no se escribe nada de ellas.
//
// La contención es REAL: antes de cada batch de escritura otra "petición" registra de verdad un
// consumo del mismo material en la D1 local (el acumulado que leyó el comando deja de valer y la
// sentencia principal no aplica). Las consultas se cuentan con un proxy que delega en la D1 real
// (no es un mock: las sentencias se ejecutan y las pruebas comprueban sus efectos).
import { MAX_MUTACIONES_POR_LOTE, type ResultadoMutacion, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_INTENTOS } from '../src/dominio/consumos';
import {
  COSTO_MAXIMO_PASO,
  ErrorPresupuestoAgotado,
  LIMITE_CONSULTAS_D1,
  PRESUPUESTO_CONSULTAS_PUSH,
  PresupuestoConsultas,
} from '../src/sync/presupuesto';
import { escenarioOrden } from './fase2-consumos-helpers';
import { nuevoConsumo, sesion, type SesionDeRol, supervisorConDispositivo } from './fase2-helpers';
import { decidir } from './fixtures-db';
import {
  contar,
  crearConsumo,
  crearNovedadMut,
  dbConConteo,
  dbConInterferencia,
  filaSync,
  llamarConDb,
  type MutacionPrueba,
  pushOk,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let jefe: SesionDeRol;
/** Consultas de la invocación fuera del lote (autenticación, `marcarSincronizado`…). */
let fueraDelLote: number;

async function pushContado(db: D1Database, conteo: { ejecutadas: number }, mutaciones: unknown[]) {
  const respuesta = await llamarConDb(db, '/sync/push', {
    token: supervisor.token,
    body: { user_id: supervisor.usuario.id, mutaciones },
  });
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  const { resultados } = await respuesta.json<{ resultados: ResultadoMutacion[] }>();
  return { resultados, total: conteo.ejecutadas, delLote: conteo.ejecutadas - fueraDelLote };
}

beforeAll(async () => {
  [supervisor, jefe] = await Promise.all([sesion('supervisor'), sesion('jefe')]);
  // Una mutación sin `mutation_id` legible no consulta D1: lo contado es lo de fuera del lote.
  const { db, conteo } = dbConConteo();
  fueraDelLote = 0;
  const { resultados } = await pushContado(db, conteo, [{}]);
  expect(resultados).toMatchObject([{ resultado: 'rechazada', code: 'VALIDACION' }]);
  fueraDelLote = conteo.ejecutadas;
  expect(fueraDelLote + PRESUPUESTO_CONSULTAS_PUSH).toBeLessThanOrEqual(LIMITE_CONSULTAS_D1);
});

/** `db` que cuenta y en la que otra petición registra un consumo antes de los batches elegidos. */
function conContencion(orden: string, material: string, interferir: (batch: number) => boolean) {
  let batches = 0;
  const otro = supervisorConDispositivo();
  const db = dbConInterferencia('INSERT INTO sync_mutations', async () => {
    batches += 1;
    if (interferir(batches)) {
      const { id, deviceId } = await otro;
      await nuevoConsumo({
        orderId: orden,
        materialId: material,
        registradoPor: id,
        deviceId,
        cantidad: 1,
      });
    }
  });
  return dbConConteo(db);
}

describe('B12: presupuesto de consultas del push', () => {
  it('peor caso real (correcciones que aplican en su último intento): se corta antes del presupuesto y las restantes quedan sin resultado', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 1_000_000 });
    // `consumo.crear` con `corrige_a` es la creación con más lecturas por intento.
    const lote: MutacionPrueba[] = [];
    for (let i = 0; i < MAX_MUTACIONES_POR_LOTE; i += 1) {
      const original = await nuevoConsumo({
        orderId: orden,
        materialId: material,
        registradoPor: supervisor.usuario.id,
        deviceId: supervisor.deviceId,
        cantidad: 1,
      });
      await decidir(original, jefe.usuario.id, 'rechazado');
      lote.push(crearConsumo(orden, material, { corrige_a: original }));
    }
    // Interfiere en los intentos 1..MAX_INTENTOS-1 de cada mutación y deja pasar el último.
    const { db, conteo } = conContencion(orden, material, (n) => n % MAX_INTENTOS !== 0);

    const { resultados, total, delLote } = await pushContado(db, conteo, lote);

    const detalle = JSON.stringify({ total, delLote, procesadas: resultados.length });
    expect(total, detalle).toBeLessThanOrEqual(LIMITE_CONSULTAS_D1);
    expect(delLote, detalle).toBeLessThanOrEqual(PRESUPUESTO_CONSULTAS_PUSH);
    // El lote se cortó: las procesadas son un prefijo, todas aplicadas (en su último intento).
    expect(resultados.length, detalle).toBeGreaterThan(0);
    expect(resultados.length, detalle).toBeLessThan(MAX_MUTACIONES_POR_LOTE);
    expect(resultados.map((r) => r.indice)).toEqual(resultados.map((_, i) => i));
    expect(new Set(resultados.map((r) => r.resultado))).toEqual(new Set(['aplicada']));
    // El corte fue por presupuesto: no quedaba para otro paso.
    expect(delLote + COSTO_MAXIMO_PASO, detalle).toBeGreaterThan(PRESUPUESTO_CONSULTAS_PUSH);

    // Las cortadas no tienen resultado ni nada escrito: siguen pendientes en el cliente.
    const cortadas = lote.slice(resultados.length);
    for (const m of cortadas) {
      expect(await filaSync(m.mutation_id)).toBeNull();
      expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(0);
      expect(await contar('audit_log', 'entidad_id = ?', m.payload.id)).toBe(0);
    }
    for (const m of lote.slice(0, resultados.length)) {
      expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(1);
    }

    // Sin contención, el reenvío de las cortadas se aplica.
    const reenvio = await pushOk(supervisor.token, supervisor.usuario.id, cortadas);
    expect(reenvio.map((r) => r.resultado)).toEqual(cortadas.map(() => 'aplicada'));
  });

  it('contención permanente: la primera agota sus intentos y nada queda escrito', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 1_000_000 });
    const { db, conteo } = conContencion(orden, material, () => true);
    const lote = Array.from({ length: MAX_MUTACIONES_POR_LOTE }, () =>
      crearConsumo(orden, material),
    );

    const { resultados, delLote } = await pushContado(db, conteo, lote);

    expect(resultados).toEqual([]);
    expect(delLote).toBeLessThanOrEqual(PRESUPUESTO_CONSULTAS_PUSH);
    expect(await filaSync(lote[0]?.mutation_id ?? '')).toBeNull();
    expect(await contar('consumptions', 'id = ?', lote[0]?.payload.id)).toBe(0);
  });

  it('sin contención, un lote completo de las mutaciones más pesadas no se corta', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 1_000_000 });
    const [base] = await pushOk(supervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    // Novedades con el máximo de evidencias: el batch más largo por mutación.
    const lote = Array.from({ length: MAX_MUTACIONES_POR_LOTE }, () => {
      const m = crearNovedadMut(String(base?.servidor?.id));
      m.payload.evidencias = Array.from({ length: 5 }, () => ({
        id: uuidv7(),
        mime: 'image/jpeg',
        tamano_bytes: 1234,
        sha256: 'a'.repeat(64),
      }));
      return m;
    });
    const { db, conteo } = dbConConteo();

    const { resultados, delLote } = await pushContado(db, conteo, lote);

    expect(resultados.map((r) => r.resultado)).toEqual(lote.map(() => 'aplicada'));
    expect(delLote + COSTO_MAXIMO_PASO).toBeLessThanOrEqual(PRESUPUESTO_CONSULTAS_PUSH);
  });
});

describe('B12: PresupuestoConsultas (con la D1 local real)', () => {
  it('cuenta cada ejecución y cada sentencia de un batch, y exige el costo de un paso', async () => {
    const presupuesto = new PresupuestoConsultas(10);
    const db = presupuesto.envolver(env.DB);
    const uno = () => db.prepare('SELECT ? AS x').bind(1);

    expect(await uno().first('x')).toBe(1);
    expect(await uno().first()).toEqual({ x: 1 });
    expect((await uno().all()).results).toEqual([{ x: 1 }]);
    expect((await uno().run()).success).toBe(true);
    expect(await uno().raw()).toEqual([[1]]);
    expect(await uno().raw({ columnNames: true })).toEqual([['x'], [1]]);
    expect(presupuesto.usadas).toBe(6);
    expect((await db.batch([uno(), uno(), db.prepare('SELECT 2 AS y')])).length).toBe(3);
    expect(presupuesto.usadas).toBe(9);

    presupuesto.exigir(1);
    expect(() => {
      presupuesto.exigir(2);
    }).toThrow(ErrorPresupuestoAgotado);
    expect(() => {
      presupuesto.exigir();
    }).toThrow(ErrorPresupuestoAgotado);
  });

  it('no ofrece exec, sesiones ni dump (escaparían del conteo)', async () => {
    const db = new PresupuestoConsultas().envolver(env.DB);
    await expect(db.exec('SELECT 1')).rejects.toThrow('no está disponible');
    await expect(db.dump()).rejects.toThrow('no está disponible');
    expect(() => db.withSession()).toThrow('no está disponible');
  });
});

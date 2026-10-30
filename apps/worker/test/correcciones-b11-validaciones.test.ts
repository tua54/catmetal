// B11 (docs/correcciones-v1.1.md): aprobar y rechazar no dependen de cómo D1 cuenta `meta.changes`.
//
// Antes, el plan de una validación daba por aplicada la principal si el INSERT en `validations`
// devolvía `meta.changes = 2` (la validación + el consumo que actualiza el trigger
// `validations_aplica_decision`; docs/notas-plataforma.md). Si D1 dejara de contar las filas de los
// triggers (o contara otras), una validación aplicada se tomaría por una carrera, o al revés. Ahora
// la principal es una LECTURA en el mismo batch, justo después del INSERT, que comprueba la
// validación propia y el consumo ya decidido (estado, versión y hora): se juzga por sus filas.
//
// Las pruebas de integración usan la D1 local real; el envoltorio solo REESCRIBE el `meta.changes`
// que devuelve D1 para el INSERT en `validations` (simula otro conteo), sin tocar lo que se ejecuta.
import { type ResultadoValidacion, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Contexto } from '../src/dominio/contexto';
import { ejecutarConReintento } from '../src/dominio/consumos';
import { ejecutarPlan, principalAplico, type SentenciaPrincipal } from '../src/dominio/plan';
import { aprobarConsumo, rechazarConsumo } from '../src/dominio/validaciones';
import { cuerpoConsumo, escenarioOrden, registrarOk } from './fase2-consumos-helpers';
import { auditoriaDesde, contextoDe, sesion, type SesionDeRol, ultimoSeq } from './fase2-helpers';
import { decidirMut, llamarConDb } from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let jefe: SesionDeRol;
let supervisor: SesionDeRol;

beforeAll(async () => {
  [jefe, supervisor] = await Promise.all([sesion('jefe'), sesion('supervisor')]);
});

/** Resultado de D1 con `meta.changes` y filas dados (para la función pura). */
function resultado(changes: number, filas: number): D1Result {
  return {
    success: true,
    results: Array.from({ length: filas }, () => ({ aplicada: 1 })),
    meta: {
      changes,
      duration: 0,
      last_row_id: 0,
      changed_db: changes > 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
    },
  };
}

/**
 * `env.DB` que ejecuta todo en la D1 real y luego reescribe el `meta.changes` del resultado de cada
 * `INSERT INTO validations` con `changes(real)`. Antes de ese batch puede ejecutar `antes()`.
 */
function dbConConteoDeCambios(
  changes: (real: number) => number,
  antes: () => Promise<void> = () => Promise.resolve(),
): D1Database {
  const real = env.DB;
  const sqlDe = new WeakMap<object, string>();
  const instrumentar = (sentencia: D1PreparedStatement, sql: string): D1PreparedStatement => {
    sqlDe.set(sentencia, sql);
    const bind = sentencia.bind.bind(sentencia);
    Object.defineProperty(sentencia, 'bind', {
      value: (...valores: unknown[]) => instrumentar(bind(...valores), sql),
    });
    return sentencia;
  };
  const esInsert = (s: D1PreparedStatement) =>
    (sqlDe.get(s) ?? '').trimStart().startsWith('INSERT INTO validations');
  return new Proxy(real, {
    get(objetivo, propiedad) {
      if (propiedad === 'prepare') {
        return (sql: string) => instrumentar(objetivo.prepare(sql), sql);
      }
      if (propiedad === 'batch') {
        return async (sentencias: D1PreparedStatement[]) => {
          if (sentencias.some(esInsert)) {
            await antes();
          }
          const resultados = await objetivo.batch(sentencias);
          sentencias.forEach((s, i) => {
            const r = resultados[i];
            if (esInsert(s) && r !== undefined) {
              r.meta.changes = changes(r.meta.changes);
            }
          });
          return resultados;
        };
      }
      const valor: unknown = Reflect.get(objetivo, propiedad);
      return typeof valor === 'function'
        ? (valor as (...a: unknown[]) => unknown).bind(objetivo)
        : valor;
    },
  });
}

async function consumoPendiente(): Promise<string> {
  const { orden, material } = await escenarioOrden(jefe, supervisor);
  return (await registrarOk(supervisor.token, cuerpoConsumo(orden, material))).id;
}

async function estadoDe(id: string) {
  return env.DB.prepare('SELECT estado, version FROM consumptions WHERE id = ?')
    .bind(id)
    .first<{ estado: string; version: number }>();
}

async function ctxJefe(db: D1Database): Promise<Contexto> {
  return { ...(await contextoDe('jefe')), db };
}

describe('B11: principalAplico (función pura)', () => {
  it('por filas: aplicó con 1 fila, sea cual sea meta.changes (0, 1, 2 o 3)', () => {
    const principal: SentenciaPrincipal = { indice: 1, filasEsperadas: 1 };
    for (const changes of [0, 1, 2, 3]) {
      expect(principalAplico(principal, [resultado(changes, 0), resultado(0, 1)])).toBe(true);
      expect(principalAplico(principal, [resultado(changes, 0), resultado(changes, 0)])).toBe(
        false,
      );
    }
    expect(principalAplico(principal, [resultado(1, 0)])).toBe(false);
  });

  it('por cambios (las demás sentencias principales): igual que antes', () => {
    const principal: SentenciaPrincipal = { indice: 0, cambiosEsperados: 1 };
    expect(principalAplico(principal, [resultado(1, 0)])).toBe(true);
    expect(principalAplico(principal, [resultado(0, 0)])).toBe(false);
    expect(principalAplico(principal, [resultado(2, 0)])).toBe(false);
    expect(principalAplico(principal, [])).toBe(false);
  });

  it('aprobar y rechazar usan la lectura en el mismo batch, no meta.changes', async () => {
    const ctx = await ctxJefe(env.DB);
    const consumo = await consumoPendiente();
    const entrada = { consumption_id: consumo, version: 1, client_created_at: ctx.ahora };
    for (const plan of [
      await aprobarConsumo(ctx, { ...entrada, id: uuidv7() }),
      await rechazarConsumo(ctx, { ...entrada, id: uuidv7(), motivo: 'Lote equivocado' }),
    ]) {
      expect(plan.principal).toEqual({ indice: 1, filasEsperadas: 1 });
      expect('cambiosEsperados' in (plan.principal ?? {})).toBe(false);
    }
  });
});

describe('B11: con la D1 local real y otro conteo de meta.changes', () => {
  it.each([
    ['sin contar las filas del trigger (1)', () => 1],
    ['contando las filas del trigger (2)', () => 2],
    ['contando de más (3)', () => 3],
  ])('aprobar aplica %s', async (_nombre, changes) => {
    const consumo = await consumoPendiente();
    const ctx = await ctxJefe(dbConConteoDeCambios(changes));
    const antes = await ultimoSeq();

    const r = await ejecutarConReintento(ctx.db, () =>
      aprobarConsumo(ctx, {
        consumption_id: consumo,
        id: uuidv7(),
        version: 1,
        client_created_at: ctx.ahora,
      }),
    );

    expect(r.consumo).toMatchObject({ id: consumo, estado: 'aprobado', version: 2 });
    expect(await estadoDe(consumo)).toEqual({ estado: 'aprobado', version: 2 });
    expect((await auditoriaDesde(antes)).map((f) => f.accion).sort()).toEqual([
      'consumo.aprobar',
      'validacion.crear',
    ]);
  });

  it('rechazar por REST y por /sync/push aplica aunque D1 no cuente las filas del trigger', async () => {
    const db = dbConConteoDeCambios(() => 1);
    const porRest = await consumoPendiente();
    const id = uuidv7();
    const rest = await llamarConDb(db, `/consumptions/${porRest}/reject`, {
      token: jefe.token,
      body: { id, version: 1, client_created_at: new Date().toISOString(), motivo: 'No cuadra' },
    });
    expect(rest.status, await rest.clone().text()).toBe(201);
    expect((await rest.json<ResultadoValidacion>()).validacion.id).toBe(id);
    expect(await estadoDe(porRest)).toEqual({ estado: 'rechazado', version: 2 });

    const porPush = await consumoPendiente();
    const respuesta = await llamarConDb(db, '/sync/push', {
      token: jefe.token,
      body: { user_id: jefe.usuario.id, mutaciones: [decidirMut('rechazar', porPush, 1)] },
    });
    expect(respuesta.status).toBe(200);
    const { resultados } = await respuesta.json<{ resultados: { resultado: string }[] }>();
    expect(resultados).toMatchObject([{ resultado: 'aplicada' }]);
    expect(await estadoDe(porPush)).toEqual({ estado: 'rechazado', version: 2 });
  });

  it('si la validación no se insertó, no se da por aplicada aunque meta.changes diga 2', async () => {
    const consumo = await consumoPendiente();
    // Otra petición cambia la versión justo antes del batch: el INSERT condicionado no inserta.
    const db = dbConConteoDeCambios(
      () => 2,
      async () => {
        await env.DB.prepare('UPDATE consumptions SET version = version + 1 WHERE id = ?')
          .bind(consumo)
          .run();
      },
    );
    const ctx = await ctxJefe(db);
    const plan = await aprobarConsumo(ctx, {
      consumption_id: consumo,
      id: uuidv7(),
      version: 1,
      client_created_at: ctx.ahora,
    });
    const antes = await ultimoSeq();

    await expect(ejecutarPlan(db, plan)).rejects.toBe(plan.siNoAplica);

    expect(await estadoDe(consumo)).toEqual({ estado: 'pendiente', version: 2 });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });
});

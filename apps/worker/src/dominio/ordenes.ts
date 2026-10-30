// Órdenes de producción (docs/spec.md §3, §7; docs/plan-fase-2.md "Órdenes").
//
// - Ver: supervisor solo las asignadas activas (lo demás → 404); jefe y admin todas.
// - Crear / iniciar / finalizar: jefe y admin (`ordenes.gestionar`). Transiciones:
//   planeada → en_proceso (`start`); en_proceso → finalizada (`finish`). No se expone cancelar (P16).
// - Toda escritura es un plan con sentencia principal guardada y auditoría condicionada (`plan.ts`),
//   y toda fila de auditoría lleva `order_id` (ADR 0010).

import {
  type AvanceMaterial,
  type ConsumoFueraDePlan,
  type CrearOrden,
  type DetalleOrden,
  type EstadoOrden,
  excedeTolerancia,
  type FinalizarOrden,
  LIMITE_PAGINA_DEFECTO,
  type ListaOrdenes,
  type ListarOrdenesQuery,
  type MaterialPlaneado,
  type Orden,
  type OrdenCreada,
  redondear6,
  sonConvertibles,
  type SupervisorAsignado,
  type Unidad,
  uuidv7,
} from '@catmetal/shared';
import { type CondicionSql, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import type { Contexto } from './contexto';
import type { PlanDeEscritura } from './plan';
import { sentenciaLeerTolerancia, toleranciaDeResultado } from './settings';
import { filtroOrdenVisible, puedeVerOrden } from './visibilidad';

export const COLUMNAS_ORDEN =
  'id, codigo, linea, estado, fecha_inicio, fecha_fin, creada_por, created_at, updated_at';

/** Fila de `production_orders` (no tiene booleanos: es igual a `Orden`). */
export type FilaOrden = Orden;

export async function buscarOrden(db: D1Database, id: string): Promise<FilaOrden | null> {
  return db
    .prepare(`SELECT ${COLUMNAS_ORDEN} FROM production_orders WHERE id = ?`)
    .bind(id)
    .first<FilaOrden>();
}

/** Orden visible para el actor, o 404 (no se revela si existe). */
async function ordenVisible(ctx: Contexto, id: string): Promise<FilaOrden> {
  const orden = (await puedeVerOrden(ctx, id)) ? await buscarOrden(ctx.db, id) : null;
  if (orden === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  return orden;
}

/** Orden existente (para jefe y admin, que ven todas), o 404. */
async function ordenExistente(ctx: Contexto, id: string): Promise<FilaOrden> {
  const orden = await buscarOrden(ctx.db, id);
  if (orden === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  return orden;
}

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

/** `GET /orders`: cursor por id (UUID v7, orden cronológico), filtro opcional por estado. */
export async function listarOrdenes(
  ctx: Contexto,
  query: ListarOrdenesQuery,
): Promise<ListaOrdenes> {
  const limite = query.limite ?? LIMITE_PAGINA_DEFECTO;
  const visible = filtroOrdenVisible(ctx, 'o.id');
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNAS_ORDEN} FROM production_orders AS o
       WHERE o.id > ? AND (? IS NULL OR o.estado = ?) AND ${visible.sql}
       ORDER BY o.id LIMIT ?`,
    )
    .bind(
      query.cursor ?? '',
      query.estado ?? null,
      query.estado ?? null,
      ...visible.parametros,
      limite + 1,
    )
    .all<FilaOrden>();
  const pagina = results.slice(0, limite);
  const ultimo = pagina.at(-1);
  return {
    ordenes: pagina,
    siguiente_cursor: results.length > limite && ultimo !== undefined ? ultimo.id : null,
  };
}

interface FilaAvance {
  material_id: string;
  codigo: string;
  nombre: string;
  unidad: Unidad;
  cantidad_planeada: number;
  consumido: number;
}

type FilaFueraDePlan = ConsumoFueraDePlan;

/** Supervisores con asignación activa de la orden, ordenados por nombre. */
export function sentenciaSupervisoresActivos(db: D1Database, orderId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT s.user_id, u.nombre, s.asignado_por, s.created_at, s.updated_at
       FROM order_supervisors AS s JOIN users AS u ON u.id = s.user_id
       WHERE s.order_id = ? AND s.activo = 1
       ORDER BY u.nombre, s.user_id`,
    )
    .bind(orderId);
}

/** `consumido / planeada × 100` con 2 decimales (`planeada > 0` por CHECK). */
function porcentaje(consumido: number, planeada: number): number {
  return Math.round((consumido / planeada) * 10_000) / 100;
}

/**
 * `GET /orders/:id`: la orden con su plan y el consumo vs plan por material. `consumido` es la suma
 * de `cantidad_en_unidad_plan` de los consumos NO rechazados (pendientes y aprobados), igual que el
 * acumulado de la tolerancia (S7). Las lecturas van en un solo batch: una foto consistente.
 */
export async function detalleOrden(ctx: Contexto, id: string): Promise<DetalleOrden> {
  const orden = await ordenVisible(ctx, id);
  const [avance, fuera, supervisores, tolerancia] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT p.material_id, m.codigo, m.nombre, p.unidad, p.cantidad_planeada,
           (SELECT total(c.cantidad_en_unidad_plan) FROM consumptions AS c
            WHERE c.order_id = p.order_id AND c.material_id = p.material_id
              AND c.estado <> 'rechazado') AS consumido
         FROM order_planned_materials AS p JOIN materials AS m ON m.id = p.material_id
         WHERE p.order_id = ?
         ORDER BY m.codigo, p.material_id`,
      )
      .bind(id),
    ctx.db
      .prepare(
        `SELECT c.material_id, m.codigo, m.nombre, m.unidad,
           total(c.cantidad_en_unidad_plan) AS consumido
         FROM consumptions AS c JOIN materials AS m ON m.id = c.material_id
         WHERE c.order_id = ? AND c.estado <> 'rechazado'
           AND NOT EXISTS (SELECT 1 FROM order_planned_materials AS p
                           WHERE p.order_id = c.order_id AND p.material_id = c.material_id)
         GROUP BY c.material_id, m.codigo, m.nombre, m.unidad
         ORDER BY m.codigo, c.material_id`,
      )
      .bind(id),
    sentenciaSupervisoresActivos(ctx.db, id),
    sentenciaLeerTolerancia(ctx.db),
  ]);
  const toleranciaPct = toleranciaDeResultado(tolerancia);
  const materiales: AvanceMaterial[] = ((avance?.results ?? []) as FilaAvance[]).map((fila) => {
    const consumido = redondear6(fila.consumido);
    return {
      ...fila,
      consumido,
      porcentaje: porcentaje(consumido, fila.cantidad_planeada),
      excede_tolerancia: excedeTolerancia({
        planeada: fila.cantidad_planeada,
        consumidaAcumulada: consumido,
        toleranciaPct,
      }),
    };
  });
  return {
    ...orden,
    tolerancia_pct: toleranciaPct,
    materiales,
    materiales_fuera_de_plan: ((fuera?.results ?? []) as FilaFueraDePlan[]).map((fila) => ({
      ...fila,
      consumido: redondear6(fila.consumido),
    })),
    supervisores: (supervisores?.results ?? []) as SupervisorAsignado[],
  };
}

// ---------------------------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------------------------

function auditarOrden(
  ctx: Contexto,
  accion: string,
  antes: FilaOrden | null,
  despues: FilaOrden & { force?: boolean; pendientes?: number },
  aplicada: CondicionSql,
): D1PreparedStatement {
  return sentenciaAuditoriaCondicional(
    ctx.db,
    {
      entidad: 'production_orders',
      entidad_id: despues.id,
      accion,
      order_id: despues.id,
      actor_id: ctx.actor.id,
      device_id: ctx.deviceId,
      antes: antes === null ? null : { ...antes },
      despues: { ...despues },
      server_at: ctx.ahora,
      alerta_reloj: ctx.alertaReloj,
    },
    aplicada,
  );
}

interface FilaMaterialPlan {
  id: string;
  unidad: Unidad;
  activo: number;
}

/**
 * `POST /orders`: la orden nace `planeada` con sus materiales planeados. Cada material debe existir
 * (si no, 400 `VALIDACION`), estar activo (`MATERIAL_INACTIVO`) y su unidad ser convertible a la
 * del plan (`UNIDAD_INCOMPATIBLE`, S11).
 *
 * Batch: (0) INSERT de la orden condicionado a que todos los materiales sigan activos (principal);
 * después, condicionados a que la orden se insertó, su auditoría y cada material planeado con la
 * suya (`entidad_id = '<order_id>:<material_id>'`). Un código repetido (UNIQUE) o un id del cliente
 * repetido (PK) revierten todo el batch: 409 `CONFLICTO` / `ID_DUPLICADO`.
 */
export async function crearOrden(
  ctx: Contexto,
  entrada: CrearOrden,
): Promise<PlanDeEscritura<OrdenCreada>> {
  const idsMateriales = entrada.materiales.map((m) => m.material_id);
  const listaIds = JSON.stringify(idsMateriales);
  const { results } = await ctx.db
    .prepare(
      'SELECT id, unidad, activo FROM materials WHERE id IN (SELECT value FROM json_each(?))',
    )
    .bind(listaIds)
    .all<FilaMaterialPlan>();
  const porId = new Map(results.map((fila) => [fila.id, fila]));

  const inexistentes = entrada.materiales.flatMap((m, i) =>
    porId.has(m.material_id)
      ? []
      : [{ campo: `materiales.${i}.material_id`, mensaje: 'El material no existe.' }],
  );
  if (inexistentes.length > 0) {
    throw new ErrorApi('VALIDACION', inexistentes);
  }
  for (const [i, planeado] of entrada.materiales.entries()) {
    const material = porId.get(planeado.material_id);
    if (material?.activo !== 1) {
      throw new ErrorApi('MATERIAL_INACTIVO', {
        campo: `materiales.${i}.material_id`,
        material_id: planeado.material_id,
      });
    }
    if (!sonConvertibles(planeado.unidad, material.unidad)) {
      throw new ErrorApi('UNIDAD_INCOMPATIBLE', {
        campo: `materiales.${i}.unidad`,
        material_id: planeado.material_id,
        unidad: planeado.unidad,
        unidad_material: material.unidad,
      });
    }
  }

  const orden: FilaOrden = {
    id: entrada.id ?? uuidv7(),
    codigo: entrada.codigo,
    linea: entrada.linea,
    estado: 'planeada',
    fecha_inicio: null,
    fecha_fin: null,
    creada_por: ctx.actor.id,
    created_at: ctx.ahora,
    updated_at: ctx.ahora,
  };
  const planeados: MaterialPlaneado[] = entrada.materiales.map((m) => ({
    order_id: orden.id,
    material_id: m.material_id,
    cantidad_planeada: m.cantidad_planeada,
    unidad: m.unidad,
  }));
  // La orden "es nuestra" si existe con este id, código y hora (un id repetido falla por PK antes).
  const aplicada: CondicionSql = {
    sql: 'EXISTS (SELECT 1 FROM production_orders WHERE id = ? AND codigo = ? AND created_at = ?)',
    parametros: [orden.id, orden.codigo, ctx.ahora],
  };

  const sentencias: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO production_orders (${COLUMNAS_ORDEN})
         SELECT ?, ?, ?, 'planeada', NULL, NULL, ?, ?, ?
         WHERE (SELECT count(*) FROM materials
                WHERE activo = 1 AND id IN (SELECT value FROM json_each(?))) = ?`,
      )
      .bind(
        orden.id,
        orden.codigo,
        orden.linea,
        orden.creada_por,
        ctx.ahora,
        ctx.ahora,
        listaIds,
        idsMateriales.length,
      ),
    auditarOrden(ctx, 'orden.crear', null, orden, aplicada),
  ];
  for (const planeado of planeados) {
    sentencias.push(
      ctx.db
        .prepare(
          `INSERT INTO order_planned_materials
             (order_id, material_id, cantidad_planeada, unidad, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE ${aplicada.sql}`,
        )
        .bind(
          planeado.order_id,
          planeado.material_id,
          planeado.cantidad_planeada,
          planeado.unidad,
          ctx.ahora,
          ctx.ahora,
          ...aplicada.parametros,
        ),
      sentenciaAuditoriaCondicional(
        ctx.db,
        {
          entidad: 'order_planned_materials',
          entidad_id: `${orden.id}:${planeado.material_id}`,
          accion: 'orden.planear_material',
          order_id: orden.id,
          actor_id: ctx.actor.id,
          device_id: ctx.deviceId,
          despues: { ...planeado, created_at: ctx.ahora, updated_at: ctx.ahora },
          server_at: ctx.ahora,
          alerta_reloj: ctx.alertaReloj,
        },
        aplicada,
      ),
    );
  }
  return {
    sentencias,
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: { ...orden, materiales: planeados },
  };
}

function exigirEstado(orden: FilaOrden, esperado: EstadoOrden): void {
  if (orden.estado !== esperado) {
    throw new ErrorApi('ESTADO_ORDEN_INVALIDO', { estado: orden.estado, requerido: esperado });
  }
}

/** `POST /orders/:id/start`: planeada → en_proceso, con `fecha_inicio = ahora`. */
export async function iniciarOrden(ctx: Contexto, id: string): Promise<PlanDeEscritura<Orden>> {
  const actual = await ordenExistente(ctx, id);
  exigirEstado(actual, 'planeada');
  const nueva: FilaOrden = {
    ...actual,
    estado: 'en_proceso',
    fecha_inicio: ctx.ahora,
    updated_at: ctx.ahora,
  };
  return {
    sentencias: [
      ctx.db
        .prepare(
          `UPDATE production_orders SET estado = 'en_proceso', fecha_inicio = ?, updated_at = ?
           WHERE id = ? AND estado = 'planeada'`,
        )
        .bind(ctx.ahora, ctx.ahora, id),
      auditarOrden(ctx, 'orden.iniciar', actual, nueva, {
        sql: `EXISTS (SELECT 1 FROM production_orders WHERE id = ? AND estado = 'en_proceso' AND fecha_inicio = ?)`,
        parametros: [id, ctx.ahora],
      }),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: nueva,
  };
}

/**
 * `POST /orders/:id/finish`: en_proceso → finalizada, con `fecha_fin = ahora`. Si quedan consumos
 * `pendiente`, 409 `ORDEN_CON_PENDIENTES` con `details.pendientes`, salvo `force: true`; la
 * auditoría registra siempre `force` y el número de pendientes. El UPDATE se guarda con el estado
 * y con el número de pendientes leído, para que la auditoría diga exactamente lo que se forzó.
 */
export async function finalizarOrden(
  ctx: Contexto,
  id: string,
  entrada: FinalizarOrden,
): Promise<PlanDeEscritura<Orden>> {
  const actual = await ordenExistente(ctx, id);
  exigirEstado(actual, 'en_proceso');
  const fila = await ctx.db
    .prepare(
      `SELECT count(*) AS pendientes FROM consumptions WHERE order_id = ? AND estado = 'pendiente'`,
    )
    .bind(id)
    .first<{ pendientes: number }>();
  const pendientes = fila?.pendientes ?? 0;
  const force = entrada.force === true;
  if (pendientes > 0 && !force) {
    throw new ErrorApi('ORDEN_CON_PENDIENTES', { pendientes });
  }
  const nueva: FilaOrden = {
    ...actual,
    estado: 'finalizada',
    fecha_fin: ctx.ahora,
    updated_at: ctx.ahora,
  };
  return {
    sentencias: [
      ctx.db
        .prepare(
          `UPDATE production_orders SET estado = 'finalizada', fecha_fin = ?, updated_at = ?
           WHERE id = ? AND estado = 'en_proceso'
             AND (SELECT count(*) FROM consumptions
                  WHERE order_id = ? AND estado = 'pendiente') = ?`,
        )
        .bind(ctx.ahora, ctx.ahora, id, id, pendientes),
      auditarOrden(
        ctx,
        'orden.finalizar',
        actual,
        { ...nueva, force, pendientes },
        {
          sql: `EXISTS (SELECT 1 FROM production_orders WHERE id = ? AND estado = 'finalizada' AND fecha_fin = ?)`,
          parametros: [id, ctx.ahora],
        },
      ),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: nueva,
  };
}

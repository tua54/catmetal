// Reglas de datos de lectura (docs/spec.md §3; ADR 0005 regla 2; P9).
//
// - Jefe y admin (`ordenes.ver_todas`) ven todas las órdenes y todos los consumos.
// - El supervisor ve solo las órdenes con una asignación ACTIVA y, dentro de ellas, todos sus
//   consumos (P9). Además ve siempre los consumos que él registró, aunque haya perdido la asignación.
// - Lo que no es visible responde 404 `NO_ENCONTRADO` (no se revela que existe).
//
// La visibilidad se calcula con el estado ACTUAL (rol y asignaciones activas) en cada petición.

import { tienePermiso } from '@catmetal/shared';
import type { CondicionSql } from '../auditoria/auditar';
import type { Contexto } from './contexto';

/** Indica si el actor ve todas las órdenes (jefe y admin). */
export function veTodasLasOrdenes(ctx: Contexto): boolean {
  return tienePermiso(ctx.actor.rol, 'ordenes.ver_todas');
}

export type OrdenesVisibles =
  | { todas: true }
  | {
      todas: false;
      /** Órdenes con asignación activa del supervisor. */
      ids: ReadonlySet<string>;
    };

/** Órdenes visibles para el actor (para filtrar en memoria, por ejemplo en `/sync/pull`). */
export async function ordenesVisibles(ctx: Contexto): Promise<OrdenesVisibles> {
  if (veTodasLasOrdenes(ctx)) {
    return { todas: true };
  }
  const { results } = await ctx.db
    .prepare('SELECT order_id FROM order_supervisors WHERE user_id = ? AND activo = 1')
    .bind(ctx.actor.id)
    .all<{ order_id: string }>();
  return { todas: false, ids: new Set(results.map((fila) => fila.order_id)) };
}

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * Condición SQL "la orden de `columnaOrderId` es visible para el actor", para el `WHERE` de un
 * listado. `columnaOrderId` es un nombre de columna del código (por ejemplo `o.id`), nunca un dato
 * del usuario.
 */
export function filtroOrdenVisible(ctx: Contexto, columnaOrderId: string): CondicionSql {
  if (!IDENTIFICADOR.test(columnaOrderId)) {
    throw new Error(`Nombre de columna no válido: ${columnaOrderId}`);
  }
  if (veTodasLasOrdenes(ctx)) {
    return { sql: '1 = 1', parametros: [] };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM order_supervisors AS vis WHERE vis.order_id = ${columnaOrderId} AND vis.user_id = ? AND vis.activo = 1)`,
    parametros: [ctx.actor.id],
  };
}

/**
 * Indica si el actor puede ver la orden. Para jefe y admin es `true` sin consultar (la existencia
 * la comprueba el llamador); para el supervisor exige una asignación activa.
 */
export async function puedeVerOrden(ctx: Contexto, orderId: string): Promise<boolean> {
  if (veTodasLasOrdenes(ctx)) {
    return true;
  }
  const fila = await ctx.db
    .prepare(
      'SELECT 1 AS visible FROM order_supervisors WHERE order_id = ? AND user_id = ? AND activo = 1',
    )
    .bind(orderId, ctx.actor.id)
    .first<{ visible: number }>();
  return fila !== null;
}

/**
 * Indica si el actor puede ver un consumo (y su novedad, evidencias y validación): jefe y admin
 * siempre; el supervisor si lo registró él (ADR 0005 regla 2) o si tiene la orden asignada (P9).
 */
export async function puedeVerConsumo(
  ctx: Contexto,
  consumo: { order_id: string; registrado_por: string },
): Promise<boolean> {
  if (veTodasLasOrdenes(ctx) || consumo.registrado_por === ctx.actor.id) {
    return true;
  }
  return puedeVerOrden(ctx, consumo.order_id);
}

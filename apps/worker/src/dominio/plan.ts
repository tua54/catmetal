// Plan de escritura de un comando de dominio y su ejecutor (docs/plan-fase-2.md; ADR 0010; revisión
// de esquema H2).
//
// Patrón "sentencia principal + cadena condicional":
//
// 1. El comando lee y valida, y arma las sentencias SIN ejecutarlas.
// 2. La sentencia PRINCIPAL lleva en su `WHERE` las condiciones que el comando leyó (estado,
//    versión, acumulado…). Si otra petición cambió algo entre la lectura y la escritura, la principal
//    no aplica (`changes` distinto del esperado) en lugar de chocar con un trigger.
// 3. TODO lo que va después en el batch (auditoría, filas dependientes y, en `/sync/push`, la fila de
//    `sync_mutations` como `aplicada`) se escribe con `INSERT … SELECT … WHERE EXISTS (<la principal
//    aplicó>)` o con `UPDATE … WHERE … AND EXISTS (…)`. Así, si la principal no aplicó, ninguna otra
//    sentencia escribe nada: no queda nada parcial aunque el batch "termine bien".
// 4. `ejecutarPlan` ejecuta el batch (atómico en D1), comprueba `meta.changes` de la principal y, si
//    no aplicó, lanza el error del plan (por defecto 409 `CONFLICTO`). Un error de restricción o de
//    trigger revierte el batch entero y se traduce con `traducirErrorD1`, nunca un 500.
//
// Uso desde `/sync/push` (Fase 3): `ejecutarPlan(db, plan, [sentenciaSyncMutation])`. Las sentencias
// adicionales se agregan AL FINAL (no cambian el índice de la principal) y deben estar condicionadas
// a que la principal aplicó, igual que la auditoría.

import { ErrorApi } from '../errores';
import { traducirErrorD1 } from './errores-d1';

export interface SentenciaPrincipal {
  /** Posición de la sentencia principal dentro de `sentencias`. */
  indice: number;
  /** `meta.changes` que debe dar si aplicó (normalmente 1). */
  cambiosEsperados: number;
}

export interface PlanDeEscritura<R> {
  sentencias: D1PreparedStatement[];
  /** `null` si el plan no tiene una sentencia condicionada que comprobar (o no escribe nada). */
  principal: SentenciaPrincipal | null;
  /** Lo que devuelve el comando si el plan aplicó. */
  respuesta: R;
  /** Error si la principal no aplicó. Por defecto, 409 `CONFLICTO`. */
  siNoAplica?: ErrorApi;
}

/** Plan que no escribe nada (por ejemplo, una asignación que ya está como se pide). */
export function planSinCambios<R>(respuesta: R): PlanDeEscritura<R> {
  return { sentencias: [], principal: null, respuesta };
}

/**
 * Ejecuta el plan en un solo `db.batch()` (más `adicionales` al final, ver arriba) y devuelve su
 * respuesta. Lanza `ErrorApi` si la principal no aplicó o si saltó una restricción.
 */
export async function ejecutarPlan<R>(
  db: D1Database,
  plan: PlanDeEscritura<R>,
  adicionales: readonly D1PreparedStatement[] = [],
): Promise<R> {
  const sentencias = [...plan.sentencias, ...adicionales];
  if (sentencias.length === 0) {
    return plan.respuesta;
  }
  let resultados: D1Result[];
  try {
    resultados = await db.batch(sentencias);
  } catch (error) {
    throw traducirErrorD1(error) ?? error;
  }
  if (plan.principal !== null) {
    const cambios = resultados[plan.principal.indice]?.meta.changes;
    if (cambios !== plan.principal.cambiosEsperados) {
      throw plan.siNoAplica ?? new ErrorApi('CONFLICTO');
    }
  }
  return plan.respuesta;
}

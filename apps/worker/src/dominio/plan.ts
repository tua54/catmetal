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
// 4. `ejecutarPlan` ejecuta el batch (atómico en D1), comprueba `meta.changes` de la principal (o
//    las filas de una lectura de verificación en el mismo batch, B11) y, si no aplicó, lanza el
//    error del plan (por defecto 409 `CONFLICTO`). Un error de restricción o de trigger revierte el
//    batch entero y se traduce con `traducirErrorD1`, nunca un 500.
//
// Uso desde `/sync/push` (Fase 3): `ejecutarPlan(db, plan, [sentenciaSyncMutation])`. Las sentencias
// adicionales se agregan AL FINAL (no cambian el índice de la principal) y deben estar condicionadas
// a que la principal aplicó, igual que la auditoría.

import { ErrorApi } from '../errores';
import { traducirErrorD1 } from './errores-d1';

/**
 * Cómo se comprueba que el plan aplicó. `indice` es la posición de la sentencia en `sentencias`.
 * - `cambiosEsperados`: el `meta.changes` que debe dar la sentencia (normalmente 1). Solo sirve si
 *   la sentencia no dispara triggers que escriban: D1 cuenta también esas filas
 *   (docs/notas-plataforma.md).
 * - `filasEsperadas` (B11): la sentencia es una LECTURA en el mismo batch, después de la escritura,
 *   y debe devolver ese número de filas. No depende de cómo D1 cuente `meta.changes`.
 */
export type SentenciaPrincipal =
  { indice: number; cambiosEsperados: number } | { indice: number; filasEsperadas: number };

export interface PlanDeEscritura<R> {
  sentencias: D1PreparedStatement[];
  /** `null` si el plan no tiene una sentencia condicionada que comprobar (o no escribe nada). */
  principal: SentenciaPrincipal | null;
  /** Lo que devuelve el comando si el plan aplicó. */
  respuesta: R;
  /** Error si la principal no aplicó. Por defecto, 409 `CONFLICTO`. */
  siNoAplica?: ErrorApi;
}

/** ¿La sentencia principal aplicó, según los resultados del batch? */
export function principalAplico(
  principal: SentenciaPrincipal,
  resultados: readonly D1Result[],
): boolean {
  const resultado = resultados[principal.indice];
  if (resultado === undefined) {
    return false;
  }
  return 'filasEsperadas' in principal
    ? resultado.results.length === principal.filasEsperadas
    : resultado.meta.changes === principal.cambiosEsperados;
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
  return (await ejecutarPlanConResultados(db, plan, adicionales)).respuesta;
}

/**
 * Igual que `ejecutarPlan`, pero devuelve también los resultados del batch (uno por sentencia, en
 * orden: las del plan y luego las adicionales). `/sync/push` lo usa para comprobar que su fila de
 * `sync_mutations` se insertó (revisión de la Fase 3, B2).
 */
export async function ejecutarPlanConResultados<R>(
  db: D1Database,
  plan: PlanDeEscritura<R>,
  adicionales: readonly D1PreparedStatement[] = [],
): Promise<{ respuesta: R; resultados: D1Result[] }> {
  const sentencias = [...plan.sentencias, ...adicionales];
  if (sentencias.length === 0) {
    return { respuesta: plan.respuesta, resultados: [] };
  }
  let resultados: D1Result[];
  try {
    resultados = await db.batch(sentencias);
  } catch (error) {
    throw traducirErrorD1(error) ?? error;
  }
  if (plan.principal !== null && !principalAplico(plan.principal, resultados)) {
    throw plan.siNoAplica ?? new ErrorApi('CONFLICTO');
  }
  return { respuesta: plan.respuesta, resultados };
}

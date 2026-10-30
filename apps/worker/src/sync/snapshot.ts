// `GET /api/v1/sync/snapshot?alcance=inicial|orden&order_id=&pagina=` (ADR 0005 regla 7; contrato
// en `packages/shared/src/snapshot.ts`).
//
// - Estado ACTUAL de lo visible para el usuario, por entidad en el orden de `DESCRIPTORES` y por id
//   dentro de cada entidad. Máximo `MAX_ENTIDADES_SNAPSHOT` (500) entidades por página.
// - Primera página: en UN batch, primero `SELECT MAX(seq)` y después el estado. Ese `MAX(seq)` es
//   el `cursor` de todas las páginas (viaja en el token); lo que se escriba entre páginas tiene un
//   `seq` mayor y llega luego por el pull (aplicarlo otra vez es idempotente).
// - Token de página opaco: base64url de `{ cursor, entidad, ultimo_id }`, validado al recibirlo.
// - Aquí la visibilidad SÍ va en el `WHERE` (no hay un cursor de auditoría que avanzar): mismas
//   reglas que el pull (`entidades.ts`).
// - Alcance `orden`: solo las entidades de esa orden; exige poder verla (si no, 404, también en
//   cada página siguiente).

import {
  ENTIDADES_SYNC,
  type EntidadSnapshot,
  MAX_ENTIDADES_SNAPSHOT,
  type SnapshotQuery,
  type SnapshotResponse,
} from '@catmetal/shared';
import type { CondicionSql } from '../auditoria/auditar';
import { aBase64Url, deBase64 } from '../auth/codificacion';
import type { Contexto } from '../dominio/contexto';
import { buscarOrden } from '../dominio/ordenes';
import { puedeVerOrden, veTodasLasOrdenes } from '../dominio/visibilidad';
import { ErrorApi } from '../errores';
import {
  DESCRIPTORES,
  type DescriptorEntidad,
  epocaDe,
  type Fila,
  sentenciaEpoca,
} from './entidades';

export interface TokenPagina {
  cursor: number;
  entidad: string;
  /** Id (o id compuesto, o clave) de la última entidad entregada de `entidad`. */
  ultimo_id: string;
}

const PATRON_ID = /^[A-Za-z0-9_.-]{1,64}(:[A-Za-z0-9_.-]{1,64})?$/;

export function codificarPagina(token: TokenPagina): string {
  return aBase64Url(new TextEncoder().encode(JSON.stringify(token)));
}

/** Decodifica y valida el token; `null` si no es uno emitido por este servidor (forma inválida). */
export function decodificarPagina(texto: string): TokenPagina | null {
  const base64 = texto.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = deBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  if (bytes === null) {
    return null;
  }
  let valor: unknown;
  try {
    valor = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return null;
  }
  const { cursor, entidad, ultimo_id: ultimoId } = valor as Record<string, unknown>;
  if (
    typeof cursor !== 'number' ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    typeof entidad !== 'string' ||
    !(ENTIDADES_SYNC as readonly string[]).includes(entidad) ||
    typeof ultimoId !== 'string' ||
    !PATRON_ID.test(ultimoId)
  ) {
    return null;
  }
  return { cursor, entidad, ultimo_id: ultimoId };
}

const SUBCONSULTA_ASIGNADAS =
  'SELECT vis.order_id FROM order_supervisors AS vis WHERE vis.user_id = ? AND vis.activo = 1';

/** Filtro de visibilidad del supervisor para el alcance `inicial` (jefe y admin: ninguno). */
function filtroVisible(ctx: Contexto, d: DescriptorEntidad): CondicionSql {
  if (veTodasLasOrdenes(ctx)) {
    return { sql: '1 = 1', parametros: [] };
  }
  const yo = ctx.actor.id;
  switch (d.visibilidad) {
    case 'global':
      return { sql: '1 = 1', parametros: [] };
    case 'usuario':
      return { sql: "(u.id = ? OR u.rol IN ('jefe', 'admin'))", parametros: [yo] };
    case 'orden':
      return { sql: `${String(d.columnaOrden)} IN (${SUBCONSULTA_ASIGNADAS})`, parametros: [yo] };
    case 'consumo':
      return {
        sql: `(c.registrado_por = ? OR c.order_id IN (${SUBCONSULTA_ASIGNADAS}))`,
        parametros: [yo, yo],
      };
  }
}

function filtroDespuesDe(d: DescriptorEntidad, ultimoId: string | null): CondicionSql {
  if (ultimoId === null) {
    return { sql: '1 = 1', parametros: [] };
  }
  const [primera, segunda] = d.clave;
  if (segunda === undefined) {
    return { sql: `${primera} > ?`, parametros: [ultimoId] };
  }
  const [a = '', b = ''] = ultimoId.split(':');
  return { sql: `(${primera}, ${segunda}) > (?, ?)`, parametros: [a, b] };
}

function sentenciaPagina(
  ctx: Contexto,
  d: DescriptorEntidad,
  query: SnapshotQuery,
  ultimoId: string | null,
): D1PreparedStatement {
  const alcance: CondicionSql =
    query.alcance === 'orden'
      ? { sql: `${String(d.columnaOrden)} = ?`, parametros: [query.order_id ?? ''] }
      : filtroVisible(ctx, d);
  const despues = filtroDespuesDe(d, ultimoId);
  return ctx.db
    .prepare(
      `${d.desde} WHERE (${alcance.sql}) AND (${despues.sql}) ORDER BY ${d.clave.join(', ')} LIMIT ?`,
    )
    .bind(...alcance.parametros, ...despues.parametros, MAX_ENTIDADES_SNAPSHOT + 1);
}

export async function snapshot(ctx: Contexto, query: SnapshotQuery): Promise<SnapshotResponse> {
  const descriptores =
    query.alcance === 'orden' ? DESCRIPTORES.filter((d) => d.columnaOrden !== null) : DESCRIPTORES;
  const token = query.pagina === undefined ? null : decodificarPagina(query.pagina);
  const inicio = token === null ? 0 : descriptores.findIndex((d) => d.entidad === token.entidad);
  if (query.pagina !== undefined && (token === null || inicio < 0)) {
    throw new ErrorApi('VALIDACION', [{ campo: 'pagina', mensaje: 'La página no es válida.' }]);
  }
  if (query.alcance === 'orden') {
    const orderId = query.order_id ?? '';
    const visible =
      (await puedeVerOrden(ctx, orderId)) && (await buscarOrden(ctx.db, orderId)) !== null;
    if (!visible) {
      throw new ErrorApi('NO_ENCONTRADO');
    }
  }

  const pendientes = descriptores.slice(inicio);
  const sentencias: D1PreparedStatement[] = [];
  if (token === null) {
    // Regla 7: el cursor se lee ANTES que el estado, en el mismo batch.
    sentencias.push(ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM audit_log'));
  }
  sentencias.push(sentenciaEpoca(ctx.db));
  pendientes.forEach((d, i) => {
    sentencias.push(sentenciaPagina(ctx, d, query, i === 0 ? (token?.ultimo_id ?? null) : null));
  });
  const resultados = await ctx.db.batch(sentencias);
  const desplazamiento = token === null ? 1 : 0;
  const cursor =
    token?.cursor ?? (resultados[0]?.results[0] as { seq: number } | undefined)?.seq ?? 0;

  const entidades: EntidadSnapshot[] = [];
  let ultimo: { entidad: string; id: string } | null = null;
  let hayMas = false;
  recorrido: for (const [i, d] of pendientes.entries()) {
    for (const fila of (resultados[desplazamiento + 1 + i]?.results ?? []) as Fila[]) {
      if (entidades.length >= MAX_ENTIDADES_SNAPSHOT) {
        hayMas = true;
        break recorrido;
      }
      const id = d.id(fila);
      entidades.push({ entidad: d.entidad, id, datos: d.datos(fila) });
      ultimo = { entidad: d.entidad, id };
    }
  }

  return {
    epoca: epocaDe(resultados[desplazamiento]),
    cursor,
    entidades,
    siguiente_pagina:
      hayMas && ultimo !== null
        ? codificarPagina({ cursor, entidad: ultimo.entidad, ultimo_id: ultimo.id })
        : null,
  };
}

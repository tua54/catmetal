// `GET /api/v1/sync/snapshot?alcance=inicial|orden&order_id=&pagina=` (ADR 0005 regla 7; contrato
// en `packages/shared/src/snapshot.ts`).
//
// - Estado ACTUAL de lo visible para el usuario, por entidad en el orden de `DESCRIPTORES` y por id
//   dentro de cada entidad (`validations`, por el id de su consumo). Máximo
//   `MAX_ENTIDADES_SNAPSHOT` (500) entidades por página.
// - Cada página consulta solo la entidad en curso y, si se agota antes de llenar el cupo, las
//   siguientes una a una (revisión de la Fase 3, M5).
// - Primera página: en UN batch, primero `SELECT MAX(seq)` y después la primera entidad. Ese
//   `MAX(seq)` es el `cursor` de todas las páginas (viaja en el token); todo lo que se lee después
//   (otras entidades u otras páginas) es estado igual o más nuevo, y lo escrito con un `seq` mayor
//   llega luego por el pull (aplicarlo otra vez es idempotente).
// - Token de página opaco: base64url de `{ version, cursor, entidad, ultimo_id }`, validado al
//   recibirlo (ver `VERSION_TOKEN_PAGINA`).
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

/**
 * Versión del token (revisión de la Fase 3, M5). Desde la versión 2, el `ultimo_id` de
 * `validations` es el id del CONSUMO (paginación por `consumption_id`), no el de la validación.
 * Los tokens sin versión (emitidos antes) siguen valiendo para las demás entidades, cuyo
 * significado no cambió; los de `validations` se rechazan con 400 `VALIDACION` (el cliente
 * reinicia el snapshot). Solo afecta a un snapshot que estaba a mitad de camino durante el despliegue.
 */
export const VERSION_TOKEN_PAGINA = 2;

export function codificarPagina(token: TokenPagina): string {
  return aBase64Url(
    new TextEncoder().encode(JSON.stringify({ version: VERSION_TOKEN_PAGINA, ...token })),
  );
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
  const { cursor, entidad, ultimo_id: ultimoId, version } = valor as Record<string, unknown>;
  if (version !== undefined && version !== VERSION_TOKEN_PAGINA) {
    return null;
  }
  if (version === undefined && entidad === 'validations') {
    return null;
  }
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
  // `+columna` no cambia el resultado: solo impide usar un índice para ese término (ver
  // `paginacion.visibilidadAlRecorrer` en entidades.ts).
  const sinIndice = d.paginacion?.visibilidadAlRecorrer === true ? '+' : '';
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
        sql: `(${sinIndice}c.registrado_por = ? OR ${sinIndice}c.order_id IN (${SUBCONSULTA_ASIGNADAS}))`,
        parametros: [yo, yo],
      };
  }
}

/** Columnas por las que se pagina la entidad en el alcance pedido. */
function columnasDePagina(d: DescriptorEntidad, query: SnapshotQuery): readonly string[] {
  if (d.paginacion === undefined) {
    return d.clave;
  }
  return [query.alcance === 'orden' ? d.paginacion.orden : d.paginacion.inicial];
}

/** Valor de la fila que va en el token de página (`ultimo_id`). */
function valorDePagina(d: DescriptorEntidad, fila: Fila): string {
  return d.paginacion === undefined ? d.id(fila) : d.paginacion.valor(fila);
}

function filtroDespuesDe(columnas: readonly string[], ultimoId: string | null): CondicionSql {
  if (ultimoId === null) {
    return { sql: '1 = 1', parametros: [] };
  }
  const [primera, segunda] = columnas;
  if (segunda === undefined) {
    return { sql: `${String(primera)} > ?`, parametros: [ultimoId] };
  }
  const [a = '', b = ''] = ultimoId.split(':');
  return { sql: `(${String(primera)}, ${segunda}) > (?, ?)`, parametros: [a, b] };
}

/** SQL y parámetros de una página de la entidad (exportado para revisar su plan en las pruebas). */
export function consultaDePagina(
  ctx: Contexto,
  d: DescriptorEntidad,
  query: SnapshotQuery,
  ultimoId: string | null,
  limite: number,
): { sql: string; parametros: (string | number | null)[] } {
  const alcance: CondicionSql =
    query.alcance === 'orden'
      ? { sql: `${String(d.columnaOrden)} = ?`, parametros: [query.order_id ?? ''] }
      : filtroVisible(ctx, d);
  const columnas = columnasDePagina(d, query);
  const despues = filtroDespuesDe(columnas, ultimoId);
  return {
    sql: `${d.desde} WHERE (${alcance.sql}) AND (${despues.sql}) ORDER BY ${columnas.join(', ')} LIMIT ?`,
    parametros: [...alcance.parametros, ...despues.parametros, limite],
  };
}

function sentenciaPagina(
  ctx: Contexto,
  d: DescriptorEntidad,
  query: SnapshotQuery,
  ultimoId: string | null,
  limite: number,
): D1PreparedStatement {
  const { sql, parametros } = consultaDePagina(ctx, d, query, ultimoId, limite);
  return ctx.db.prepare(sql).bind(...parametros);
}

/**
 * Página del snapshot. Solo se consulta la entidad en curso (revisión de la Fase 3, M5): la
 * primera consulta va en el batch con `MAX(seq)` (primera página) y la época; si la entidad se
 * agota antes de llenar el cupo, se consulta la siguiente, una a una (consultas sueltas). Una
 * página hace como máximo 2 + `DESCRIPTORES.length` (12) consultas, muy por debajo del límite de
 * 1000 por invocación.
 */
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
  const [primera] = pendientes;
  const sentencias: D1PreparedStatement[] = [];
  if (token === null) {
    // Regla 7: el cursor se lee ANTES que el estado, en el mismo batch.
    sentencias.push(ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM audit_log'));
  }
  sentencias.push(sentenciaEpoca(ctx.db));
  if (primera !== undefined) {
    sentencias.push(
      sentenciaPagina(ctx, primera, query, token?.ultimo_id ?? null, MAX_ENTIDADES_SNAPSHOT + 1),
    );
  }
  const resultados = await ctx.db.batch(sentencias);
  const desplazamiento = token === null ? 1 : 0;
  const cursor =
    token?.cursor ?? (resultados[0]?.results[0] as { seq: number } | undefined)?.seq ?? 0;

  const entidades: EntidadSnapshot[] = [];
  let ultimo: { entidad: string; valor: string } | null = null;
  let hayMas = false;
  for (const [i, d] of pendientes.entries()) {
    const cupo = MAX_ENTIDADES_SNAPSHOT - entidades.length;
    const filas = (
      i === 0
        ? (resultados[desplazamiento + 1]?.results ?? [])
        : (await sentenciaPagina(ctx, d, query, null, cupo + 1).all<Fila>()).results
    ) as Fila[];
    for (const fila of filas.slice(0, cupo)) {
      entidades.push({ entidad: d.entidad, id: d.id(fila), datos: d.datos(fila) });
      ultimo = { entidad: d.entidad, valor: valorDePagina(d, fila) };
    }
    if (filas.length > cupo) {
      hayMas = true;
      break;
    }
    if (entidades.length >= MAX_ENTIDADES_SNAPSHOT) {
      // Cupo lleno justo al agotar esta entidad: puede haber más en las siguientes (si no, la
      // página siguiente sale vacía y con `siguiente_pagina: null`).
      hayMas = i < pendientes.length - 1;
      break;
    }
  }

  return {
    epoca: epocaDe(resultados[desplazamiento]),
    cursor,
    entidades,
    siguiente_pagina:
      hayMas && ultimo !== null
        ? codificarPagina({ cursor, entidad: ultimo.entidad, ultimo_id: ultimo.valor })
        : null,
  };
}

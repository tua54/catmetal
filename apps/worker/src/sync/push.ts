// `POST /api/v1/sync/push` (docs/spec.md §6; ADR 0009; ADR 0010; revisión de esquema H2).
//
// El sobre ya pasó `syncPushRequestSchema` (laxo) y su `user_id` es el `sub` de la sesión. Cada
// mutación se procesa EN ORDEN y por separado:
//
// 1. `leerMutationId`; ilegible → `rechazada VALIDACION` por `indice`, sin guardar.
// 2. `sync_mutations` existente: del mismo usuario → su respuesta guardada; de otro usuario →
//    `rechazada ID_DUPLICADO` sin revelar nada.
// 3. Tamaño > 64 KiB o `mutacionSchema.safeParse` inválida → `rechazada VALIDACION`, guardada.
// 4. Dependencia: el consumo del que depende (edición, novedad, aprobación, rechazo) tuvo su creación
//    no aplicada en este lote, o no existe y su creación quedó rechazada guardada →
//    `rechazada DEPENDENCIA_RECHAZADA`, guardada.
// 5. El MISMO comando de dominio de la Fase 2 (revalida permisos y reglas con el rol actual y el
//    `did` de la sesión) devuelve su plan; al final del batch va el INSERT de `sync_mutations` como
//    `aplicada`, condicionado a que la sentencia principal aplicó. La base garantiza la
//    idempotencia: si un reintento concurrente ya escribió la mutación, el batch entero falla (PK)
//    y se devuelve la respuesta guardada.
// 6. Clasificador de errores:
//    - `ErrorApi` de negocio (incluidos los errores de restricción o de trigger de D1, que
//      `ejecutarPlan` ya traduce) → `conflicto` (CONFLICTO sobre un consumo existente, con su
//      versión del servidor) o `rechazada`, guardada en su propio batch con `payload_json`.
//    - Antes de clasificar se relee `sync_mutations`: si otra petición la escribió entretanto, se
//      devuelve esa respuesta (reintento concurrente).
//    - TRANSITORIO (detiene el lote; esta y las siguientes quedan sin resultado y el cliente las
//      reenvía): errores que no son de negocio (red, sobrecarga de D1, desconocidos),
//      `ERROR_INTERNO`, y la sentencia principal que no aplicó en ninguno de los `MAX_INTENTOS`
//      (contención entre pushes concurrentes: no es un rechazo del dato de planta).

import {
  type CodigoError,
  type Consumo,
  detallesValidacion,
  esUuidV7,
  leerMutationId,
  MAX_PAYLOAD_MUTACION_BYTES,
  MENSAJES_ERROR,
  type Mutacion,
  mutacionSchema,
  type ResultadoMutacion,
  type TipoResultadoMutacion,
  ahoraIso,
} from '@catmetal/shared';
import type { CondicionSql } from '../auditoria/auditar';
import {
  buscarConsumo,
  COLUMNAS_CONSUMO,
  COLUMNAS_EVIDENCIA_PUBLICAS,
  consumoDe,
  editarConsumo,
  evidenciaDe,
  type FilaConsumo,
  MAX_INTENTOS,
  registrarConsumo,
} from '../dominio/consumos';
import type { Actor, Contexto } from '../dominio/contexto';
import { registrarNovedad } from '../dominio/novedades';
import { ejecutarPlanConResultados, type PlanDeEscritura } from '../dominio/plan';
import { aprobarConsumo, rechazarConsumo } from '../dominio/validaciones';
import { ErrorApi } from '../errores';
import { registrar } from '../log';

/** Parte de un resultado que se guarda en `sync_mutations.respuesta_json` (sin `indice`). */
interface RespuestaGuardada {
  resultado: TipoResultadoMutacion;
  code?: CodigoError;
  message?: string;
  servidor?: Record<string, unknown>;
}

export interface SesionPush {
  db: D1Database;
  actor: Actor;
  deviceId: string;
}

/** Error que detiene el lote: la mutación y las siguientes quedan pendientes en el cliente. */
class ErrorTransitorio extends Error {
  constructor(readonly causa: unknown) {
    super('Error transitorio al procesar la mutación');
    this.name = 'ErrorTransitorio';
  }
}

/** Tipo declarado por el cliente (la columna es NOT NULL y sin CHECK, ADR 0009). */
function tipoDeclarado(mutacion: unknown): string {
  if (typeof mutacion === 'object' && mutacion !== null && !Array.isArray(mutacion)) {
    const tipo: unknown = (mutacion as { tipo?: unknown }).tipo;
    if (typeof tipo === 'string' && tipo.length > 0) {
      return tipo.slice(0, 64);
    }
  }
  return 'desconocido';
}

/** Id del consumo que crea una mutación `consumo.crear`, aunque el resto sea inválido. */
function consumoQueCrea(mutacion: unknown): string | null {
  if (tipoDeclarado(mutacion) !== 'consumo.crear') {
    return null;
  }
  const payload: unknown = (mutacion as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const id: unknown = (payload as { id?: unknown }).id;
  return esUuidV7(id) ? id : null;
}

/** Consumo del que depende la mutación (o `null` si no depende de ninguno). */
function consumoDelQueDepende(m: Mutacion): string | null {
  switch (m.tipo) {
    case 'consumo.crear':
      return null;
    case 'consumo.editar':
      return m.payload.id;
    case 'novedad.crear':
    case 'consumo.aprobar':
    case 'consumo.rechazar':
      return m.payload.consumption_id;
  }
}

const bytes = (texto: string): number => new TextEncoder().encode(texto).byteLength;

/** Mutación serializada en JSON (llega de un JSON, así que siempre se puede volver a serializar). */
function serializar(mutacion: unknown): string {
  return JSON.stringify(mutacion) ?? 'null';
}

/** Tamaño de la mutación serializada, en bytes UTF-8. */
function tamanoSerializado(mutacion: unknown): number {
  return bytes(serializar(mutacion));
}

/**
 * `payload_json` de una mutación rechazada o en conflicto: la mutación tal como llegó. Si supera
 * 64 KiB (el CHECK de la columna), se guarda un marcador JSON con el tamaño y el motivo en lugar de
 * truncarla (un JSON truncado no es válido). Una mutación válida nunca llega a ese tamaño (la
 * descripción más larga es de 2000 caracteres), así que solo se omite lo que se rechaza por tamaño.
 */
export function payloadJson(mutacion: unknown): string {
  const texto = serializar(mutacion);
  const tamano = bytes(texto);
  return tamano <= MAX_PAYLOAD_MUTACION_BYTES
    ? texto
    : JSON.stringify({ omitido: true, motivo: 'supera 64 KiB', tamano_bytes: tamano });
}

function rechazo(code: CodigoError, message: string = MENSAJES_ERROR[code]): RespuestaGuardada {
  return { resultado: 'rechazada', code, message };
}

const COLUMNAS_SYNC =
  'mutation_id, user_id, device_id, tipo, resultado, respuesta_json, payload_json, procesada_at, created_at, updated_at';

/** Fila guardada de la mutación, o `null`. */
async function leerGuardada(
  db: D1Database,
  mutationId: string,
): Promise<{ user_id: string; respuesta_json: string } | null> {
  return db
    .prepare('SELECT user_id, respuesta_json FROM sync_mutations WHERE mutation_id = ?')
    .bind(mutationId)
    .first<{ user_id: string; respuesta_json: string }>();
}

function respuestaDeGuardada(
  sesion: SesionPush,
  fila: { user_id: string; respuesta_json: string },
): RespuestaGuardada {
  // Idempotencia ligada al usuario (ADR 0009): nunca se revela la respuesta de otro.
  if (fila.user_id !== sesion.actor.id) {
    return rechazo('ID_DUPLICADO');
  }
  return JSON.parse(fila.respuesta_json) as RespuestaGuardada;
}

/**
 * Guarda la respuesta en su propio batch: un `rechazada`/`conflicto` (con `payload_json`) o una
 * `aplicada` reconocida por clave natural (sin payload, como las demás aplicadas). Si otra petición
 * guardó la misma mutación entretanto (`ON CONFLICT DO NOTHING` no inserta), devuelve la guardada.
 */
async function guardarRespuesta(
  sesion: SesionPush,
  mutationId: string,
  mutacion: unknown,
  respuesta: RespuestaGuardada,
): Promise<RespuestaGuardada> {
  const ahora = ahoraIso();
  const resultado = await sesion.db
    .prepare(
      `INSERT INTO sync_mutations (${COLUMNAS_SYNC}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (mutation_id) DO NOTHING`,
    )
    .bind(
      mutationId,
      sesion.actor.id,
      sesion.deviceId,
      tipoDeclarado(mutacion),
      respuesta.resultado,
      JSON.stringify(respuesta),
      respuesta.resultado === 'aplicada' ? null : payloadJson(mutacion),
      ahora,
      ahora,
      ahora,
    )
    .run();
  if (resultado.meta.changes === 1) {
    return respuesta;
  }
  const guardada = await leerGuardada(sesion.db, mutationId);
  return guardada === null ? respuesta : respuestaDeGuardada(sesion, guardada);
}

/** Condición "la sentencia principal del plan aplicó", para el INSERT de `sync_mutations`. */
function condicionAplicada(m: Mutacion, ctx: Contexto, respuesta: unknown): CondicionSql {
  switch (m.tipo) {
    case 'consumo.crear':
      return {
        sql: 'EXISTS (SELECT 1 FROM consumptions WHERE id = ? AND registrado_por = ? AND server_received_at = ?)',
        parametros: [m.payload.id, ctx.actor.id, ctx.ahora],
      };
    case 'consumo.editar':
      return {
        sql: 'EXISTS (SELECT 1 FROM consumptions WHERE id = ? AND version = ? AND updated_at = ?)',
        parametros: [m.payload.id, (respuesta as Consumo).version, ctx.ahora],
      };
    case 'novedad.crear':
      return {
        sql: 'EXISTS (SELECT 1 FROM incidents WHERE id = ? AND registrado_por = ? AND server_received_at = ?)',
        parametros: [m.payload.id, ctx.actor.id, ctx.ahora],
      };
    case 'consumo.aprobar':
    case 'consumo.rechazar':
      return {
        sql: 'EXISTS (SELECT 1 FROM validations WHERE id = ? AND validado_por = ? AND server_received_at = ?)',
        parametros: [m.payload.id, ctx.actor.id, ctx.ahora],
      };
  }
}

function planDe(ctx: Contexto, m: Mutacion): Promise<PlanDeEscritura<unknown>> {
  switch (m.tipo) {
    case 'consumo.crear':
      return registrarConsumo(ctx, m.payload);
    case 'consumo.editar':
      return editarConsumo(ctx, m.payload);
    case 'novedad.crear':
      return registrarNovedad(ctx, m.payload);
    case 'consumo.aprobar':
      return aprobarConsumo(ctx, m.payload);
    case 'consumo.rechazar':
      return rechazarConsumo(ctx, m.payload);
  }
}

/**
 * Aplica la mutación con el comando de dominio y la fila `aplicada` de `sync_mutations` en el
 * mismo batch. Reintenta (máx. `MAX_INTENTOS`) si la principal no aplicó por una carrera; si nunca
 * aplicó, es contención: `ErrorTransitorio`.
 */
async function aplicar(sesion: SesionPush, m: Mutacion): Promise<RespuestaGuardada> {
  for (let intento = 1; ; intento += 1) {
    const ctx: Contexto = {
      db: sesion.db,
      actor: sesion.actor,
      deviceId: sesion.deviceId,
      ahora: ahoraIso(),
      clientAt: m.client_created_at,
    };
    const plan = await planDe(ctx, m);
    const respuesta: RespuestaGuardada = {
      resultado: 'aplicada',
      servidor: JSON.parse(JSON.stringify(plan.respuesta)) as Record<string, unknown>,
    };
    const condicion = condicionAplicada(m, ctx, plan.respuesta);
    const fila = sesion.db
      .prepare(
        `INSERT INTO sync_mutations (${COLUMNAS_SYNC})
         SELECT ?, ?, ?, ?, 'aplicada', ?, NULL, ?, ?, ? WHERE ${condicion.sql}`,
      )
      .bind(
        m.mutation_id,
        sesion.actor.id,
        sesion.deviceId,
        m.tipo,
        JSON.stringify(respuesta),
        ctx.ahora,
        ctx.ahora,
        ctx.ahora,
        ...condicion.parametros,
      );
    try {
      const { resultados } = await ejecutarPlanConResultados(sesion.db, plan, [fila]);
      // B2: la fila `aplicada` va condicionada a la principal; si la principal aplicó y esta no,
      // el dato de planta SÍ quedó escrito (con su auditoría), así que se responde `aplicada` igual:
      // un reenvío lo reconoce por clave natural. Se registra para investigarlo.
      if (resultados.at(-1)?.meta.changes !== 1) {
        registrar('error', 'sync_mutation_no_registrada', {
          mutation_id: m.mutation_id,
          tipo: m.tipo,
        });
      }
      return respuesta;
    } catch (error) {
      if (plan.siNoAplica !== undefined && error === plan.siNoAplica) {
        if (intento < MAX_INTENTOS) {
          continue;
        }
        throw new ErrorTransitorio(error);
      }
      throw error;
    }
  }
}

/**
 * ¿El consumo no existe y su creación quedó rechazada (o en conflicto) para este usuario? Usa el
 * índice parcial por expresión `sync_mutations_no_aplicadas_consumo` (migración 0006): la expresión
 * y las condiciones del WHERE parcial deben quedar escritas exactamente así.
 */
export const CONSULTA_CREACION_NO_APLICADA = `SELECT 1 AS x FROM sync_mutations
  WHERE user_id = ? AND tipo = 'consumo.crear' AND resultado <> 'aplicada'
    AND json_extract(payload_json, '$.payload.id') = ?
    AND NOT EXISTS (SELECT 1 FROM consumptions WHERE id = ?)
  LIMIT 1`;

async function creacionRechazadaGuardada(sesion: SesionPush, consumoId: string): Promise<boolean> {
  const fila = await sesion.db
    .prepare(CONSULTA_CREACION_NO_APLICADA)
    .bind(sesion.actor.id, consumoId, consumoId)
    .first();
  return fila !== null;
}

/**
 * Idempotencia por clave natural (ADR 0016, M2): tras una restauración desde el backup de R2 (que
 * no es una foto de un instante) puede existir la entidad sin su fila de `sync_mutations`. Si la
 * fila existente es la MISMA que la mutación describe (mismo autor y mismos datos de identidad),
 * la mutación ya está aplicada: se responde `aplicada` con el estado actual.
 * - `consumo.crear`: mismo id, `registrado_por` (= actor), `order_id`, `material_id` y
 *   `client_created_at`.
 * - `novedad.crear`: mismo id, `registrado_por`, `consumption_id` y `client_created_at`.
 * - `consumo.aprobar`/`consumo.rechazar`: mismo id, `validado_por`, `consumption_id` y decisión.
 */
async function aplicadaPorClaveNatural(
  sesion: SesionPush,
  m: Mutacion,
): Promise<RespuestaGuardada | null> {
  const { db } = sesion;
  const yo = sesion.actor.id;
  const aplicada = (servidor: Record<string, unknown>): RespuestaGuardada => ({
    resultado: 'aplicada',
    servidor: JSON.parse(JSON.stringify(servidor)) as Record<string, unknown>,
  });
  switch (m.tipo) {
    case 'consumo.crear': {
      const p = m.payload;
      const fila = await db
        .prepare(
          `SELECT ${COLUMNAS_CONSUMO} FROM consumptions
           WHERE id = ? AND registrado_por = ? AND order_id = ? AND material_id = ?
             AND client_created_at = ?`,
        )
        .bind(p.id, yo, p.order_id, p.material_id, p.client_created_at)
        .first<FilaConsumo>();
      return fila === null ? null : aplicada({ ...consumoDe(fila) });
    }
    case 'novedad.crear': {
      const p = m.payload;
      const [novedad, evidencias] = await db.batch([
        db
          .prepare(
            `SELECT id, consumption_id, tipo, descripcion, registrado_por, client_created_at,
               server_received_at, created_at, updated_at
             FROM incidents
             WHERE id = ? AND registrado_por = ? AND consumption_id = ? AND client_created_at = ?`,
          )
          .bind(p.id, yo, p.consumption_id, p.client_created_at),
        db
          .prepare(
            `SELECT ${COLUMNAS_EVIDENCIA_PUBLICAS} FROM evidences WHERE incident_id = ? ORDER BY id`,
          )
          .bind(p.id),
      ]);
      const fila = novedad?.results[0] as Record<string, unknown> | undefined;
      return fila === undefined
        ? null
        : aplicada({
            ...fila,
            evidencias: ((evidencias?.results ?? []) as Parameters<typeof evidenciaDe>[0][]).map(
              evidenciaDe,
            ),
          });
    }
    case 'consumo.aprobar':
    case 'consumo.rechazar': {
      const p = m.payload;
      const decision = m.tipo === 'consumo.aprobar' ? 'aprobado' : 'rechazado';
      const [validacion, consumo] = await db.batch([
        db
          .prepare(
            `SELECT id, consumption_id, decision, motivo, validado_por, client_created_at,
               server_received_at, created_at, updated_at
             FROM validations
             WHERE id = ? AND validado_por = ? AND consumption_id = ? AND decision = ?`,
          )
          .bind(p.id, yo, p.consumption_id, decision),
        db
          .prepare(`SELECT ${COLUMNAS_CONSUMO} FROM consumptions WHERE id = ?`)
          .bind(p.consumption_id),
      ]);
      const filaValidacion = validacion?.results[0] as Record<string, unknown> | undefined;
      const filaConsumo = consumo?.results[0] as FilaConsumo | undefined;
      return filaValidacion === undefined || filaConsumo === undefined
        ? null
        : aplicada({ consumo: consumoDe(filaConsumo), validacion: filaValidacion });
    }
    case 'consumo.editar':
      return null;
  }
}

/** Clasifica un error de negocio en `rechazada` o `conflicto` (con la versión del servidor). */
async function clasificar(
  sesion: SesionPush,
  m: Mutacion,
  error: ErrorApi,
): Promise<RespuestaGuardada> {
  if (error.code === 'ID_DUPLICADO') {
    const yaAplicada = await aplicadaPorClaveNatural(sesion, m);
    if (yaAplicada !== null) {
      return yaAplicada;
    }
  }
  const dependeDe = consumoDelQueDepende(m);
  if (
    error.code === 'NO_ENCONTRADO' &&
    dependeDe !== null &&
    (await creacionRechazadaGuardada(sesion, dependeDe))
  ) {
    return rechazo('DEPENDENCIA_RECHAZADA');
  }
  // Con la versión del servidor: el conflicto de versión y la edición o validación de un consumo
  // ya decidido (la UI ofrece crear un consumo corregido). El comando ya comprobó que es visible.
  if ((error.code === 'CONFLICTO' || error.code === 'CONSUMO_NO_PENDIENTE') && dependeDe !== null) {
    const actual = await buscarConsumo(sesion.db, dependeDe);
    if (actual !== null) {
      return {
        resultado: error.code === 'CONFLICTO' ? 'conflicto' : 'rechazada',
        code: error.code,
        message: MENSAJES_ERROR[error.code],
        servidor: { ...consumoDe(actual) },
      };
    }
  }
  return rechazo(error.code);
}

interface EstadoLote {
  /** Consumos cuya creación no se aplicó en este lote (sus dependientes se rechazan). */
  creacionesNoAplicadas: Set<string>;
}

async function procesar(
  sesion: SesionPush,
  mutacion: unknown,
  mutationId: string,
  lote: EstadoLote,
): Promise<RespuestaGuardada> {
  const guardada = await leerGuardada(sesion.db, mutationId);
  if (guardada !== null) {
    return respuestaDeGuardada(sesion, guardada);
  }
  if (tamanoSerializado(mutacion) > MAX_PAYLOAD_MUTACION_BYTES) {
    return guardarRespuesta(
      sesion,
      mutationId,
      mutacion,
      rechazo('VALIDACION', 'La mutación supera el tamaño máximo de 64 KiB.'),
    );
  }
  const parseada = mutacionSchema.safeParse(mutacion);
  if (!parseada.success) {
    const primero = detallesValidacion(parseada.error)[0];
    const mensaje =
      primero === undefined
        ? MENSAJES_ERROR.VALIDACION
        : `${MENSAJES_ERROR.VALIDACION} ${primero.campo === '' ? '' : `${primero.campo}: `}${primero.mensaje}`;
    return guardarRespuesta(sesion, mutationId, mutacion, rechazo('VALIDACION', mensaje));
  }
  const m = parseada.data;
  const dependeDe = consumoDelQueDepende(m);
  if (dependeDe !== null && lote.creacionesNoAplicadas.has(dependeDe)) {
    return guardarRespuesta(sesion, mutationId, mutacion, rechazo('DEPENDENCIA_RECHAZADA'));
  }
  try {
    return await aplicar(sesion, m);
  } catch (error) {
    if (error instanceof ErrorTransitorio) {
      throw error;
    }
    // Reintento concurrente: otra petición pudo escribir esta mutación mientras tanto.
    const escrita = await leerGuardada(sesion.db, mutationId);
    if (escrita !== null) {
      return respuestaDeGuardada(sesion, escrita);
    }
    if (!(error instanceof ErrorApi) || error.code === 'ERROR_INTERNO') {
      throw new ErrorTransitorio(error);
    }
    return guardarRespuesta(sesion, mutationId, mutacion, await clasificar(sesion, m, error));
  }
}

/**
 * Procesa el lote en orden. Devuelve un resultado por mutación procesada; si un error transitorio
 * detiene el lote, las restantes no tienen resultado (siguen pendientes en el cliente).
 */
export async function procesarLote(
  sesion: SesionPush,
  mutaciones: readonly unknown[],
): Promise<ResultadoMutacion[]> {
  const resultados: ResultadoMutacion[] = [];
  const lote: EstadoLote = { creacionesNoAplicadas: new Set() };
  for (const [indice, mutacion] of mutaciones.entries()) {
    const mutationId = leerMutationId(mutacion);
    if (mutationId === null) {
      resultados.push({
        indice,
        ...rechazo('VALIDACION', 'La mutación no tiene un mutation_id válido.'),
      });
      const creado = consumoQueCrea(mutacion);
      if (creado !== null) {
        lote.creacionesNoAplicadas.add(creado);
      }
      continue;
    }
    let respuesta: RespuestaGuardada;
    try {
      respuesta = await procesar(sesion, mutacion, mutationId, lote);
    } catch (error) {
      const causa = error instanceof ErrorTransitorio ? error.causa : error;
      registrar('error', 'sync_push_transitorio', {
        indice,
        mutation_id: mutationId,
        error: causa instanceof Error ? causa.name : 'desconocido',
        mensaje: causa instanceof Error ? causa.message.slice(0, 300) : null,
      });
      break;
    }
    const creado = consumoQueCrea(mutacion);
    if (creado !== null && respuesta.resultado !== 'aplicada') {
      lote.creacionesNoAplicadas.add(creado);
    }
    resultados.push({ indice, mutation_id: mutationId, ...respuesta });
  }
  return resultados;
}

/**
 * `devices.ultimo_sync_at` del dispositivo de la sesión. Es metadato operativo (no una entidad de
 * negocio ni sincronizable): no se audita, para no llenar `audit_log` (y las ventanas del pull)
 * con una fila por cada sincronización.
 */
export async function marcarSincronizado(sesion: SesionPush): Promise<void> {
  const ahora = ahoraIso();
  await sesion.db
    .prepare('UPDATE devices SET ultimo_sync_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(ahora, ahora, sesion.deviceId, sesion.actor.id)
    .run();
}

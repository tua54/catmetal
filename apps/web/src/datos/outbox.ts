// Outbox: acciones locales del usuario y consultas del motor de sync (§6, ADR 0009 y 0012).
//
// Garantías:
// - Cada acción escribe la entidad local, su mutación y su evento de trazabilidad en UNA transacción
//   `rw` de Dexie: nunca queda una sin la otra.
// - Partición: toda función recibe el `userId` de la sesión activa; ninguna devuelve ni modifica
//   mutaciones de otro usuario (una mutación solo sale con la sesión de su autor, ADR 0008).
// - Orden: `seq_local` es un contador único del navegador; el lote sale en ese orden.
// - Las mutaciones `rechazada` y `conflicto` nunca se borran; las `aplicada` se purgan a los 7 días.
//
// Las operaciones asíncronas ajenas a Dexie (leer los bytes de una foto, sha256) se hacen ANTES de
// abrir la transacción: esperar una promesa que no es de Dexie dentro de ella la cerraría.

import {
  MAX_MUTACIONES_POR_LOTE,
  MENSAJES_ERROR,
  RETENCION_MUTACIONES_APLICADAS_DIAS,
  ahoraIso,
  detallesValidacion,
  diaBogota,
  mutacionSchema,
  uuidv7,
  type CrearConsumo,
  type CrearNovedad,
  type DetalleValidacion,
  type EditarConsumo,
  type EvidenciaMeta,
  type MimeEvidencia,
  type Mutacion,
  type MutacionDe,
  type ResultadoMutacion,
  type TipoMutacion,
  type TipoResultadoMutacion,
} from '@catmetal/shared';
import type { Table } from 'dexie';
import { claveEntidad, db, rangoDe, tablasDeDatos } from './db';
import {
  camposDe,
  estaEnCola,
  leerClave,
  mutacionesEnColaDeEntidad,
  mutacionesEnColaDeUsuario,
  recalcular,
  recalcularConsumo,
} from './derivar';
import { guardarEntidadesServidor, type EntidadAfectada } from './entidades';
import { ErrorDatosLocales } from './errores';
import { extraerEntidades } from './servidor';
import { registrarEvento } from './trazabilidad';
import type {
  ConsumoLocal,
  ErrorSync,
  MutacionOutbox,
  TablaMutable,
  UltimoResultado,
} from './tipos';

// ---------------------------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------------------------

type Opcionales<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Nuevo consumo. `id` y `client_created_at` se generan si faltan. */
export type EntradaConsumoLocal = Opcionales<CrearConsumo, 'id' | 'client_created_at'>;

/** Edición de un consumo propio pendiente. La `version` esperada la calcula la capa local. */
export type EntradaEdicionLocal = Opcionales<Omit<EditarConsumo, 'version'>, 'client_created_at'>;

/** Nueva novedad. Las evidencias se calculan a partir de las fotos. */
export type EntradaNovedadLocal = Opcionales<
  Omit<CrearNovedad, 'evidencias'>,
  'id' | 'client_created_at'
>;

export interface EntradaAprobarLocal {
  consumption_id: string;
  id?: string;
  /** Versión del consumo que vio el jefe; por defecto, la última conocida del servidor. */
  version?: number;
  client_created_at?: string;
}

export interface EntradaRechazarLocal extends EntradaAprobarLocal {
  motivo: string;
}

export interface AccionRegistrada {
  /** Id de la entidad principal creada o modificada. */
  id: string;
  mutation_id: string;
}

export interface ConsumoConNovedadRegistrado {
  consumo_id: string;
  novedad_id: string;
  mutation_ids: [string, string];
}

/** Reloj y aleatorio inyectables (pruebas). */
export interface OpcionesTiempo {
  ahora?: Date;
  aleatorio?: () => number;
}

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------

/** Error de validación local con los detalles de Zod (sin los valores recibidos). */
export class ErrorValidacionLocal extends ErrorDatosLocales {
  readonly detalles: DetalleValidacion[];

  constructor(detalles: DetalleValidacion[]) {
    super('VALIDACION');
    this.detalles = detalles;
  }
}

/** Arma y valida la mutación EXACTA que se enviará, con el esquema del contrato. */
function construirMutacion<T extends TipoMutacion>(
  tipo: T,
  payload: unknown,
  ahora: string,
): MutacionDe<T> {
  const resultado = mutacionSchema.safeParse({
    mutation_id: uuidv7(),
    tipo,
    client_created_at: ahora,
    payload,
  });
  if (!resultado.success) {
    throw new ErrorValidacionLocal(detallesValidacion(resultado.error));
  }
  return resultado.data as MutacionDe<T>;
}

/** La mutación tal como viaja en `POST /sync/push`. */
export function aMutacion(m: MutacionOutbox): Mutacion {
  return {
    mutation_id: m.mutation_id,
    tipo: m.tipo,
    client_created_at: m.client_created_at,
    payload: m.payload,
  } as Mutacion;
}

interface DestinoMutacion {
  tabla: TablaMutable;
  entidad_id: string;
  consumo_id: string;
  claves: string[];
}

async function encolar(
  userId: string,
  mutacion: Mutacion,
  destino: DestinoMutacion,
  ahora: string,
): Promise<MutacionOutbox> {
  const ultima = await db.outbox.orderBy('seq_local').last();
  const fila = {
    mutation_id: mutacion.mutation_id,
    user_id: userId,
    seq_local: (ultima?.seq_local ?? 0) + 1,
    tipo: mutacion.tipo,
    payload: mutacion.payload,
    ...destino,
    client_created_at: mutacion.client_created_at,
    intentos: 0,
    estado: 'pendiente',
    error: null,
    siguiente_intento_at: null,
    enviada_at: null,
    aplicada_at: null,
    actualizada_at: ahora,
  } as MutacionOutbox;
  await db.outbox.add(fila);
  return fila;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 en hexadecimal minúscula (formato de `evidenciaMetaSchema`). */
export async function sha256Hex(datos: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', datos));
}

async function leerBytes(foto: Blob): Promise<ArrayBuffer> {
  return typeof foto.arrayBuffer === 'function'
    ? foto.arrayBuffer()
    : new Response(foto).arrayBuffer();
}

interface FotoPreparada {
  meta: EvidenciaMeta;
  datos: ArrayBuffer;
}

/** Lee las fotos (ya comprimidas) y calcula sus metadatos. Fuera de la transacción. */
async function prepararFotos(fotos: readonly Blob[]): Promise<FotoPreparada[]> {
  const preparadas: FotoPreparada[] = [];
  for (const foto of fotos) {
    const datos = await leerBytes(foto);
    preparadas.push({
      meta: {
        id: uuidv7(),
        mime: foto.type as MimeEvidencia,
        tamano_bytes: datos.byteLength,
        sha256: await sha256Hex(datos),
      },
      datos,
    });
  }
  return preparadas;
}

// ---------------------------------------------------------------------------------------------
// Acciones locales (cada una en una sola transacción)
// ---------------------------------------------------------------------------------------------

async function crearConsumoEnTx(
  userId: string,
  mutacion: MutacionDe<'consumo.crear'>,
  ahora: string,
): Promise<void> {
  const p = mutacion.payload;
  const fila: ConsumoLocal = {
    user_id: userId,
    id: p.id,
    order_id: p.order_id,
    ...camposDe(p),
    corrige_a: p.corrige_a ?? null,
    registrado_por: userId,
    client_created_at: p.client_created_at,
    dia_bogota: diaBogota(p.client_created_at),
    base_local: camposDe(p),
    servidor: null,
    servidor_diferido: null,
    version: null,
    estado_local: 'pendiente_sync',
    ultimo_resultado: null,
    falta_novedad: false,
    requiere_novedad: false,
    registro_tardio: false,
    motivo_rechazo: null,
    error_sync: null,
    conflicto_servidor: null,
    actualizado_at: ahora,
  };
  // `add` (no `put`): si el id ya existe en la partición, falla y la transacción se revierte.
  await db.consumos.add(fila);
  await encolar(
    userId,
    mutacion,
    {
      tabla: 'consumos',
      entidad_id: p.id,
      consumo_id: p.id,
      claves: [claveEntidad(userId, 'consumos', p.id)],
    },
    ahora,
  );
}

async function crearNovedadEnTx(
  userId: string,
  mutacion: MutacionDe<'novedad.crear'>,
  fotos: readonly FotoPreparada[],
  ahora: string,
): Promise<ConsumoLocal> {
  const p = mutacion.payload;
  const consumo = await db.consumos.get([userId, p.consumption_id]);
  if (consumo === undefined) {
    throw new ErrorDatosLocales('NO_ENCONTRADO');
  }
  if (consumo.servidor === null && consumo.estado_local === 'rechazado_sync') {
    throw new ErrorDatosLocales('DEPENDENCIA_RECHAZADA');
  }
  await db.novedades.add({
    user_id: userId,
    id: p.id,
    consumption_id: p.consumption_id,
    tipo: p.tipo,
    descripcion: p.descripcion,
    registrado_por: userId,
    client_created_at: p.client_created_at,
    servidor: null,
    servidor_diferido: null,
    estado_local: 'pendiente_sync',
    ultimo_resultado: null,
    error_sync: null,
    actualizado_at: ahora,
  });
  await db.evidencias.bulkAdd(
    fotos.map((foto) => ({
      user_id: userId,
      id: foto.meta.id,
      incident_id: p.id,
      mime: foto.meta.mime,
      tamano_bytes: foto.meta.tamano_bytes,
      sha256: foto.meta.sha256,
      datos: foto.datos,
      estado_subida: 'pendiente' as const,
      intentos_subida: 0,
      siguiente_intento_at: null,
      error_subida: null,
      subido_at: null,
      servidor: null,
      actualizado_at: ahora,
    })),
  );
  await encolar(
    userId,
    mutacion,
    {
      tabla: 'novedades',
      entidad_id: p.id,
      consumo_id: p.consumption_id,
      claves: [
        claveEntidad(userId, 'novedades', p.id),
        ...fotos.map((foto) => claveEntidad(userId, 'evidencias', foto.meta.id)),
      ],
    },
    ahora,
  );
  await recalcularConsumo(userId, p.consumption_id);
  return consumo;
}

/** Registra un consumo offline: entidad local + mutación `consumo.crear` + trazabilidad. */
export async function registrarConsumoLocal(
  userId: string,
  entrada: EntradaConsumoLocal,
): Promise<AccionRegistrada> {
  const ahora = ahoraIso();
  const mutacion = construirMutacion(
    'consumo.crear',
    {
      ...entrada,
      id: entrada.id ?? uuidv7(),
      client_created_at: entrada.client_created_at ?? ahora,
    },
    ahora,
  );
  return db.transaction('rw', tablasDeDatos(), async () => {
    await crearConsumoEnTx(userId, mutacion, ahora);
    await registrarEvento(
      userId,
      'consumo.registrado',
      mutacion.payload.id,
      mutacion.payload.order_id,
      ahora,
    );
    return { id: mutacion.payload.id, mutation_id: mutacion.mutation_id };
  });
}

/**
 * Registra una novedad con sus fotos (ya comprimidas). Las fotos quedan con subida `pendiente`;
 * se suben cuando la mutación de la novedad quede `aplicada` (§6 punto 5).
 */
export async function registrarNovedadLocal(
  userId: string,
  entrada: EntradaNovedadLocal,
  fotos: readonly Blob[] = [],
): Promise<AccionRegistrada> {
  const ahora = ahoraIso();
  const preparadas = await prepararFotos(fotos);
  const mutacion = construirMutacion(
    'novedad.crear',
    {
      ...entrada,
      id: entrada.id ?? uuidv7(),
      client_created_at: entrada.client_created_at ?? ahora,
      evidencias: preparadas.map((foto) => foto.meta),
    },
    ahora,
  );
  return db.transaction('rw', tablasDeDatos(), async () => {
    const consumo = await crearNovedadEnTx(userId, mutacion, preparadas, ahora);
    await registrarEvento(
      userId,
      'novedad.registrada',
      mutacion.payload.id,
      consumo.order_id,
      ahora,
    );
    return { id: mutacion.payload.id, mutation_id: mutacion.mutation_id };
  });
}

/** Consumo y su novedad en una sola transacción ("registró consumo + novedad"). */
export async function registrarConsumoConNovedadLocal(
  userId: string,
  consumo: EntradaConsumoLocal,
  novedad: Omit<EntradaNovedadLocal, 'consumption_id'>,
  fotos: readonly Blob[] = [],
): Promise<ConsumoConNovedadRegistrado> {
  const ahora = ahoraIso();
  const preparadas = await prepararFotos(fotos);
  const mutacionConsumo = construirMutacion(
    'consumo.crear',
    {
      ...consumo,
      id: consumo.id ?? uuidv7(),
      client_created_at: consumo.client_created_at ?? ahora,
    },
    ahora,
  );
  const mutacionNovedad = construirMutacion(
    'novedad.crear',
    {
      ...novedad,
      id: novedad.id ?? uuidv7(),
      consumption_id: mutacionConsumo.payload.id,
      client_created_at: novedad.client_created_at ?? ahora,
      evidencias: preparadas.map((foto) => foto.meta),
    },
    ahora,
  );
  return db.transaction('rw', tablasDeDatos(), async () => {
    await crearConsumoEnTx(userId, mutacionConsumo, ahora);
    await crearNovedadEnTx(userId, mutacionNovedad, preparadas, ahora);
    await registrarEvento(
      userId,
      'consumo.registrado_con_novedad',
      mutacionConsumo.payload.id,
      mutacionConsumo.payload.order_id,
      ahora,
    );
    return {
      consumo_id: mutacionConsumo.payload.id,
      novedad_id: mutacionNovedad.payload.id,
      mutation_ids: [mutacionConsumo.mutation_id, mutacionNovedad.mutation_id],
    };
  });
}

function validacionVigente(estado: string): boolean {
  return estado !== 'rechazado_sync';
}

/**
 * Edita un consumo propio pendiente (S4). La versión esperada es la versión base del servidor (1 si
 * la creación aún no se confirmó) MÁS las ediciones anteriores de ese consumo que siguen en la cola:
 * el servidor incrementa la versión con cada edición aplicada, en orden (ADR 0009, revisión H7.4).
 */
export async function editarConsumoLocal(
  userId: string,
  entrada: EntradaEdicionLocal,
): Promise<AccionRegistrada> {
  const ahora = ahoraIso();
  return db.transaction('rw', tablasDeDatos(), async () => {
    const c = await db.consumos.get([userId, entrada.id]);
    if (c === undefined) {
      throw new ErrorDatosLocales('NO_ENCONTRADO');
    }
    if (c.registrado_por !== userId) {
      throw new ErrorDatosLocales('PERMISO_DENEGADO');
    }
    if (c.servidor === null && c.estado_local === 'rechazado_sync') {
      throw new ErrorDatosLocales('DEPENDENCIA_RECHAZADA');
    }
    const validaciones = await db.validaciones
      .where('[user_id+consumption_id]')
      .equals([userId, c.id])
      .toArray();
    if (
      (c.servidor !== null && c.servidor.estado !== 'pendiente') ||
      validaciones.some((v) => validacionVigente(v.estado_local))
    ) {
      throw new ErrorDatosLocales('CONSUMO_NO_PENDIENTE');
    }
    const cola = await mutacionesEnColaDeEntidad(userId, 'consumos', c.id);
    const edicionesEnCola = cola.filter((m) => m.tipo === 'consumo.editar').length;
    const version = (c.servidor?.version ?? 1) + edicionesEnCola;
    const mutacion = construirMutacion(
      'consumo.editar',
      { ...entrada, version, client_created_at: entrada.client_created_at ?? ahora },
      ahora,
    );
    await encolar(
      userId,
      mutacion,
      {
        tabla: 'consumos',
        entidad_id: c.id,
        consumo_id: c.id,
        claves: [claveEntidad(userId, 'consumos', c.id)],
      },
      ahora,
    );
    await registrarEvento(userId, 'consumo.editado', c.id, c.order_id, ahora);
    await recalcularConsumo(userId, c.id);
    return { id: c.id, mutation_id: mutacion.mutation_id };
  });
}

async function validarConsumoLocal(
  userId: string,
  tipo: 'consumo.aprobar' | 'consumo.rechazar',
  entrada: EntradaAprobarLocal & { motivo?: string },
): Promise<AccionRegistrada> {
  const ahora = ahoraIso();
  return db.transaction('rw', tablasDeDatos(), async () => {
    const c = await db.consumos.get([userId, entrada.consumption_id]);
    if (c === undefined || c.servidor === null) {
      throw new ErrorDatosLocales('NO_ENCONTRADO');
    }
    // S9: nadie valida un consumo que él mismo registró (el servidor también lo impide).
    if (c.registrado_por === userId) {
      throw new ErrorDatosLocales('AUTOAPROBACION');
    }
    const validaciones = await db.validaciones
      .where('[user_id+consumption_id]')
      .equals([userId, c.id])
      .toArray();
    if (
      c.servidor.estado !== 'pendiente' ||
      validaciones.some((v) => validacionVigente(v.estado_local))
    ) {
      throw new ErrorDatosLocales('CONSUMO_NO_PENDIENTE');
    }
    const decision = tipo === 'consumo.aprobar' ? 'aprobado' : 'rechazado';
    const mutacion = construirMutacion(
      tipo,
      {
        id: entrada.id ?? uuidv7(),
        consumption_id: c.id,
        version: entrada.version ?? c.servidor.version,
        client_created_at: entrada.client_created_at ?? ahora,
        ...(tipo === 'consumo.rechazar' ? { motivo: entrada.motivo } : {}),
      },
      ahora,
    );
    const p = mutacion.payload;
    await db.validaciones.add({
      user_id: userId,
      id: p.id,
      consumption_id: c.id,
      decision,
      motivo: 'motivo' in p ? p.motivo : null,
      validado_por: userId,
      client_created_at: p.client_created_at,
      servidor: null,
      servidor_diferido: null,
      estado_local: 'pendiente_sync',
      ultimo_resultado: null,
      error_sync: null,
      actualizado_at: ahora,
    });
    await encolar(
      userId,
      mutacion,
      {
        tabla: 'validaciones',
        entidad_id: p.id,
        consumo_id: c.id,
        claves: [
          claveEntidad(userId, 'validaciones', p.id),
          claveEntidad(userId, 'consumos', c.id),
        ],
      },
      ahora,
    );
    await registrarEvento(
      userId,
      tipo === 'consumo.aprobar' ? 'consumo.aprobado' : 'consumo.rechazado',
      c.id,
      c.order_id,
      ahora,
    );
    await recalcularConsumo(userId, c.id);
    return { id: p.id, mutation_id: mutacion.mutation_id };
  });
}

/** Aprobación del jefe que tolera cortes (S5). */
export function aprobarLocal(
  userId: string,
  entrada: EntradaAprobarLocal,
): Promise<AccionRegistrada> {
  return validarConsumoLocal(userId, 'consumo.aprobar', entrada);
}

/** Rechazo del jefe con motivo obligatorio (S5). */
export function rechazarLocal(
  userId: string,
  entrada: EntradaRechazarLocal,
): Promise<AccionRegistrada> {
  return validarConsumoLocal(userId, 'consumo.rechazar', entrada);
}

// ---------------------------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------------------------

export const RETRASO_BASE_MS = 2_000;
/** Máximo entre intentos (§6 punto 4): 5 min, jitter incluido. */
export const RETRASO_MAXIMO_MS = 300_000;

/**
 * Retraso exponencial con jitter "igual": `e = min(5 min, 2 s × 2^(intentos−1))` y el retraso cae en
 * `[e/2, e]`. Nunca supera 5 min. `aleatorio` devuelve un valor en [0, 1).
 */
export function calcularRetrasoMs(intentos: number, aleatorio: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(Number.isFinite(intentos) ? intentos : 1));
  const exponencial = Math.min(RETRASO_MAXIMO_MS, RETRASO_BASE_MS * 2 ** Math.min(n - 1, 30));
  const r = Math.min(1, Math.max(0, aleatorio()));
  return Math.min(RETRASO_MAXIMO_MS, Math.round(exponencial / 2 + (r * exponencial) / 2));
}

/** Devuelve la mutación de nuevo `pendiente`, con su siguiente intento programado. */
export function programarReintento(
  mutacion: MutacionOutbox,
  ahora: Date,
  aleatorio: () => number = Math.random,
): MutacionOutbox {
  return {
    ...mutacion,
    estado: 'pendiente',
    siguiente_intento_at: new Date(
      ahora.getTime() + calcularRetrasoMs(mutacion.intentos, aleatorio),
    ).toISOString(),
    actualizada_at: ahora.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Consultas y transiciones del motor
// ---------------------------------------------------------------------------------------------

function listaParaEnviar(m: MutacionOutbox, ahora: Date): boolean {
  return (
    m.estado === 'pendiente' &&
    (m.siguiente_intento_at === null || Date.parse(m.siguiente_intento_at) <= ahora.getTime())
  );
}

/**
 * Siguiente lote del usuario de la sesión, EN ORDEN de `seq_local`, con máximo `max` (≤ 25).
 * Se salta las mutaciones que aún esperan su backoff o que están `enviando`, y también todas las
 * posteriores del MISMO consumo (dependencias: una edición o novedad nunca sale antes que la
 * creación de su consumo ni que una edición previa).
 */
export async function siguienteLote(
  userId: string,
  max: number = MAX_MUTACIONES_POR_LOTE,
  ahora: Date = new Date(),
): Promise<MutacionOutbox[]> {
  const limite = Math.min(MAX_MUTACIONES_POR_LOTE, Math.max(1, Math.floor(max)));
  return db.transaction('r', db.outbox, async () => {
    const cola = await mutacionesEnColaDeUsuario(userId);
    const bloqueados = new Set<string>();
    const lote: MutacionOutbox[] = [];
    for (const m of cola) {
      if (lote.length >= limite) {
        break;
      }
      if (m.user_id !== userId) {
        continue;
      }
      if (bloqueados.has(m.consumo_id) || !listaParaEnviar(m, ahora)) {
        bloqueados.add(m.consumo_id);
        continue;
      }
      lote.push(m);
    }
    return lote;
  });
}

/** Marca el lote como `enviando` (e incrementa `intentos`) justo antes de enviarlo. */
export async function marcarEnviando(
  userId: string,
  lote: readonly Pick<MutacionOutbox, 'mutation_id'>[],
  ahora: Date = new Date(),
): Promise<MutacionOutbox[]> {
  const iso = ahora.toISOString();
  return db.transaction('rw', db.outbox, async () => {
    const marcadas: MutacionOutbox[] = [];
    for (const { mutation_id } of lote) {
      const m = await db.outbox.get(mutation_id);
      if (m === undefined) {
        throw new ErrorDatosLocales('NO_ENCONTRADO');
      }
      if (m.user_id !== userId) {
        throw new ErrorDatosLocales('AUTOR_NO_COINCIDE');
      }
      if (m.estado !== 'pendiente') {
        throw new ErrorDatosLocales('CONFLICTO', 'La mutación ya no está pendiente de envío.');
      }
      const actualizada: MutacionOutbox = {
        ...m,
        estado: 'enviando',
        intentos: m.intentos + 1,
        enviada_at: iso,
        actualizada_at: iso,
      };
      await db.outbox.put(actualizada);
      marcadas.push(actualizada);
    }
    return marcadas;
  });
}

/**
 * Devuelve a `pendiente` las mutaciones que quedaron `enviando` (la app se cerró o se perdió la
 * respuesta). El reenvío es seguro: el servidor es idempotente por `mutation_id`. El motor la llama
 * al tomar el candado, antes de pedir el siguiente lote.
 */
export async function recuperarEnviando(userId: string, ahora: Date = new Date()): Promise<number> {
  return db.transaction('rw', db.outbox, async () => {
    const enviando = await db.outbox
      .where('[user_id+estado+seq_local]')
      .between(...rangoDe(userId, 'enviando'))
      .toArray();
    for (const m of enviando) {
      await db.outbox.put({ ...m, estado: 'pendiente', actualizada_at: ahora.toISOString() });
    }
    return enviando.length;
  });
}

export interface ResumenResultados {
  aplicadas: number;
  rechazadas: number;
  conflictos: number;
  /** Sin resultado (error transitorio): vuelven a `pendiente` con backoff. */
  sin_resultado: number;
  /** Rechazadas localmente con `DEPENDENCIA_RECHAZADA`. */
  dependientes_rechazadas: number;
  /** Siguiente intento programado para las que quedaron sin resultado. */
  siguiente_intento_at: string | null;
}

function errorDe(r: ResultadoMutacion, codigoPorDefecto: 'CONFLICTO' | null): ErrorSync {
  const code = r.code ?? codigoPorDefecto;
  return {
    code,
    message:
      r.message ?? (code !== null ? MENSAJES_ERROR[code] : 'El servidor rechazó el registro.'),
  };
}

async function marcarUltimoResultado(
  userId: string,
  m: MutacionOutbox,
  resultado: TipoResultadoMutacion,
  error: ErrorSync | null,
): Promise<void> {
  const clave: [string, string] = [userId, m.entidad_id];
  const nuevo = (
    actual: UltimoResultado | null,
    versionServidor: number | null,
  ): UltimoResultado | null =>
    actual !== null && actual.seq_local > m.seq_local
      ? null
      : { resultado, seq_local: m.seq_local, error, version_servidor: versionServidor };

  if (m.tabla === 'consumos') {
    const fila = await db.consumos.get(clave);
    const ultimo = fila && nuevo(fila.ultimo_resultado, fila.servidor?.version ?? null);
    if (fila !== undefined && ultimo) {
      await db.consumos.put({ ...fila, ultimo_resultado: ultimo });
    }
  } else if (m.tabla === 'novedades') {
    const fila = await db.novedades.get(clave);
    const ultimo = fila && nuevo(fila.ultimo_resultado, null);
    if (fila !== undefined && ultimo) {
      await db.novedades.put({ ...fila, ultimo_resultado: ultimo });
    }
  } else if (m.tabla === 'validaciones') {
    const fila = await db.validaciones.get(clave);
    const ultimo = fila && nuevo(fila.ultimo_resultado, null);
    if (fila !== undefined && ultimo) {
      await db.validaciones.put({ ...fila, ultimo_resultado: ultimo });
    }
  }
}

async function bloquearFotos(
  userId: string,
  m: MutacionOutbox,
  error: ErrorSync,
  ahora: string,
): Promise<void> {
  if (m.tipo !== 'novedad.crear') {
    return;
  }
  for (const { id } of m.payload.evidencias) {
    const e = await db.evidencias.get([userId, id]);
    if (e !== undefined && e.estado_subida === 'pendiente') {
      await db.evidencias.put({
        ...e,
        estado_subida: 'bloqueada',
        error_subida: error,
        actualizado_at: ahora,
      });
    }
  }
}

/** Rechaza localmente las mutaciones en cola que dependen de la creación rechazada de un consumo. */
async function rechazarDependientes(
  userId: string,
  creacion: MutacionOutbox,
  ahora: string,
  afectadas: EntidadAfectada[],
): Promise<number> {
  const error: ErrorSync = {
    code: 'DEPENDENCIA_RECHAZADA',
    message: MENSAJES_ERROR.DEPENDENCIA_RECHAZADA,
  };
  const dependientes = (
    await db.outbox.where('[user_id+consumo_id]').equals([userId, creacion.consumo_id]).toArray()
  ).filter(
    (d) =>
      d.mutation_id !== creacion.mutation_id &&
      d.seq_local > creacion.seq_local &&
      estaEnCola(d.estado),
  );
  for (const d of dependientes) {
    await db.outbox.put({
      ...d,
      estado: 'rechazada',
      error,
      siguiente_intento_at: null,
      actualizada_at: ahora,
    });
    // En el consumo se conserva el error de su creación (es la causa); el resto se marca.
    if (d.tabla !== 'consumos') {
      await marcarUltimoResultado(userId, d, 'rechazada', error);
    }
    await bloquearFotos(userId, d, error, ahora);
    afectadas.push(...entidadesDe(d));
  }
  return dependientes.length;
}

function entidadesDe(m: MutacionOutbox): EntidadAfectada[] {
  return m.claves.map(leerClave).filter((c): c is EntidadAfectada => c !== null);
}

/** En un conflicto, el estado del servidor solo se adopta si la entidad ya existía allí. */
function conflictoSobreEntidadExistente(m: MutacionOutbox): boolean {
  return m.tipo !== 'consumo.crear' && m.tipo !== 'novedad.crear';
}

/**
 * Aplica la respuesta de `/sync/push` al lote enviado. Cada resultado se asocia por `mutation_id`
 * (o por `indice` si el servidor no pudo leerlo); un resultado cuyo `mutation_id` no coincide se
 * ignora. Las mutaciones sin resultado vuelven a `pendiente` con UN mismo siguiente intento (así
 * conservan su orden relativo).
 */
export async function aplicarResultados(
  userId: string,
  lote: readonly Pick<MutacionOutbox, 'mutation_id'>[],
  resultados: readonly ResultadoMutacion[],
  opciones: OpcionesTiempo = {},
): Promise<ResumenResultados> {
  const ahora = opciones.ahora ?? new Date();
  const iso = ahora.toISOString();
  const porId = new Map<string, ResultadoMutacion>();
  const porIndice = new Map<number, ResultadoMutacion>();
  for (const r of resultados) {
    if (r.mutation_id !== undefined) {
      porId.set(r.mutation_id, r);
    }
    porIndice.set(r.indice, r);
  }

  return db.transaction('rw', tablasDeDatos(), async () => {
    const resumen: ResumenResultados = {
      aplicadas: 0,
      rechazadas: 0,
      conflictos: 0,
      sin_resultado: 0,
      dependientes_rechazadas: 0,
      siguiente_intento_at: null,
    };
    const afectadas: EntidadAfectada[] = [];
    const sinResultado: MutacionOutbox[] = [];

    for (const [indice, enviada] of lote.entries()) {
      const m = await db.outbox.get(enviada.mutation_id);
      if (m === undefined) {
        continue;
      }
      if (m.user_id !== userId) {
        throw new ErrorDatosLocales('AUTOR_NO_COINCIDE');
      }
      if (!estaEnCola(m.estado)) {
        continue;
      }
      const candidato = porId.get(m.mutation_id) ?? porIndice.get(indice);
      const r =
        candidato !== undefined &&
        (candidato.mutation_id === undefined || candidato.mutation_id === m.mutation_id)
          ? candidato
          : undefined;
      if (r === undefined) {
        sinResultado.push(m);
        continue;
      }
      afectadas.push(...entidadesDe(m));

      if (r.resultado === 'aplicada') {
        await db.outbox.put({
          ...m,
          estado: 'aplicada',
          aplicada_at: iso,
          error: null,
          siguiente_intento_at: null,
          actualizada_at: iso,
        });
        afectadas.push(
          ...(await guardarEntidadesServidor(userId, extraerEntidades(r.servidor), 'propio', iso)),
        );
        await marcarUltimoResultado(userId, m, 'aplicada', null);
        resumen.aplicadas += 1;
      } else if (r.resultado === 'rechazada') {
        const error = errorDe(r, null);
        await db.outbox.put({
          ...m,
          estado: 'rechazada',
          error,
          siguiente_intento_at: null,
          actualizada_at: iso,
        });
        await marcarUltimoResultado(userId, m, 'rechazada', error);
        await bloquearFotos(userId, m, error, iso);
        if (m.tipo === 'consumo.crear') {
          resumen.dependientes_rechazadas += await rechazarDependientes(userId, m, iso, afectadas);
        }
        resumen.rechazadas += 1;
      } else {
        const error = errorDe(r, 'CONFLICTO');
        await db.outbox.put({
          ...m,
          estado: 'conflicto',
          error,
          siguiente_intento_at: null,
          actualizada_at: iso,
        });
        if (conflictoSobreEntidadExistente(m)) {
          afectadas.push(
            ...(await guardarEntidadesServidor(
              userId,
              extraerEntidades(r.servidor),
              'propio',
              iso,
            )),
          );
        }
        if (m.tabla === 'consumos') {
          await db.consumos.update([userId, m.entidad_id], {
            conflicto_servidor: r.servidor ?? null,
          });
        }
        await marcarUltimoResultado(userId, m, 'conflicto', error);
        resumen.conflictos += 1;
      }
    }

    if (sinResultado.length > 0) {
      // Un solo instante para todas: con jitter independiente se podrían desordenar.
      const masIntentos = sinResultado.reduce((a, b) => (b.intentos > a.intentos ? b : a));
      const programada = programarReintento(masIntentos, ahora, opciones.aleatorio);
      for (const m of sinResultado) {
        await db.outbox.put({
          ...m,
          estado: 'pendiente',
          siguiente_intento_at: programada.siguiente_intento_at,
          actualizada_at: iso,
        });
      }
      resumen.sin_resultado = sinResultado.length;
      resumen.siguiente_intento_at = programada.siguiente_intento_at;
    }

    await recalcular(userId, afectadas);
    return resumen;
  });
}

// ---------------------------------------------------------------------------------------------
// Conteos, retención y cierre de sesión
// ---------------------------------------------------------------------------------------------

/** Mutaciones del usuario que aún deben llegar al servidor (pendiente + enviando). */
export async function contarPendientes(userId: string): Promise<number> {
  const indice = '[user_id+estado+seq_local]';
  const pendientes = await db.outbox
    .where(indice)
    .between(...rangoDe(userId, 'pendiente'))
    .count();
  const enviando = await db.outbox
    .where(indice)
    .between(...rangoDe(userId, 'enviando'))
    .count();
  return pendientes + enviando;
}

/** Fotos del usuario con bytes locales aún no subidos. */
export async function contarEvidenciasPendientes(userId: string): Promise<number> {
  return db.evidencias.where('[user_id+estado_subida]').equals([userId, 'pendiente']).count();
}

export interface PendientesDeUsuario {
  user_id: string;
  /** Nombre del perfil cacheado, si existe. */
  nombre: string | null;
  mutaciones: number;
  evidencias: number;
}

/**
 * Pendientes de TODOS los usuarios del dispositivo, para el aviso "Hay N registros pendientes de
 * <A>" (§5). La UI excluye al usuario de la sesión.
 */
export async function pendientesPorUsuario(): Promise<PendientesDeUsuario[]> {
  return db.transaction('r', [db.outbox, db.evidencias, db.perfiles], async () => {
    const porUsuario = new Map<string, PendientesDeUsuario>();
    const entrada = (userId: string): PendientesDeUsuario => {
      let actual = porUsuario.get(userId);
      if (actual === undefined) {
        actual = { user_id: userId, nombre: null, mutaciones: 0, evidencias: 0 };
        porUsuario.set(userId, actual);
      }
      return actual;
    };
    const cola = await db.outbox.where('estado').anyOf('pendiente', 'enviando').toArray();
    for (const m of cola) {
      entrada(m.user_id).mutaciones += 1;
    }
    const fotos = await db.evidencias.where('estado_subida').equals('pendiente').toArray();
    for (const e of fotos) {
      entrada(e.user_id).evidencias += 1;
    }
    for (const p of porUsuario.values()) {
      p.nombre = (await db.perfiles.get(p.user_id))?.perfil.nombre ?? null;
    }
    return [...porUsuario.values()].sort((a, b) => a.user_id.localeCompare(b.user_id));
  });
}

const MS_POR_DIA = 86_400_000;

/**
 * Purga las mutaciones `aplicada` del usuario con más de 7 días (ADR 0009). Nunca toca las
 * `rechazada` ni las `conflicto`. Libera también los bytes de las fotos subidas hace más de 7 días.
 */
export async function purgarAplicadasAntiguas(
  userId: string,
  ahora: Date = new Date(),
): Promise<{ mutaciones: number; fotos_liberadas: number }> {
  const limite = new Date(
    ahora.getTime() - RETENCION_MUTACIONES_APLICADAS_DIAS * MS_POR_DIA,
  ).toISOString();
  return db.transaction('rw', [db.outbox, db.evidencias], async () => {
    const viejas = await db.outbox
      .where('[user_id+estado+seq_local]')
      .between(...rangoDe(userId, 'aplicada'))
      .filter((m) => m.estado === 'aplicada' && m.aplicada_at !== null && m.aplicada_at < limite)
      .primaryKeys();
    await db.outbox.bulkDelete(viejas);
    const subidas = await db.evidencias
      .where('[user_id+estado_subida]')
      .equals([userId, 'subida'])
      .filter((e) => e.datos !== null && e.subido_at !== null && e.subido_at < limite)
      .toArray();
    for (const e of subidas) {
      await db.evidencias.put({ ...e, datos: null, actualizado_at: ahora.toISOString() });
    }
    return { mutaciones: viejas.length, fotos_liberadas: subidas.length };
  });
}

export interface EstadoBorrado {
  puede: boolean;
  mutaciones: number;
  evidencias: number;
}

/** Cerrar sesión solo borra los datos del usuario si no tiene pendientes (§5). */
export async function puedeBorrarDatosDeUsuario(userId: string): Promise<EstadoBorrado> {
  return db.transaction('r', [db.outbox, db.evidencias], async () => {
    const mutaciones = await contarPendientes(userId);
    const evidencias = await contarEvidenciasPendientes(userId);
    return { puede: mutaciones === 0 && evidencias === 0, mutaciones, evidencias };
  });
}

/**
 * Borra los datos locales del usuario. Falla con `PENDIENTES_LOCALES` si tiene pendientes (la UI
 * debe advertirle antes). Conserva las mutaciones `rechazada`/`conflicto` y las entidades que
 * afectan (incluidas sus fotos): son datos de planta que nunca se borran solos (ADR 0012).
 * `conservarPerfil` mantiene el perfil y el verificador del login offline.
 */
export async function borrarDatosDeUsuario(
  userId: string,
  opciones: { conservarPerfil?: boolean } = {},
): Promise<{ conservadas: number }> {
  return db.transaction('rw', tablasDeDatos(), async () => {
    const estado = await puedeBorrarDatosDeUsuario(userId);
    if (!estado.puede) {
      throw new ErrorDatosLocales('PENDIENTES_LOCALES');
    }
    const outbox = await db.outbox
      .where('[user_id+seq_local]')
      .between(...rangoDe(userId))
      .toArray();
    const conservar = new Set<string>();
    let conservadas = 0;
    for (const m of outbox) {
      if (m.estado === 'rechazada' || m.estado === 'conflicto') {
        conservadas += 1;
        m.claves.forEach((clave) => conservar.add(clave));
      } else {
        await db.outbox.delete(m.mutation_id);
      }
    }
    const rango = rangoDe(userId);
    const mutables: [TablaMutable, Table<unknown, [string, string]>][] = [
      ['consumos', db.consumos],
      ['novedades', db.novedades],
      ['evidencias', db.evidencias],
      ['validaciones', db.validaciones],
    ];
    for (const [nombre, tabla] of mutables) {
      const claves = await tabla
        .where(':id')
        .between(...rango)
        .primaryKeys();
      const borrar = claves.filter(([, id]) => !conservar.has(claveEntidad(userId, nombre, id)));
      await tabla.bulkDelete(borrar);
    }
    for (const tabla of [
      db.ordenes,
      db.planeados,
      db.asignaciones,
      db.materiales,
      db.settings,
      db.usuarios,
    ]) {
      await tabla
        .where(':id')
        .between(...rango)
        .delete();
    }
    await db.trazabilidad
      .where('[user_id+ts]')
      .between(...rango)
      .delete();
    await db.meta.delete(userId);
    if (opciones.conservarPerfil !== true) {
      await db.perfiles.delete(userId);
    }
    return { conservadas };
  });
}

// ---------------------------------------------------------------------------------------------
// Evidencias (para el motor de subida, tarea 3.5)
// ---------------------------------------------------------------------------------------------

/**
 * Fotos del usuario listas para `PUT /evidences/:id`: con bytes locales, subida `pendiente`, backoff
 * cumplido y cuya novedad ya quedó `aplicada` en el servidor (§6 punto 5).
 */
export async function evidenciasListasParaSubir(
  userId: string,
  ahora: Date = new Date(),
): Promise<{ id: string; mime: MimeEvidencia; sha256: string; datos: ArrayBuffer }[]> {
  return db.transaction('r', [db.evidencias, db.novedades], async () => {
    const pendientes = await db.evidencias
      .where('[user_id+estado_subida]')
      .equals([userId, 'pendiente'])
      .toArray();
    const listas = [];
    for (const e of pendientes) {
      if (
        e.datos === null ||
        (e.siguiente_intento_at !== null && Date.parse(e.siguiente_intento_at) > ahora.getTime())
      ) {
        continue;
      }
      const novedad = await db.novedades.get([userId, e.incident_id]);
      if (novedad?.estado_local === 'sincronizado') {
        listas.push({ id: e.id, mime: e.mime, sha256: e.sha256, datos: e.datos });
      }
    }
    return listas;
  });
}

/** La foto quedó subida (también si el servidor responde `EVIDENCIA_YA_SUBIDA`). */
export async function marcarEvidenciaSubida(
  userId: string,
  id: string,
  ahora: Date = new Date(),
): Promise<void> {
  const iso = ahora.toISOString();
  await db.evidencias.update([userId, id], {
    estado_subida: 'subida',
    subido_at: iso,
    error_subida: null,
    siguiente_intento_at: null,
    actualizado_at: iso,
  });
}

/** Fallo de subida (por ejemplo `EVIDENCIA_DESCONOCIDA`): se reintenta con backoff. */
export async function programarReintentoEvidencia(
  userId: string,
  id: string,
  error: ErrorSync,
  opciones: OpcionesTiempo = {},
): Promise<void> {
  const ahora = opciones.ahora ?? new Date();
  await db.transaction('rw', db.evidencias, async () => {
    const e = await db.evidencias.get([userId, id]);
    if (e === undefined) {
      return;
    }
    const intentos = e.intentos_subida + 1;
    await db.evidencias.put({
      ...e,
      intentos_subida: intentos,
      error_subida: error,
      siguiente_intento_at: new Date(
        ahora.getTime() + calcularRetrasoMs(intentos, opciones.aleatorio),
      ).toISOString(),
      actualizado_at: ahora.toISOString(),
    });
  });
}

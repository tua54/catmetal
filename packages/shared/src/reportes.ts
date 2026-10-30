// Contratos de la consulta de auditoría, la línea de tiempo de una orden y los reportes
// (docs/spec.md §3, §7 y §8; docs/plan-fase-2.md tarea 2.4), y utilidades puras del CSV de
// exportación (UTF-8 con BOM, separador `;`, CRLF y neutralización de fórmulas).

import { z } from 'zod';
import { ENTIDADES_SYNC, type EstadoOrden, type Rol, type Unidad, ZONA_HORARIA } from './dominio';
import { isoFechaSchema } from './esquemas';

// ---------------------------------------------------------------------------------------------
// Query de `GET /audit` y de `GET /orders/:id/audit`
// ---------------------------------------------------------------------------------------------

/** Entidades que pueden aparecer en `audit_log.entidad` (nombres de tabla de D1). */
export const ENTIDADES_AUDITORIA = [...ENTIDADES_SYNC, 'devices', 'refresh_tokens'] as const;
export type EntidadAuditoria = (typeof ENTIDADES_AUDITORIA)[number];

/** Tamaño de página por defecto de la auditoría y de la línea de tiempo. */
export const LIMITE_AUDITORIA_DEFECTO = 50;
/** Tamaño de página máximo de la auditoría y de la línea de tiempo. */
export const LIMITE_AUDITORIA_MAXIMO = 200;

const MENSAJE_LIMITE_AUDITORIA = `El límite debe ser un entero entre 1 y ${LIMITE_AUDITORIA_MAXIMO}.`;
const MENSAJE_CURSOR_SEQ = 'El cursor debe ser un número de secuencia entero positivo.';

const limiteAuditoriaSchema = z
  .string({ error: MENSAJE_LIMITE_AUDITORIA })
  .regex(/^[1-9]\d{0,2}$/, { error: MENSAJE_LIMITE_AUDITORIA })
  .transform(Number)
  .refine((n) => n <= LIMITE_AUDITORIA_MAXIMO, { error: MENSAJE_LIMITE_AUDITORIA });

/**
 * Cursor de la auditoría: un `audit_log.seq` (entero positivo, sin signo ni ceros a la izquierda).
 * Máximo 15 dígitos: siempre es un entero exacto en JS (< 2^53).
 */
export const cursorSeqSchema = z
  .string({ error: MENSAJE_CURSOR_SEQ })
  .regex(/^[1-9]\d{0,14}$/, { error: MENSAJE_CURSOR_SEQ })
  .transform(Number);

/** `entidad_id`: un UUID, un id compuesto (`<order_id>:<user_id>`) o una clave de `settings`. */
const entidadIdSchema = z
  .string({ error: 'El identificador de la entidad no es válido.' })
  .regex(/^[0-9A-Za-z_.:-]{1,100}$/, { error: 'El identificador de la entidad no es válido.' });

/**
 * `GET /audit?entidad=&entidad_id=&desde=&hasta=&cursor=&limite=`.
 * `desde` y `hasta` filtran por `server_at` y ambos son inclusivos. Orden descendente por `seq`:
 * el cursor es el `seq` de la última entrada recibida y se piden las de `seq` menor.
 */
export const auditoriaQuerySchema = z
  .object({
    entidad: z.enum(ENTIDADES_AUDITORIA, { error: 'La entidad no es válida.' }).optional(),
    entidad_id: entidadIdSchema.optional(),
    desde: isoFechaSchema.optional(),
    hasta: isoFechaSchema.optional(),
    cursor: cursorSeqSchema.optional(),
    limite: limiteAuditoriaSchema.optional(),
  })
  .refine((q) => q.desde === undefined || q.hasta === undefined || q.desde <= q.hasta, {
    error: 'La fecha "desde" no puede ser posterior a "hasta".',
    path: ['hasta'],
  });

/**
 * `GET /orders/:id/audit?cursor=&limite=`. Orden ascendente (cronológico) por `seq`: el cursor es
 * el `seq` del último evento recibido y se piden los de `seq` mayor.
 */
export const lineaTiempoQuerySchema = z.object({
  cursor: cursorSeqSchema.optional(),
  limite: limiteAuditoriaSchema.optional(),
});

export type AuditoriaQuery = z.infer<typeof auditoriaQuerySchema>;
export type LineaTiempoQuery = z.infer<typeof lineaTiempoQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Respuestas de auditoría
// ---------------------------------------------------------------------------------------------

/** Quien hizo la acción, con su nombre y rol ACTUALES. `null` en acciones del sistema. */
export interface ActorAuditoria {
  id: string;
  nombre: string;
  rol: Rol;
}

/** Entrada de `GET /audit` (sin columnas de otras tablas; `datos_*` ya parseados). */
export interface EntradaAuditoriaApi {
  seq: number;
  id: string;
  entidad: string;
  entidad_id: string;
  /** Orden a la que pertenece la entidad (ADR 0010), o `null`. */
  order_id: string | null;
  accion: string;
  actor: ActorAuditoria | null;
  device_id: string | null;
  datos_antes: Record<string, unknown> | null;
  datos_despues: Record<string, unknown> | null;
  client_at: string | null;
  server_at: string;
  alerta_reloj: boolean;
}

/** Respuesta de `GET /audit`. `siguiente_cursor` es un `seq` o `null` si no hay más. */
export interface ListaAuditoria {
  entradas: EntradaAuditoriaApi[];
  siguiente_cursor: number | null;
}

/** Tipo del evento de la línea de tiempo (lo usa la UI para el color). */
export const TIPOS_EVENTO_LINEA_TIEMPO = [
  'sistema',
  'registro',
  'novedad',
  'validacion',
  'rechazo',
] as const;
export type TipoEventoLineaTiempo = (typeof TIPOS_EVENTO_LINEA_TIEMPO)[number];

/** Evento de la línea de tiempo de una orden, con su descripción en español. */
export interface EventoLineaTiempo {
  seq: number;
  id: string;
  entidad: string;
  entidad_id: string;
  accion: string;
  tipo: TipoEventoLineaTiempo;
  /** Generada en el servidor, por ejemplo "Registró 125,5 kg de Resina furánica + novedad". */
  descripcion: string;
  /** Consumo relacionado (consumo, novedad, evidencia o validación), para enlazar al detalle. */
  consumption_id: string | null;
  actor: ActorAuditoria | null;
  device_id: string | null;
  client_at: string | null;
  server_at: string;
  alerta_reloj: boolean;
}

/** Respuesta de `GET /orders/:id/audit`. */
export interface LineaTiempoOrden {
  order_id: string;
  codigo: string;
  eventos: EventoLineaTiempo[];
  siguiente_cursor: number | null;
}

// ---------------------------------------------------------------------------------------------
// Resumen de la orden
// ---------------------------------------------------------------------------------------------

/** Real vs planeado de un material planeado. Solo cuentan los consumos no rechazados. */
export interface ResumenMaterial {
  material_id: string;
  codigo: string;
  nombre: string;
  /** Unidad del plan (la de `cantidad_planeada` y `consumido`). */
  unidad: Unidad;
  cantidad_planeada: number;
  /** Σ `cantidad_en_unidad_plan`. */
  consumido: number;
  /** `consumido / cantidad_planeada × 100`, con 2 decimales. */
  porcentaje: number;
  /** Σ costo de cada consumo con su costo congelado, en pesos. */
  costo_cop: number;
  /** Número de consumos no rechazados del material. */
  registros: number;
  excede_tolerancia: boolean;
}

/** Consumo (no rechazado) de un material que no está en el plan (P10), en la unidad del material. */
export interface ResumenMaterialFueraDePlan {
  material_id: string;
  codigo: string;
  nombre: string;
  unidad: Unidad;
  consumido: number;
  costo_cop: number;
  registros: number;
}

export interface TotalesResumen {
  /** Número de consumos no rechazados (pendientes y aprobados). */
  materiales_consumidos: number;
  /** Σ costos congelados de los consumos no rechazados, en pesos (S12). */
  costo_total_cop: number;
  /** Consumos pendientes con novedad o con `requiere_novedad` (aún sin justificar). */
  novedades_abiertas: number;
  /** De las abiertas: pendientes con `requiere_novedad` y sin ninguna novedad ("Falta novedad"). */
  novedades_faltantes: number;
  pendientes: number;
  aprobados: number;
  rechazados: number;
}

/** Respuesta de `GET /reports/orders/:id/summary`. */
export interface ResumenOrden {
  order_id: string;
  codigo: string;
  linea: string;
  estado: EstadoOrden;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  tolerancia_pct: number;
  materiales: ResumenMaterial[];
  materiales_fuera_de_plan: ResumenMaterialFueraDePlan[];
  totales: TotalesResumen;
}

// ---------------------------------------------------------------------------------------------
// CSV (Excel en español)
// ---------------------------------------------------------------------------------------------

export const BOM_CSV = String.fromCharCode(0xfeff);
export const SEPARADOR_CSV = ';';
export const FIN_LINEA_CSV = '\r\n';

/** Valor de una celda: texto, número (sin comillas, coma decimal), booleano (Sí/No) o vacío. */
export type CeldaCsv = string | number | boolean | null | undefined;

/**
 * Primeros caracteres que una hoja de cálculo interpreta como fórmula o como comando (OWASP "CSV
 * Injection"): `=`, `+`, `-`, `@`, tabulador, CR y LF, y sus variantes de ancho completo
 * (＝ ＋ － ＠), que algunas versiones de Excel normalizan.
 */
const INICIO_PELIGROSO = /^[=+\-@\t\r\n＝＋－＠]/;

/** Prefija con `'` el texto que empieza como una fórmula, para que Excel lo trate como texto. */
export function neutralizarCeldaCsv(valor: string): string {
  return INICIO_PELIGROSO.test(valor) ? `'${valor}` : valor;
}

const REQUIERE_COMILLAS = /[;"\r\n]/;

/** Celda de texto: neutralizada y entre comillas dobles si contiene `;`, `"`, CR o LF. */
function textoCsv(valor: string): string {
  const neutro = neutralizarCeldaCsv(valor);
  return REQUIERE_COMILLAS.test(neutro) ? `"${neutro.replaceAll('"', '""')}"` : neutro;
}

/**
 * Número para Excel en español: coma decimal, sin separador de miles ni notación exponencial,
 * hasta 6 decimales sin ceros sobrantes (`1234.5` → `1234,5`). Un valor no finito queda vacío.
 */
export function numeroCsv(valor: number): string {
  if (!Number.isFinite(valor)) {
    return '';
  }
  const fijo = valor.toFixed(6).replace(/\.?0+$/, '');
  return (fijo === '-0' ? '0' : fijo).replace('.', ',');
}

export function celdaCsv(valor: CeldaCsv): string {
  if (valor === null || valor === undefined) {
    return '';
  }
  if (typeof valor === 'number') {
    return numeroCsv(valor);
  }
  if (typeof valor === 'boolean') {
    return valor ? 'Sí' : 'No';
  }
  return textoCsv(valor);
}

/** Una fila del CSV, terminada en CRLF. */
export function filaCsv(celdas: readonly CeldaCsv[]): string {
  return celdas.map(celdaCsv).join(SEPARADOR_CSV) + FIN_LINEA_CSV;
}

/** Nombre de archivo seguro para `Content-Disposition`: `<codigo>-consumos.csv`. */
export function nombreArchivoCsv(codigo: string): string {
  const base = codigo
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 80);
  return `${base === '' ? 'orden' : base}-consumos.csv`;
}

const formatoFechaHoraCsv = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Fecha y hora de Bogotá para el CSV: `AAAA-MM-DD HH:mm:ss` (Excel la reconoce como fecha).
 * `null` o una fecha no válida → `''`.
 */
export function fechaHoraBogotaCsv(iso: string | null): string {
  const fecha = iso === null ? null : new Date(iso);
  if (fecha === null || Number.isNaN(fecha.getTime())) {
    return '';
  }
  const partes = formatoFechaHoraCsv.formatToParts(fecha);
  const valor = (tipo: Intl.DateTimeFormatPartTypes): string =>
    partes.find((parte) => parte.type === tipo)?.value ?? '';
  return `${valor('year')}-${valor('month')}-${valor('day')} ${valor('hour')}:${valor('minute')}:${valor('second')}`;
}

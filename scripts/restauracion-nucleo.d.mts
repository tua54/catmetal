// Tipos de restauracion-nucleo.mjs, para que la prueba del Worker (TypeScript) lo importe (ADR 0021).

export type Fila = Record<string, unknown>;

export interface TriggerEsperado {
  nombre: string;
  sql: string;
}

export interface DefinicionTabla {
  clase: 'revertible' | 'ultimo_valor' | 'operativa' | 'no_restaurada';
  pk: string[];
  columnas: string[];
  booleanas: string[];
  json?: string[];
  inmutables?: string[];
}

export const MAX_BYTES_SENTENCIA: number;
export const MAX_FILAS_SENTENCIA: number;
export const MARGEN_NO_APLICADAS_MS: number;
export const INCOMPLETAS_ADMITIDAS: string[];
export const NO_EXPORTADAS: string[];
export const TABLAS: Record<string, DefinicionTabla>;
export const ORDEN_IMPORTACION: string[];
export const TABLAS_AUDITADAS: string[];
export const SQL_POST_RESTAURACION: string[];

export class ErrorRestauracion extends Error {
  constructor(codigo: 'INTEGRIDAD' | 'SIN_AUDITORIA', mensaje: string, detalle?: unknown);
  readonly codigo: 'INTEGRIDAD' | 'SIN_AUDITORIA';
  readonly detalle: unknown;
}

export interface AccionAuditada {
  seq: number;
  accion: string;
  actor_id: string | null;
  server_at: string;
}

export interface ConteoTabla {
  exportadas: number;
  importadas: number;
  excluidas: number;
  revertidas: number;
  conservadas_mas_recientes: number;
  recortadas: number;
  sin_auditoria_conservadas: number;
}

export interface InformeRestauracion {
  fecha: string;
  corte: { seq: number; at: string };
  seq_final: number;
  tablas: Record<string, ConteoTabla>;
  sync_mutations: {
    aplicadas_conservadas: number;
    aplicadas_sin_efecto_descartadas: number;
    no_aplicadas_conservadas: number;
    aplicadas_demasiado_grandes_descartadas: number;
    no_aplicadas_descartadas: number;
    tabla_omitida: boolean;
    /** La omitió `--omitir-sync-mutations` (y no un backup parcial). */
    omitida_por_opcion: boolean;
  };
  refresh_tokens_omitidos: number;
  login_cupos_omitida: boolean;
  cambios_tras_el_corte: {
    seq: number;
    entidad: string;
    entidad_id: string;
    accion: string;
    actor_id: string | null;
    server_at: string;
  }[];
  rechazos_tras_el_corte: {
    mutation_id: string;
    user_id: string;
    tipo: string;
    resultado: string;
    code: string | null;
  }[];
  revisar_seguridad: {
    entidad: 'users';
    entidad_id: string;
    tipo: 'creado_tras_el_corte_no_restaurado' | 'cambios_tras_el_corte_conservados';
    acciones: AccionAuditada[];
  }[];
  sin_auditoria_conservadas: { tabla: string; clave: string }[];
  sin_auditoria_total: number;
}

export interface ResultadoRestauracion {
  /** Consultas legibles: cada una debe devolver 0 filas. */
  verificacion: { nombre: string; sql: string }[];
  /** Las mismas, como sentencias que abortan si alguna encuentra filas (R-02). */
  verificacionAutofallante: string[];
  postRestauracion: string[];
  informe: InformeRestauracion;
}

export interface PlanRestauracion extends ResultadoRestauracion {
  restauracion: string[];
}

export interface EntradaRestauracion {
  manifest: unknown;
  filas: Record<string, Fila[]>;
  triggers: TriggerEsperado[];
  conservarSinAuditoria?: boolean;
  omitirSyncMutations?: boolean;
}

export interface EntradaStreaming {
  manifest: unknown;
  triggers: TriggerEsperado[];
  /** Filas de la tabla en el orden del NDJSON (audit_log se lee dos veces). */
  leerTabla: (tabla: string) => AsyncIterable<Fila> | Iterable<Fila>;
  escribir: (sentencia: string) => Promise<void>;
  conservarSinAuditoria?: boolean;
  omitirSyncMutations?: boolean;
}

export function triggersDeMigraciones(
  archivos: { nombre: string; contenido: string }[],
  hasta: string,
): TriggerEsperado[];
export function filasDeNdjson(texto: string): Fila[];
export function literal(valor: unknown): string;
export function restaurarEnStreaming(entrada: EntradaStreaming): Promise<ResultadoRestauracion>;
export function planificarRestauracion(entrada: EntradaRestauracion): Promise<PlanRestauracion>;
export function archivoSql(sentencias: readonly string[], encabezado?: readonly string[]): string;

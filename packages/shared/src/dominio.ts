// Constantes del dominio (docs/spec.md §1, §3, §4 y §6) y sus tipos derivados.
// Los valores coinciden con los CHECK de D1 y con los estados de la PWA; no los traduzcas ni los cambies.

export const ROLES = ['supervisor', 'jefe', 'admin'] as const;
export type Rol = (typeof ROLES)[number];

export const ESTADOS_ORDEN = ['planeada', 'en_proceso', 'finalizada', 'cancelada'] as const;
export type EstadoOrden = (typeof ESTADOS_ORDEN)[number];

export const ESTADOS_CONSUMO = ['pendiente', 'aprobado', 'rechazado'] as const;
export type EstadoConsumo = (typeof ESTADOS_CONSUMO)[number];

export const UNIDADES = ['kg', 'g', 'l', 'ml', 'und', 'm'] as const;
export type Unidad = (typeof UNIDADES)[number];

export const TIPOS_NOVEDAD = ['reproceso', 'merma', 'dano', 'error_registro', 'otro'] as const;
export type TipoNovedad = (typeof TIPOS_NOVEDAD)[number];

export const DECISIONES = ['aprobado', 'rechazado'] as const;
export type Decision = (typeof DECISIONES)[number];

/** Resultado de procesar una mutación en `/sync/push` (columna `sync_mutations.resultado`). */
export const RESULTADOS_MUTACION = ['aplicada', 'rechazada', 'conflicto'] as const;
export type TipoResultadoMutacion = (typeof RESULTADOS_MUTACION)[number];

/** Estado de una mutación en el outbox local del dispositivo. */
export const ESTADOS_OUTBOX = [
  'pendiente',
  'enviando',
  'aplicada',
  'rechazada',
  'conflicto',
] as const;
export type EstadoOutbox = (typeof ESTADOS_OUTBOX)[number];

export const TIPOS_MUTACION = [
  'consumo.crear',
  'consumo.editar',
  'novedad.crear',
  'consumo.aprobar',
  'consumo.rechazar',
] as const;
export type TipoMutacion = (typeof TIPOS_MUTACION)[number];

export const MIMES_EVIDENCIA = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MimeEvidencia = (typeof MIMES_EVIDENCIA)[number];

/**
 * Entidades que viajan en `/sync/pull` (campo `entidad`): nombres de tabla de D1 tal cual.
 * `audit_log`, `sync_mutations`, `devices` y `refresh_tokens` no se sincronizan.
 */
export const ENTIDADES_SYNC = [
  'users',
  'materials',
  'production_orders',
  'order_supervisors',
  'order_planned_materials',
  'consumptions',
  'incidents',
  'evidences',
  'validations',
  'settings',
] as const;
export type EntidadSync = (typeof ENTIDADES_SYNC)[number];

// Límites y parámetros del sistema.

/** Tolerancia por defecto sobre la cantidad planeada, en porcentaje (S7). */
export const TOLERANCIA_PCT_DEFECTO = 5;
/** Máximo de mutaciones por petición a `/sync/push`. */
export const MAX_MUTACIONES_POR_LOTE = 25;
/** Máximo de cambios devueltos por `/sync/pull`. */
export const MAX_CAMBIOS_PULL = 200;
/** Máximo de filas de `audit_log` revisadas por cada `/sync/pull`. */
export const MAX_FILAS_REVISADAS_PULL = 1000;
/** Tamaño máximo de una evidencia (foto ya comprimida), en bytes. */
export const MAX_EVIDENCIA_BYTES = 5 * 1024 * 1024;
export const MAX_EVIDENCIAS_POR_NOVEDAD = 5;
/** El runtime de Workers rechaza más de 100.000 iteraciones de PBKDF2. No subir este valor. */
export const PBKDF2_ITERACIONES_SERVIDOR = 100_000;
/** Vida del access token (JWT), en segundos: 15 min. */
export const ACCESS_TOKEN_TTL_S = 900;
/** Vida del refresh token, en segundos: 30 días. */
export const REFRESH_TOKEN_TTL_S = 2_592_000;
/**
 * Fallos de login por (cuenta, origen) en la ventana antes de bloquear ESE origen (ADR 0018): el
 * dispositivo conocido (cookie `mp_dispositivo`) o un origen desconocido (IP normalizada).
 */
export const MAX_INTENTOS_LOGIN = 5;
/**
 * Tope global de fallos por cuenta entre TODOS los orígenes desconocidos en la ventana (ADR 0018).
 * No afecta al dispositivo conocido.
 */
export const MAX_INTENTOS_LOGIN_GLOBAL = 20;
/** Ventana fija de los cupos de login, en minutos, contada desde el primer fallo (ADR 0018). */
export const VENTANA_INTENTOS_LOGIN_MINUTOS = 15;
/** Duración del bloqueo de un cupo de login, en minutos, desde el fallo que lo agota (ADR 0018). */
export const BLOQUEO_MINUTOS = 15;
/** Diferencia entre reloj del dispositivo y del servidor que activa `alerta_reloj`, en ms: 10 min. */
export const ALERTA_RELOJ_MS = 600_000;
/**
 * Ventana en la que reutilizar un refresh token ya rotado se trata como reintento por respuesta
 * perdida y no como robo (ADR 0008 punto 3), en ms: 30 s.
 */
export const VENTANA_GRACIA_REFRESH_MS = 30_000;
/**
 * Días mínimos que el cliente conserva las mutaciones `aplicada` (y los bytes de sus fotos) antes de
 * purgarlas (ADR 0009 y 0016): igual al horizonte de Time Travel de D1 (30 días), para poder
 * reenviarlas tras una restauración.
 */
export const RETENCION_MUTACIONES_APLICADAS_DIAS = 30;
/** Tamaño máximo de una mutación serializada en JSON, en bytes: 64 KiB (ADR 0009). */
export const MAX_PAYLOAD_MUTACION_BYTES = 65_536;
export const ZONA_HORARIA = 'America/Bogota';

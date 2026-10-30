// Tipos de las filas locales de IndexedDB (Dexie `catmetal-mp`, ADR 0012).
//
// Toda fila de datos lleva `user_id`: es la PARTICIÓN del usuario de la tablet compartida (§5). Dos
// usuarios que ven la misma entidad (por ejemplo, el jefe y el supervisor de un consumo) tienen cada
// uno su copia, con su propio estado de sincronización.

import type {
  CodigoError,
  Consumo,
  Decision,
  EstadoOutbox,
  Evidencia,
  MimeEvidencia,
  MutacionDe,
  Novedad,
  Orden,
  Perfil,
  Rol,
  TipoMutacion,
  TipoNovedad,
  TipoResultadoMutacion,
  Unidad,
  Validacion,
} from '@catmetal/shared';

/**
 * Estado que la UI muestra de un registro local (§6 cliente, punto 2):
 * - `pendiente_sync`: tiene mutaciones propias en la cola (pendiente o enviando).
 * - `sincronizado`: el servidor lo tiene y sigue pendiente de validación.
 * - `aprobado` / `rechazado`: decisión del jefe (el rechazo trae `motivo_rechazo`).
 * - `conflicto`: la última mutación propia volvió en conflicto de versión (`conflicto_servidor`).
 * - `rechazado_sync`: el servidor rechazó la última mutación propia (`error_sync`).
 */
export const ESTADOS_LOCALES = [
  'pendiente_sync',
  'sincronizado',
  'aprobado',
  'rechazado',
  'conflicto',
  'rechazado_sync',
] as const;
export type EstadoLocal = (typeof ESTADOS_LOCALES)[number];

/** Estados posibles de una novedad o validación local (no tienen decisión del jefe). */
export type EstadoLocalSimple = Extract<
  EstadoLocal,
  'pendiente_sync' | 'sincronizado' | 'conflicto' | 'rechazado_sync'
>;

/** Error devuelto por el servidor para una mutación (código + mensaje en español). */
export interface ErrorSync {
  code: CodigoError | null;
  message: string;
}

/** Resultado de la última mutación propia resuelta sobre una entidad. */
export interface UltimoResultado {
  resultado: TipoResultadoMutacion;
  seq_local: number;
  error: ErrorSync | null;
  /**
   * Versión del servidor conocida al resolverse. Si el servidor avanza después a una versión mayor,
   * el aviso de `conflicto`/`rechazado_sync` deja de aplicar y manda el estado del servidor.
   */
  version_servidor: number | null;
}

/** Tablas locales que pueden recibir mutaciones propias (se usan en las claves de `outbox.claves`). */
export type TablaMutable = 'consumos' | 'novedades' | 'evidencias' | 'validaciones';

// ---------------------------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------------------------

interface BaseMutacionOutbox {
  mutation_id: string;
  /** Autor de la mutación: solo sale con SU sesión (ADR 0008 punto 8). */
  user_id: string;
  /**
   * Contador local monotónico (único en el navegador). Define el ORDEN de envío aunque dos
   * mutaciones compartan `client_created_at` (mismo milisegundo o reloj que retrocede).
   */
  seq_local: number;
  /** Tabla local de la entidad principal (la que creó o modificó la mutación). */
  tabla: TablaMutable;
  /** Id de la entidad principal. */
  entidad_id: string;
  /** Consumo del que depende la mutación (la clave de dependencias del lote). */
  consumo_id: string;
  /** Claves `user_id|tabla|id` de todas las entidades locales afectadas (índice multiEntry). */
  claves: string[];
  client_created_at: string;
  intentos: number;
  estado: EstadoOutbox;
  error: ErrorSync | null;
  /** No se envía antes de este instante (backoff). `null` = en cuanto haya conexión. */
  siguiente_intento_at: string | null;
  enviada_at: string | null;
  aplicada_at: string | null;
  actualizada_at: string;
}

/** Fila del outbox, discriminada por `tipo` (el `payload` es el del contrato de shared). */
export type MutacionOutbox = {
  [T in TipoMutacion]: BaseMutacionOutbox & { tipo: T; payload: MutacionDe<T>['payload'] };
}[TipoMutacion];

// ---------------------------------------------------------------------------------------------
// Entidades con estado de sincronización
// ---------------------------------------------------------------------------------------------

/** Campos de un consumo que su autor puede editar mientras está pendiente (S4). */
export interface CamposConsumo {
  material_id: string;
  cantidad: number;
  unidad: Unidad;
  lote: string;
}

export interface ConsumoLocal extends CamposConsumo {
  user_id: string;
  id: string;
  order_id: string;
  corrige_a: string | null;
  registrado_por: string;
  client_created_at: string;
  /** Día calendario de Bogotá de `client_created_at` ("registros del día", §4). */
  dia_bogota: string;
  /** Valores de la creación local, base de la vista mientras el servidor no la confirme. */
  base_local: CamposConsumo | null;
  /** Último estado confirmado por el servidor (respuesta del push o pull). */
  servidor: Consumo | null;
  /**
   * Estado del servidor recibido por el pull mientras había mutaciones propias en cola: NO pisa la
   * vista local; se adopta cuando la cola de la entidad se vacía (si es más reciente).
   */
  servidor_diferido: Consumo | null;
  /** Versión del servidor (copia de `servidor.version`), o `null` si nunca llegó al servidor. */
  version: number | null;
  estado_local: EstadoLocal;
  ultimo_resultado: UltimoResultado | null;
  /** `requiere_novedad` del servidor y sin ninguna novedad local válida ("Falta justificar…"). */
  falta_novedad: boolean;
  requiere_novedad: boolean;
  registro_tardio: boolean;
  motivo_rechazo: string | null;
  error_sync: ErrorSync | null;
  /** En `conflicto`: la versión del servidor que devolvió el push. */
  conflicto_servidor: Record<string, unknown> | null;
  actualizado_at: string;
  /**
   * Consumo propio sincronizado que se conservó al reiniciar (cambio de época o `reiniciar`) y que
   * el snapshot aún no confirmó. Si el snapshot completo no lo devuelve, pasa a
   * `perdido_en_restauracion` (ADR 0016, M1). Opcional: las filas anteriores no lo tienen.
   */
  verificar_en_snapshot?: boolean;
  /**
   * El servidor ya no tiene este consumo propio (restauración más atrás de la retención) y no hay
   * mutación en cola que lo recree. La UI ofrece `reenviarPerdido`; el dato nunca se borra solo.
   */
  perdido_en_restauracion?: boolean;
}

export interface NovedadLocal {
  user_id: string;
  id: string;
  consumption_id: string;
  tipo: TipoNovedad;
  descripcion: string;
  registrado_por: string;
  client_created_at: string;
  servidor: Novedad | null;
  servidor_diferido: Novedad | null;
  estado_local: EstadoLocalSimple;
  ultimo_resultado: UltimoResultado | null;
  error_sync: ErrorSync | null;
  actualizado_at: string;
}

/**
 * Estado de subida de una foto (§6 punto 5):
 * - `pendiente`: hay bytes locales por subir (cuando la novedad quede `aplicada`).
 * - `subida`: el servidor la marcó como subida.
 * - `bloqueada`: la novedad fue rechazada; los bytes se conservan (dato de planta) y no se suben.
 * - `remota`: metadatos recibidos por el pull, sin bytes locales (foto de otro dispositivo).
 */
export const ESTADOS_SUBIDA = ['pendiente', 'subida', 'bloqueada', 'remota'] as const;
export type EstadoSubida = (typeof ESTADOS_SUBIDA)[number];

export interface EvidenciaLocal {
  user_id: string;
  id: string;
  incident_id: string;
  mime: MimeEvidencia;
  tamano_bytes: number;
  sha256: string;
  /**
   * Bytes de la foto ya comprimida. Se guarda `ArrayBuffer` y no `Blob`: Safari tuvo fallos
   * guardando Blobs en IndexedDB y el clonado estructurado de Blob no es portable entre entornos.
   * La subida reconstruye el Blob con `mime`.
   */
  datos: ArrayBuffer | null;
  estado_subida: EstadoSubida;
  intentos_subida: number;
  siguiente_intento_at: string | null;
  error_subida: ErrorSync | null;
  subido_at: string | null;
  servidor: Evidencia | null;
  actualizado_at: string;
}

export interface ValidacionLocal {
  user_id: string;
  id: string;
  consumption_id: string;
  decision: Decision;
  motivo: string | null;
  validado_por: string;
  client_created_at: string;
  servidor: Validacion | null;
  servidor_diferido: Validacion | null;
  estado_local: EstadoLocalSimple;
  ultimo_resultado: UltimoResultado | null;
  error_sync: ErrorSync | null;
  actualizado_at: string;
}

// ---------------------------------------------------------------------------------------------
// Datos que solo llegan del servidor (pull o snapshot)
// ---------------------------------------------------------------------------------------------

export interface OrdenLocal extends Orden {
  user_id: string;
  /**
   * La orden dejó de ser visible (`revocar`), pero se conserva su fila porque quedan consumos
   * propios de ella en el dispositivo (para mostrar el código de la orden).
   */
  revocada: boolean;
}

export interface PlaneadoLocal {
  user_id: string;
  /** Id del cambio de sync (`order_planned_materials`). */
  id: string;
  order_id: string;
  material_id: string;
  cantidad_planeada: number;
  unidad: Unidad;
}

export interface AsignacionLocal {
  user_id: string;
  /** Id del cambio de sync (`order_supervisors`). */
  id: string;
  order_id: string;
  /** `order_supervisors.user_id` (renombrado: `user_id` es la partición local). */
  supervisor_id: string;
  /** Nombre del supervisor (`order_supervisors.nombre`: el supervisor no recibe `users` ajenos).
   * Opcional: las filas anteriores no lo tienen. */
  nombre?: string | null;
  asignado_por: string | null;
  activo: boolean;
}

export interface MaterialLocal {
  user_id: string;
  id: string;
  codigo: string;
  nombre: string;
  unidad: Unidad;
  costo_unitario_cop: number;
  activo: boolean;
}

export interface SettingLocal {
  user_id: string;
  clave: string;
  /** Valor ya parseado si llegó como texto JSON. */
  valor: unknown;
}

/** Datos mínimos de otros usuarios (nombres para la UI). No se guarda el correo (Ley 1581). */
export interface UsuarioLocal {
  user_id: string;
  id: string;
  nombre: string;
  rol: Rol | null;
  activo: boolean;
}

// ---------------------------------------------------------------------------------------------
// Estado del dispositivo
// ---------------------------------------------------------------------------------------------

/** Estado de sync por usuario. Las acciones pendientes se persisten para no perderlas al cerrar. */
export interface MetaSync {
  user_id: string;
  /** Último `seq` revisado por el pull (ADR 0005). */
  cursor: number;
  /** Época de sync del servidor (ADR 0009). `null` hasta el primer pull. */
  epoca: string | null;
  ultimo_sync_at: string | null;
  /** Hay que pedir un snapshot completo (`reiniciar` o cambio de época). */
  requiere_snapshot: boolean;
  /** Por qué se pidió el snapshot (informativo para el motor y los registros). */
  motivo_snapshot: 'epoca' | 'reiniciar' | null;
  /** Órdenes con `hidratar` pendiente (snapshot de la orden). */
  hidrataciones: string[];
}

/**
 * Verificador del login offline (ADR 0012 punto 4): PBKDF2-SHA256 con sal propia del dispositivo.
 * Nunca se envía al servidor ni reemplaza la autenticación del servidor.
 */
export interface VerificadorLocal {
  algoritmo: 'pbkdf2-sha256';
  /** Se guarda con el verificador para poder cambiar `ITERACIONES_VERIFICADOR` sin romper nada. */
  iteraciones: number;
  /** Sal aleatoria de 16 bytes, en base64. */
  sal: string;
  /** 32 bytes derivados, en base64. */
  hash: string;
  /** Tiempo que tardó la derivación al crearlo, en ms (diagnóstico para el ADR; sin secretos). */
  ms_derivacion: number | null;
  creado_at: string;
}

/** Perfil cacheado para trabajar offline y verificador del login offline (ADR 0012). */
export interface PerfilLocal {
  user_id: string;
  perfil: Perfil;
  /** `device_id` de la sesión de este usuario en este navegador (ADR 0008 punto 7). */
  device_id: string | null;
  verificador: VerificadorLocal | null;
  actualizado_at: string;
  /** Último inicio de sesión (online u offline) en este dispositivo: "último perfil activo". */
  ultimo_acceso_at: string | null;
  /**
   * El usuario cerró sesión sin poder avisar al servidor (sin conexión): su cookie de refresh puede
   * seguir viva. Mientras esté marcado, esa sesión del servidor nunca se adopta sin contraseña y se
   * revoca en cuanto haya conexión (tablet compartida).
   */
  cierre_pendiente: boolean;
}

/** Candado entre pestañas en IndexedDB (alternativa a Web Locks), con expiración. */
export interface CandadoLocal {
  nombre: string;
  /** Id aleatorio de quien lo tiene (por adquisición, no por pestaña). */
  titular: string;
  /** Milisegundos Unix en que vence aunque su titular no lo libere (pestaña cerrada). */
  expira_at: number;
}

export const ACCIONES_TRAZABILIDAD = [
  'consumo.registrado',
  'consumo.registrado_con_novedad',
  'consumo.editado',
  'novedad.registrada',
  'consumo.aprobado',
  'consumo.rechazado',
  'sync.completada',
] as const;
export type AccionTrazabilidad = (typeof ACCIONES_TRAZABILIDAD)[number];

/** Evento de este dispositivo ("10:24 · Juan S. registró consumo + novedad"). */
export interface EventoTrazabilidad {
  id: string;
  user_id: string;
  ts: string;
  accion: AccionTrazabilidad;
  /** Texto en español sin la hora ni el nombre: "registró consumo + novedad". */
  descripcion: string;
  /** Nombre corto del autor ("Juan S."), tomado del perfil cacheado. */
  actor_nombre: string;
  entidad_id: string;
  order_id: string | null;
}

/** Fila única con el id del navegador, compartido entre usuarios (ADR 0008 punto 7). */
export interface Instalacion {
  clave: 'instalacion';
  instalacion_id: string;
  created_at: string;
}

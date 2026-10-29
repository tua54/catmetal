// Filas que expone la API (JSON), según las tablas de docs/spec.md §4.
//
// Convenciones:
// - Fechas: texto ISO-8601 UTC (`2026-10-29T20:55:00.000Z`).
// - Booleanos: en D1 son INTEGER 0/1; en la API y en la PWA se exponen como `boolean`.
// - Nunca se exponen secretos ni datos internos: `password_hash`, `token_hash` ni `storage_key`.
// - Columnas JSON (`datos_antes`, `datos_despues`): se exponen ya parseadas.

import type {
  Decision,
  EstadoConsumo,
  EstadoOrden,
  MimeEvidencia,
  Rol,
  TipoNovedad,
  Unidad,
} from './dominio';
import type { Permiso } from './permisos';

interface ConMarcasDeTiempo {
  created_at: string;
  updated_at: string;
}

/** Usuario sin `password_hash`. */
export interface Usuario extends ConMarcasDeTiempo {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
  activo: boolean;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
}

/** Dispositivo (navegador de un usuario) registrado al iniciar sesión (ADR 0008 punto 7). */
export interface Dispositivo extends ConMarcasDeTiempo {
  id: string;
  user_id: string;
  nombre: string | null;
  user_agent: string | null;
  /** Id del navegador, compartido entre los usuarios de la misma tablet. */
  instalacion_id: string | null;
  ultimo_sync_at: string | null;
}

export interface Material extends ConMarcasDeTiempo {
  id: string;
  codigo: string;
  nombre: string;
  unidad: Unidad;
  /** Pesos colombianos, entero. */
  costo_unitario_cop: number;
  activo: boolean;
}

export interface Orden extends ConMarcasDeTiempo {
  id: string;
  /** Por ejemplo `OP-2026-0587`. */
  codigo: string;
  linea: string;
  estado: EstadoOrden;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  creada_por: string;
}

export interface MaterialPlaneado {
  order_id: string;
  material_id: string;
  cantidad_planeada: number;
  unidad: Unidad;
}

export interface Consumo extends ConMarcasDeTiempo {
  id: string;
  order_id: string;
  material_id: string;
  cantidad: number;
  unidad: Unidad;
  /** Cantidad convertida a la unidad del plan (S11). */
  cantidad_en_unidad_plan: number;
  lote: string;
  /** Costo unitario congelado al registrar (S12), en pesos. */
  costo_unitario_cop_snapshot: number;
  registrado_por: string;
  device_id: string;
  client_created_at: string;
  server_received_at: string;
  estado: EstadoConsumo;
  /** Consumo rechazado que este corrige (S3). */
  corrige_a: string | null;
  registro_tardio: boolean;
  requiere_novedad: boolean;
  version: number;
}

export interface Novedad extends ConMarcasDeTiempo {
  id: string;
  consumption_id: string;
  tipo: TipoNovedad;
  descripcion: string;
  registrado_por: string;
  client_created_at: string;
  server_received_at: string;
}

/** Evidencia (foto) sin `storage_key`: se descarga siempre por `GET /api/v1/evidences/:id`. */
export interface Evidencia extends ConMarcasDeTiempo {
  id: string;
  incident_id: string;
  mime: MimeEvidencia;
  tamano_bytes: number;
  sha256: string;
  subido: boolean;
  subido_at: string | null;
}

export interface Validacion extends ConMarcasDeTiempo {
  id: string;
  consumption_id: string;
  decision: Decision;
  /** Obligatorio si la decisión es `rechazado`. */
  motivo: string | null;
  validado_por: string;
  client_created_at: string;
  server_received_at: string;
}

export interface EntradaAuditoria {
  seq: number;
  id: string;
  entidad: string;
  entidad_id: string;
  accion: string;
  actor_id: string | null;
  device_id: string | null;
  datos_antes: Record<string, unknown> | null;
  datos_despues: Record<string, unknown> | null;
  client_at: string | null;
  server_at: string;
  alerta_reloj: boolean;
}

/** Respuesta de `GET /auth/me`: el usuario autenticado y sus permisos (se cachean para offline). */
export interface Perfil {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
  permisos: Permiso[];
}

/** Respuesta de `POST /auth/login` y `POST /auth/refresh` (el refresh token va en la cookie). */
export interface RespuestaSesion {
  access_token: string;
  /** Segundos de vida del access token. */
  expira_en: number;
  /** Dispositivo de la sesión (puede diferir del propuesto si pertenecía a otro usuario). */
  device_id: string;
  usuario: Perfil;
}

/** Respuesta de `GET /users` (paginación por cursor: el `id` del último usuario). */
export interface ListaUsuarios {
  usuarios: Usuario[];
  siguiente_cursor: string | null;
}

/** Respuesta de `GET /materials` (paginación por cursor: el `id` del último material). */
export interface ListaMateriales {
  materiales: Material[];
  siguiente_cursor: string | null;
}

/** Respuesta de `GET /settings` y de `PATCH /settings/tolerancia`. */
export interface Configuracion {
  /** Tolerancia global sobre lo planeado, en porcentaje (S7, P11). */
  tolerancia_pct: number;
}

/** Respuesta de `GET /orders` (paginación por cursor: el `id` de la última orden). */
export interface ListaOrdenes {
  ordenes: Orden[];
  siguiente_cursor: string | null;
}

/** Supervisor con asignación activa en una orden. */
export interface SupervisorAsignado {
  user_id: string;
  nombre: string;
  /** Admin que hizo (o reactivó) la asignación. */
  asignado_por: string;
  created_at: string;
  updated_at: string;
}

/** Consumo vs plan de un material planeado de la orden. */
export interface AvanceMaterial {
  material_id: string;
  codigo: string;
  nombre: string;
  /** Unidad del plan (la de `cantidad_planeada` y `consumido`). */
  unidad: Unidad;
  cantidad_planeada: number;
  /** Σ `cantidad_en_unidad_plan` de los consumos no rechazados (pendientes y aprobados). */
  consumido: number;
  /** `consumido / cantidad_planeada × 100`, con 2 decimales. */
  porcentaje: number;
  /** `excedeTolerancia(cantidad_planeada, consumido, tolerancia_pct)` (S7). */
  excede_tolerancia: boolean;
}

/** Consumo (no rechazado) de un material que no está en el plan de la orden (P10). */
export interface ConsumoFueraDePlan {
  material_id: string;
  codigo: string;
  nombre: string;
  /** Unidad del material (P10: sin plan, la cantidad se guarda en la unidad del material). */
  unidad: Unidad;
  consumido: number;
}

/** Respuesta de `GET /orders/:id`: la orden con su plan, el consumo vs plan y sus supervisores. */
export interface DetalleOrden extends Orden {
  /** Tolerancia vigente con la que se calculó `excede_tolerancia`. */
  tolerancia_pct: number;
  materiales: AvanceMaterial[];
  materiales_fuera_de_plan: ConsumoFueraDePlan[];
  supervisores: SupervisorAsignado[];
}

/** Respuesta de `POST /orders`: la orden creada (estado `planeada`) con sus materiales planeados. */
export interface OrdenCreada extends Orden {
  materiales: MaterialPlaneado[];
}

/** Respuesta de `PUT /orders/:id/supervisors`: la lista resultante de supervisores activos. */
export interface SupervisoresDeOrden {
  order_id: string;
  supervisores: SupervisorAsignado[];
}

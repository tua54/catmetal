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

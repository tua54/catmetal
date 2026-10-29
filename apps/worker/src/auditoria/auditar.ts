// Auditoría (docs/spec.md §4): toda escritura de negocio inserta su fila de `audit_log` en el MISMO
// `db.batch()`. Estas funciones DEVUELVEN la sentencia preparada; nunca la ejecutan.
//
// Lista blanca por entidad: solo se guardan en `datos_antes`/`datos_despues` las columnas listadas.
// Un campo nuevo no se audita hasta que se agregue aquí, así un secreto (`password_hash`,
// `token_hash`, tokens, contraseñas) nunca llega a la auditoría por accidente.
//
// Convención de `entidad_id` (la comparte scripts/seed.mjs y la usa /sync/pull):
// - tablas con id propio: el `id` de la fila;
// - `order_supervisors`: `'<order_id>:<user_id>'`; `order_planned_materials`: `'<order_id>:<material_id>'`;
// - `settings`: la `clave`.
// Para eventos de sesión se usa la entidad `refresh_tokens` con el id del token afectado (en el
// logout por access token, sin cookie, el id de la familia).

import { ahoraIso, ALERTA_RELOJ_MS, uuidv7 } from '@catmetal/shared';

export const COLUMNAS_AUDITABLES = {
  users: [
    'id',
    'nombre',
    'email',
    'rol',
    'activo',
    'intentos_fallidos',
    'bloqueado_hasta',
    'created_at',
    'updated_at',
    // Marca (no el valor) de que un admin restableció la contraseña.
    'password_restablecida',
  ],
  refresh_tokens: [
    'id',
    'user_id',
    'device_id',
    'familia_id',
    'expira_at',
    'revocado_at',
    'reemplazado_por',
  ],
  devices: ['id', 'user_id', 'nombre', 'user_agent', 'instalacion_id', 'ultimo_sync_at'],
  // Entidades de negocio (Fase 2). Se listan todas aquí para que las tareas de consumos, novedades,
  // evidencias y validaciones no tengan que editar este archivo en paralelo.
  settings: ['clave', 'valor', 'actualizado_por', 'created_at', 'updated_at'],
  materials: [
    'id',
    'codigo',
    'nombre',
    'unidad',
    'costo_unitario_cop',
    'activo',
    'created_at',
    'updated_at',
  ],
  production_orders: [
    'id',
    'codigo',
    'linea',
    'estado',
    'fecha_inicio',
    'fecha_fin',
    'creada_por',
    'created_at',
    'updated_at',
    // Al finalizar: si se forzó con consumos pendientes y cuántos había (docs/spec.md §7).
    'force',
    'pendientes',
  ],
  order_supervisors: ['order_id', 'user_id', 'asignado_por', 'activo', 'created_at', 'updated_at'],
  order_planned_materials: [
    'order_id',
    'material_id',
    'cantidad_planeada',
    'unidad',
    'created_at',
    'updated_at',
  ],
  consumptions: [
    'id',
    'order_id',
    'material_id',
    'cantidad',
    'unidad',
    'cantidad_en_unidad_plan',
    'lote',
    'costo_unitario_cop_snapshot',
    'registrado_por',
    'device_id',
    'client_created_at',
    'server_received_at',
    'estado',
    'corrige_a',
    'registro_tardio',
    'requiere_novedad',
    'version',
    'created_at',
    'updated_at',
  ],
  incidents: [
    'id',
    'consumption_id',
    'tipo',
    'descripcion',
    'registrado_por',
    'client_created_at',
    'server_received_at',
    'created_at',
    'updated_at',
  ],
  // Sin `storage_key`: es interno y nunca se expone por la API (GET /audit la mostraría).
  evidences: [
    'id',
    'incident_id',
    'mime',
    'tamano_bytes',
    'sha256',
    'subido',
    'subido_at',
    'created_at',
    'updated_at',
  ],
  validations: [
    'id',
    'consumption_id',
    'decision',
    'motivo',
    'validado_por',
    'client_created_at',
    'server_received_at',
    'created_at',
    'updated_at',
  ],
} as const satisfies Record<string, readonly string[]>;

export type EntidadAuditada = keyof typeof COLUMNAS_AUDITABLES;

/**
 * Columnas booleanas de la lista blanca: en D1 son 0/1, en la auditoría se guardan como
 * `true/false`, igual que en la API y en el seed (ADR 0010, H13).
 */
export const COLUMNAS_BOOLEANAS: Readonly<Record<EntidadAuditada, readonly string[]>> = {
  users: ['activo'],
  refresh_tokens: [],
  devices: [],
  settings: [],
  materials: ['activo'],
  production_orders: ['force'],
  order_supervisors: ['activo'],
  order_planned_materials: [],
  consumptions: ['registro_tardio', 'requiere_novedad'],
  incidents: [],
  evidences: ['subido'],
  validations: [],
};

export type DatosAuditoria = Record<string, unknown>;

export interface EntradaAuditoria {
  entidad: EntidadAuditada;
  entidad_id: string;
  accion: string;
  /** NULL en acciones del sistema. */
  actor_id: string | null;
  device_id: string | null;
  /**
   * Orden a la que pertenece la entidad (orden, asignación, plan, consumo, novedad, evidencia,
   * validación). Obligatorio para esas entidades (ADR 0010); NULL en las demás.
   */
  order_id?: string | null;
  antes?: DatosAuditoria | null;
  despues?: DatosAuditoria | null;
  /** Hora del dispositivo (si la acción viene de un dispositivo). */
  client_at?: string | null;
  /** Hora del servidor; por defecto, ahora. */
  server_at?: string;
}

/** Condición SQL (con sus parámetros) para la variante `INSERT … SELECT … WHERE`. */
export interface CondicionSql {
  sql: string;
  parametros: readonly (string | number | null)[];
}

function normalizarBooleano(valor: unknown): unknown {
  if (valor === 1 || valor === true) {
    return true;
  }
  if (valor === 0 || valor === false) {
    return false;
  }
  return valor;
}

/** Copia solo las columnas de la lista blanca de la entidad y normaliza sus booleanos. */
export function filtrarDatos(
  entidad: EntidadAuditada,
  datos: DatosAuditoria | null | undefined,
): DatosAuditoria | null {
  if (datos === null || datos === undefined) {
    return null;
  }
  const permitidas: readonly string[] = COLUMNAS_AUDITABLES[entidad];
  const booleanas = COLUMNAS_BOOLEANAS[entidad];
  return Object.fromEntries(
    Object.entries(datos)
      .filter(([clave, valor]) => permitidas.includes(clave) && valor !== undefined)
      .map(([clave, valor]) => [
        clave,
        booleanas.includes(clave) ? normalizarBooleano(valor) : valor,
      ]),
  );
}

/** `alerta_reloj`: la hora del dispositivo difiere de la del servidor en más de 10 min. */
export function calcularAlertaReloj(
  clientAt: string | null | undefined,
  serverAt: string,
): boolean {
  if (clientAt === null || clientAt === undefined) {
    return false;
  }
  const diferencia = Math.abs(Date.parse(clientAt) - Date.parse(serverAt));
  return Number.isFinite(diferencia) && diferencia > ALERTA_RELOJ_MS;
}

const COLUMNAS_INSERT =
  'id, entidad, entidad_id, accion, order_id, actor_id, device_id, datos_antes, datos_despues, client_at, server_at, alerta_reloj, created_at, updated_at';
const MARCADORES = Array.from({ length: 14 }, () => '?').join(', ');

function valores(entrada: EntradaAuditoria): (string | number | null)[] {
  if (!Object.hasOwn(COLUMNAS_AUDITABLES, entrada.entidad)) {
    throw new Error(`Entidad sin lista blanca de auditoría: ${String(entrada.entidad)}`);
  }
  const serverAt = entrada.server_at ?? ahoraIso();
  const antes = filtrarDatos(entrada.entidad, entrada.antes);
  const despues = filtrarDatos(entrada.entidad, entrada.despues);
  return [
    uuidv7(),
    entrada.entidad,
    entrada.entidad_id,
    entrada.accion,
    entrada.order_id ?? null,
    entrada.actor_id,
    entrada.device_id,
    antes === null ? null : JSON.stringify(antes),
    despues === null ? null : JSON.stringify(despues),
    entrada.client_at ?? null,
    serverAt,
    calcularAlertaReloj(entrada.client_at, serverAt) ? 1 : 0,
    serverAt,
    serverAt,
  ];
}

/** Sentencia de auditoría para incluir en el mismo `db.batch()` que la escritura auditada. */
export function sentenciaAuditoria(db: D1Database, entrada: EntradaAuditoria): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (${COLUMNAS_INSERT}) VALUES (${MARCADORES})`)
    .bind(...valores(entrada));
}

/**
 * Variante condicional: `INSERT INTO audit_log (…) SELECT … WHERE <condición>`. Se usa cuando la
 * escritura auditada es condicional dentro del batch (rotación de refresh, bloqueo de cuenta): la
 * fila solo se inserta si la condición se cumple después de las sentencias anteriores del batch.
 */
export function sentenciaAuditoriaCondicional(
  db: D1Database,
  entrada: EntradaAuditoria,
  condicion: CondicionSql,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (${COLUMNAS_INSERT}) SELECT ${MARCADORES} WHERE ${condicion.sql}`,
    )
    .bind(...valores(entrada), ...condicion.parametros);
}

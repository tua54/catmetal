// Esquema de D1 (SQLite) con Drizzle: tablas de docs/spec.md §4 más las adiciones de las
// ADR 0008 y 0009 (ver docs/desviaciones.md D2).
//
// Convenciones:
// - Los nombres de las propiedades son los de las columnas (snake_case, en español como en la spec),
//   igual que los tipos de `@catmetal/shared`.
// - IDs: TEXT con UUID v7. Excepciones: `audit_log.seq` (cursor de sync, ADR 0005), `settings.clave`
//   y las PK compuestas de `order_supervisors` y `order_planned_materials`.
// - Fechas: TEXT con `Date.prototype.toISOString()` (24 caracteres, milisegundos y `Z`); un CHECK
//   rechaza cualquier otro formato para que el orden lexicográfico siga siendo el cronológico.
// - Booleanos: INTEGER 0/1 con CHECK (Drizzle los expone como `boolean`).
// - JSON: TEXT con `json_valid`.
// - Sin `ON DELETE CASCADE`: nada se borra (los triggers de `migrations/0001_triggers.sql` lo impiden).
// - Los CHECK se escriben con nombres de columna sin calificar: así los genera drizzle-kit tal cual.
// - Los triggers NO viven aquí: Drizzle no los gestiona (ADR 0006).

import {
  DECISIONES,
  ESTADOS_CONSUMO,
  ESTADOS_ORDEN,
  MAX_EVIDENCIA_BYTES,
  MIMES_EVIDENCIA,
  RESULTADOS_MUTACION,
  ROLES,
  TIPOS_NOVEDAD,
  UNIDADES,
} from '@catmetal/shared';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Tamaño máximo de `sync_mutations.payload_json` (64 KiB, ADR 0009). */
export const MAX_PAYLOAD_JSON_BYTES = 65_536;

// ---------------------------------------------------------------------------------------------
// Ayudantes para los CHECK. Solo reciben nombres de columna y constantes del código (nunca datos
// de usuario), por eso es seguro construir el SQL con `sql.raw`.
// ---------------------------------------------------------------------------------------------

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;

function columna(nombre: string): string {
  if (!IDENTIFICADOR.test(nombre)) {
    throw new Error(`Nombre de columna no válido en un CHECK: ${nombre}`);
  }
  return nombre;
}

function literal(valor: string): string {
  return `'${valor.replaceAll("'", "''")}'`;
}

/** `col IN ('a', 'b', ...)` con los valores de una constante de `@catmetal/shared`. */
function enLista(nombre: string, valores: readonly string[]): SQL {
  return sql.raw(`${columna(nombre)} IN (${valores.map(literal).join(', ')})`);
}

/** Booleano 0/1. */
function booleano(nombre: string): SQL {
  return sql.raw(`${columna(nombre)} IN (0, 1)`);
}

/** Patrón de `toISOString()`: `2026-10-29T20:55:00.000Z`. */
const PATRON_ISO = "'????-??-??T??:??:??.???Z'";

function condicionFecha(nombre: string): string {
  const c = columna(nombre);
  return `(length(${c}) = 24 AND ${c} GLOB ${PATRON_ISO})`;
}

/**
 * Fechas en formato `toISOString()`. Las obligatorias deben cumplirlo; las opcionales pueden ser NULL.
 */
function fechas(obligatorias: readonly string[], opcionales: readonly string[] = []): SQL {
  const partes = [
    ...obligatorias.map(condicionFecha),
    ...opcionales.map((nombre) => `(${columna(nombre)} IS NULL OR ${condicionFecha(nombre)})`),
  ];
  return sql.raw(partes.join(' AND '));
}

/** Texto JSON válido (o NULL si la columna lo admite). */
function json(nombre: string, nullable = false): SQL {
  const c = columna(nombre);
  return sql.raw(nullable ? `${c} IS NULL OR json_valid(${c})` : `json_valid(${c})`);
}

/** Columnas `created_at` y `updated_at`, presentes en todas las tablas. */
function marcasDeTiempo() {
  return {
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  };
}

const MARCAS = ['created_at', 'updated_at'] as const;

/**
 * Marca de escritura (ADR 0028, A1): UUID v7 que fija la sentencia principal de cada escritura
 * auditada y que comprueban su auditoría y sus dependientes en el mismo batch. Es INTERNA: los tipos
 * `Fila*` la omiten, no entra en ninguna lista `COLUMNAS_*`, no la exporta el backup y nunca sale
 * por la API ni por `/sync/*`. Anulable: las filas anteriores a la migración 0009 quedan en NULL.
 * En `consumptions` es la marca de la última escritura DIRECTA (el trigger
 * `validations_aplica_decision` no la fija).
 */
function marcaDeEscritura() {
  return { escritura_id: text('escritura_id') };
}

/** Nombre de la columna de la marca de escritura (ADR 0028). */
export const COLUMNA_MARCA = 'escritura_id';

// ---------------------------------------------------------------------------------------------
// Usuarios, dispositivos y sesiones
// ---------------------------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    nombre: text('nombre').notNull(),
    /** Único y siempre en minúsculas (un CHECK lo exige). */
    email: text('email').notNull(),
    /** Formato autodescriptivo `pbkdf2-sha256$100000$<sal_b64>$<hash_b64>` (ADR 0007). */
    password_hash: text('password_hash').notNull(),
    rol: text('rol', { enum: ROLES }).notNull(),
    activo: integer('activo', { mode: 'boolean' }).notNull().default(true),
    intentos_fallidos: integer('intentos_fallidos').notNull().default(0),
    bloqueado_hasta: text('bloqueado_hasta'),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    uniqueIndex('users_email_unico').on(t.email),
    check('users_email_minusculas', sql`email = lower(email) AND length(trim(email)) > 0`),
    check('users_rol_valido', enLista('rol', ROLES)),
    check('users_activo_booleano', booleano('activo')),
    check('users_intentos_no_negativos', sql`intentos_fallidos >= 0`),
    check('users_fechas_iso', fechas(MARCAS, ['bloqueado_hasta'])),
  ],
);

export const devices = sqliteTable(
  'devices',
  {
    /** Lo propone el cliente (UUID v7 por usuario y navegador, ADR 0008). */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    /** Id por navegador, compartido entre usuarios de una tablet (ADR 0008). */
    instalacion_id: text('instalacion_id'),
    nombre: text('nombre'),
    user_agent: text('user_agent'),
    ultimo_sync_at: text('ultimo_sync_at'),
    ...marcasDeTiempo(),
  },
  (t) => [
    index('devices_user_id').on(t.user_id),
    check('devices_fechas_iso', fechas(MARCAS, ['ultimo_sync_at'])),
  ],
);

export const refresh_tokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    device_id: text('device_id')
      .notNull()
      .references(() => devices.id),
    /** HMAC-SHA256(REFRESH_SECRET, token) en hex (ADR 0007). Nunca el token. */
    token_hash: text('token_hash').notNull(),
    familia_id: text('familia_id').notNull(),
    expira_at: text('expira_at').notNull(),
    revocado_at: text('revocado_at'),
    /**
     * Id del token que lo reemplazó al rotar. Sin FK a propósito: la rotación inserta el nuevo y
     * luego actualiza el viejo en el mismo batch (ADR 0008).
     */
    reemplazado_por: text('reemplazado_por'),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash').on(t.token_hash),
    index('refresh_tokens_user_id').on(t.user_id),
    index('refresh_tokens_familia_id').on(t.familia_id),
    // Sesiones vigentes por usuario y dispositivo: middleware, login y revocaciones (ADR 0010, H7).
    index('refresh_tokens_vigentes_usuario')
      .on(t.user_id, t.device_id)
      .where(sql`revocado_at IS NULL`),
    // Purga del cron (revisión de la Fase 3, B5): `DELETE … WHERE expira_at < ?` sin recorrer la tabla.
    index('refresh_tokens_expira_at').on(t.expira_at),
    check('refresh_tokens_token_hash_hex', sql`length(token_hash) = 64`),
    check('refresh_tokens_fechas_iso', fechas([...MARCAS, 'expira_at'], ['revocado_at'])),
  ],
);

/**
 * Cupos de login por (cuenta, origen) (ADR 0018, M1). Tabla TÉCNICA, como `refresh_tokens`: no es
 * de negocio, no tiene trigger de inmutabilidad y el cron de mantenimiento purga las filas viejas.
 * Su historia de seguridad (bloqueos y desbloqueos) queda en `audit_log` (entidad `login_cupos`).
 */
export const login_cupos = sqliteTable(
  'login_cupos',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    /**
     * `d:<nonce>` (dispositivo conocido), `ip:<hmac>` (origen desconocido: HMAC de la IP
     * normalizada, nunca la IP) o `g` (tope global de los orígenes desconocidos de la cuenta).
     */
    origen: text('origen').notNull(),
    fallos: integer('fallos').notNull(),
    /** Inicio de la ventana fija de 15 min (primer fallo). */
    ventana_inicio: text('ventana_inicio').notNull(),
    bloqueado_hasta: text('bloqueado_hasta'),
    /** Id aleatorio de la última reserva: encadena las sentencias del mismo batch. */
    reserva_id: text('reserva_id').notNull(),
    ...marcasDeTiempo(),
  },
  (t) => [
    primaryKey({ name: 'login_cupos_pk', columns: [t.user_id, t.origen] }),
    // Purga del cron: filas sin cambios hace más de 24 h, sin recorrer la tabla.
    index('login_cupos_updated_at').on(t.updated_at),
    check('login_cupos_fallos_no_negativos', sql`fallos >= 0`),
    check(
      'login_cupos_origen_valido',
      sql`origen = 'g' OR (origen GLOB 'd:?*' AND length(origen) <= 64) OR (origen GLOB 'ip:?*' AND length(origen) <= 64)`,
    ),
    check('login_cupos_fechas_iso', fechas([...MARCAS, 'ventana_inicio'], ['bloqueado_hasta'])),
  ],
);

// ---------------------------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------------------------

export const settings = sqliteTable(
  'settings',
  {
    /** Por ejemplo `tolerancia_pct` o `sync_epoca` (ADR 0009). */
    clave: text('clave').primaryKey(),
    /** Valor JSON (por ejemplo `5` o `"0193…"`). */
    valor: text('valor').notNull(),
    /** NULL cuando lo escribe el sistema (migración inicial). */
    actualizado_por: text('actualizado_por').references(() => users.id),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  () => [check('settings_valor_json', json('valor')), check('settings_fechas_iso', fechas(MARCAS))],
);

// ---------------------------------------------------------------------------------------------
// Catálogos y órdenes
// ---------------------------------------------------------------------------------------------

export const materials = sqliteTable(
  'materials',
  {
    id: text('id').primaryKey(),
    codigo: text('codigo').notNull(),
    nombre: text('nombre').notNull(),
    unidad: text('unidad', { enum: UNIDADES }).notNull(),
    /** Pesos colombianos, entero. */
    costo_unitario_cop: integer('costo_unitario_cop').notNull(),
    activo: integer('activo', { mode: 'boolean' }).notNull().default(true),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    uniqueIndex('materials_codigo_unico').on(t.codigo),
    check('materials_unidad_valida', enLista('unidad', UNIDADES)),
    check('materials_costo_no_negativo', sql`costo_unitario_cop >= 0`),
    check('materials_activo_booleano', booleano('activo')),
    check('materials_fechas_iso', fechas(MARCAS)),
  ],
);

export const production_orders = sqliteTable(
  'production_orders',
  {
    id: text('id').primaryKey(),
    /** Por ejemplo `OP-2026-0587`. */
    codigo: text('codigo').notNull(),
    linea: text('linea').notNull(),
    estado: text('estado', { enum: ESTADOS_ORDEN }).notNull().default('planeada'),
    fecha_inicio: text('fecha_inicio'),
    fecha_fin: text('fecha_fin'),
    creada_por: text('creada_por')
      .notNull()
      .references(() => users.id),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    uniqueIndex('production_orders_codigo_unico').on(t.codigo),
    index('production_orders_estado').on(t.estado),
    check('production_orders_estado_valido', enLista('estado', ESTADOS_ORDEN)),
    check('production_orders_fechas_iso', fechas(MARCAS, ['fecha_inicio', 'fecha_fin'])),
  ],
);

export const order_supervisors = sqliteTable(
  'order_supervisors',
  {
    order_id: text('order_id')
      .notNull()
      .references(() => production_orders.id),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    asignado_por: text('asignado_por')
      .notNull()
      .references(() => users.id),
    activo: integer('activo', { mode: 'boolean' }).notNull().default(true),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    primaryKey({ name: 'order_supervisors_pk', columns: [t.order_id, t.user_id] }),
    index('order_supervisors_user_id').on(t.user_id),
    check('order_supervisors_activo_booleano', booleano('activo')),
    check('order_supervisors_fechas_iso', fechas(MARCAS)),
  ],
);

export const order_planned_materials = sqliteTable(
  'order_planned_materials',
  {
    order_id: text('order_id')
      .notNull()
      .references(() => production_orders.id),
    material_id: text('material_id')
      .notNull()
      .references(() => materials.id),
    cantidad_planeada: real('cantidad_planeada').notNull(),
    unidad: text('unidad', { enum: UNIDADES }).notNull(),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    primaryKey({ name: 'order_planned_materials_pk', columns: [t.order_id, t.material_id] }),
    index('order_planned_materials_material_id').on(t.material_id),
    check('order_planned_materials_cantidad_positiva', sql`cantidad_planeada > 0`),
    check('order_planned_materials_unidad_valida', enLista('unidad', UNIDADES)),
    check('order_planned_materials_fechas_iso', fechas(MARCAS)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Consumos, novedades, evidencias y validaciones
// ---------------------------------------------------------------------------------------------

export const consumptions = sqliteTable(
  'consumptions',
  {
    /** Lo genera el cliente offline (UUID v7). */
    id: text('id').primaryKey(),
    order_id: text('order_id')
      .notNull()
      .references(() => production_orders.id),
    material_id: text('material_id')
      .notNull()
      .references(() => materials.id),
    cantidad: real('cantidad').notNull(),
    unidad: text('unidad', { enum: UNIDADES }).notNull(),
    /** Cantidad convertida a la unidad del plan (S11). */
    cantidad_en_unidad_plan: real('cantidad_en_unidad_plan').notNull(),
    lote: text('lote').notNull(),
    /** Costo unitario congelado al registrar (S12), en pesos. */
    costo_unitario_cop_snapshot: integer('costo_unitario_cop_snapshot').notNull(),
    registrado_por: text('registrado_por')
      .notNull()
      .references(() => users.id),
    device_id: text('device_id')
      .notNull()
      .references(() => devices.id),
    client_created_at: text('client_created_at').notNull(),
    server_received_at: text('server_received_at').notNull(),
    estado: text('estado', { enum: ESTADOS_CONSUMO }).notNull().default('pendiente'),
    /** Consumo rechazado que este corrige (S3). Un rechazado se corrige una sola vez. */
    corrige_a: text('corrige_a').references((): AnySQLiteColumn => consumptions.id),
    registro_tardio: integer('registro_tardio', { mode: 'boolean' }).notNull().default(false),
    requiere_novedad: integer('requiere_novedad', { mode: 'boolean' }).notNull().default(false),
    /** Control de concurrencia optimista: todo UPDATE la incrementa en 1 (trigger). */
    version: integer('version').notNull().default(1),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    index('consumptions_order_id_estado').on(t.order_id, t.estado),
    index('consumptions_registrado_por_created_at').on(t.registrado_por, t.created_at),
    uniqueIndex('consumptions_corrige_a_unico')
      .on(t.corrige_a)
      .where(sql`corrige_a IS NOT NULL`),
    index('consumptions_material_id').on(t.material_id),
    // Cola de validación del jefe: solo los pendientes, paginados por id (ADR 0010, H6).
    index('consumptions_pendientes_id')
      .on(t.id)
      .where(sql`estado = 'pendiente'`),
    // Consumos de una orden paginados por id (ADR 0010, H10).
    index('consumptions_order_id_id').on(t.order_id, t.id),
    check('consumptions_cantidad_positiva', sql`cantidad > 0`),
    check('consumptions_cantidad_plan_positiva', sql`cantidad_en_unidad_plan > 0`),
    check('consumptions_costo_no_negativo', sql`costo_unitario_cop_snapshot >= 0`),
    check('consumptions_unidad_valida', enLista('unidad', UNIDADES)),
    check('consumptions_estado_valido', enLista('estado', ESTADOS_CONSUMO)),
    check('consumptions_no_se_corrige_a_si_mismo', sql`corrige_a IS NULL OR corrige_a <> id`),
    check('consumptions_registro_tardio_booleano', booleano('registro_tardio')),
    check('consumptions_requiere_novedad_booleano', booleano('requiere_novedad')),
    check('consumptions_version_positiva', sql`version >= 1`),
    check(
      'consumptions_fechas_iso',
      fechas([...MARCAS, 'client_created_at', 'server_received_at']),
    ),
  ],
);

export const incidents = sqliteTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    consumption_id: text('consumption_id')
      .notNull()
      .references(() => consumptions.id),
    tipo: text('tipo', { enum: TIPOS_NOVEDAD }).notNull(),
    descripcion: text('descripcion').notNull(),
    registrado_por: text('registrado_por')
      .notNull()
      .references(() => users.id),
    client_created_at: text('client_created_at').notNull(),
    server_received_at: text('server_received_at').notNull(),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    index('incidents_consumption_id').on(t.consumption_id),
    check('incidents_tipo_valido', enLista('tipo', TIPOS_NOVEDAD)),
    check('incidents_fechas_iso', fechas([...MARCAS, 'client_created_at', 'server_received_at'])),
  ],
);

export const evidences = sqliteTable(
  'evidences',
  {
    id: text('id').primaryKey(),
    incident_id: text('incident_id')
      .notNull()
      .references(() => incidents.id),
    /** Clave del objeto en R2. Nunca se expone en la API. */
    storage_key: text('storage_key').notNull(),
    mime: text('mime', { enum: MIMES_EVIDENCIA }).notNull(),
    tamano_bytes: integer('tamano_bytes').notNull(),
    /** SHA-256 en hex minúsculas. */
    sha256: text('sha256').notNull(),
    subido: integer('subido', { mode: 'boolean' }).notNull().default(false),
    subido_at: text('subido_at'),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    index('evidences_incident_id').on(t.incident_id),
    uniqueIndex('evidences_storage_key_unico').on(t.storage_key),
    check('evidences_mime_valido', enLista('mime', MIMES_EVIDENCIA)),
    check(
      'evidences_tamano_valido',
      sql.raw(`tamano_bytes > 0 AND tamano_bytes <= ${String(MAX_EVIDENCIA_BYTES)}`),
    ),
    check('evidences_sha256_hex', sql`length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'`),
    check('evidences_subido_booleano', booleano('subido')),
    check(
      'evidences_subido_coherente',
      sql`(subido = 0 AND subido_at IS NULL) OR (subido = 1 AND subido_at IS NOT NULL)`,
    ),
    check('evidences_fechas_iso', fechas(MARCAS, ['subido_at'])),
  ],
);

export const validations = sqliteTable(
  'validations',
  {
    id: text('id').primaryKey(),
    consumption_id: text('consumption_id')
      .notNull()
      .references(() => consumptions.id),
    decision: text('decision', { enum: DECISIONES }).notNull(),
    /** Obligatorio (mínimo 3 caracteres) si se rechaza. */
    motivo: text('motivo'),
    validado_por: text('validado_por')
      .notNull()
      .references(() => users.id),
    client_created_at: text('client_created_at').notNull(),
    server_received_at: text('server_received_at').notNull(),
    ...marcasDeTiempo(),
    ...marcaDeEscritura(),
  },
  (t) => [
    // Un consumo se decide una sola vez (también cubre el índice `validations(consumption_id)` de §4).
    uniqueIndex('validations_consumption_id_unico').on(t.consumption_id),
    check('validations_decision_valida', enLista('decision', DECISIONES)),
    check(
      'validations_motivo_si_rechaza',
      sql`decision = 'aprobado' OR (motivo IS NOT NULL AND length(trim(motivo)) >= 3)`,
    ),
    check('validations_fechas_iso', fechas([...MARCAS, 'client_created_at', 'server_received_at'])),
  ],
);

// ---------------------------------------------------------------------------------------------
// Sincronización y auditoría
// ---------------------------------------------------------------------------------------------

export const sync_mutations = sqliteTable(
  'sync_mutations',
  {
    /** Garantiza la idempotencia de `/sync/push` (§6). */
    mutation_id: text('mutation_id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    device_id: text('device_id')
      .notNull()
      .references(() => devices.id),
    /** Tipo declarado por el cliente. Sin CHECK: una mutación inválida también se guarda (ADR 0009). */
    tipo: text('tipo').notNull(),
    resultado: text('resultado', { enum: RESULTADOS_MUTACION }).notNull(),
    respuesta_json: text('respuesta_json').notNull(),
    /** Payload original de las mutaciones `rechazada` o `conflicto` (ADR 0009). */
    payload_json: text('payload_json'),
    procesada_at: text('procesada_at').notNull(),
    ...marcasDeTiempo(),
  },
  (t) => [
    index('sync_mutations_user_id_procesada_at').on(t.user_id, t.procesada_at),
    // `sync_mutations_no_aplicadas_consumo` (índice por expresión sobre `json_extract`, revisión de
    // la Fase 3, B1) NO se declara aquí: drizzle-kit 0.31 no sabe generar índices por expresión (parte
    // la expresión en columnas entre comillas). Vive solo en migrations/0006 (custom) y la prueba
    // esquema-vs-migraciones lo excluye de la comparación.
    check('sync_mutations_resultado_valido', enLista('resultado', RESULTADOS_MUTACION)),
    check('sync_mutations_respuesta_json', json('respuesta_json')),
    check(
      'sync_mutations_payload_json',
      sql.raw(
        `payload_json IS NULL OR (json_valid(payload_json) AND length(payload_json) <= ${String(MAX_PAYLOAD_JSON_BYTES)})`,
      ),
    ),
    check('sync_mutations_fechas_iso', fechas([...MARCAS, 'procesada_at'])),
  ],
);

export const audit_log = sqliteTable(
  'audit_log',
  {
    /** Cursor de `/sync/pull` (ADR 0005). AUTOINCREMENT: nunca se reutiliza un valor. */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    entidad: text('entidad').notNull(),
    entidad_id: text('entidad_id').notNull(),
    accion: text('accion').notNull(),
    /**
     * Orden a la que pertenece la entidad auditada (orden, asignación, plan, consumo, novedad,
     * evidencia, validación); NULL en las demás. Sin FK, igual que `entidad_id` (ADR 0010).
     */
    order_id: text('order_id'),
    /** NULL en acciones del sistema (migraciones, cron). */
    actor_id: text('actor_id').references(() => users.id),
    device_id: text('device_id').references(() => devices.id),
    /** Nunca contiene secretos (`password_hash`, `token_hash`…). */
    datos_antes: text('datos_antes'),
    datos_despues: text('datos_despues'),
    client_at: text('client_at'),
    server_at: text('server_at').notNull(),
    alerta_reloj: integer('alerta_reloj', { mode: 'boolean' }).notNull().default(false),
    ...marcasDeTiempo(),
  },
  (t) => [
    uniqueIndex('audit_log_id_unico').on(t.id),
    index('audit_log_entidad_entidad_id').on(t.entidad, t.entidad_id),
    index('audit_log_actor_id_seq').on(t.actor_id, t.seq),
    // Línea de tiempo de una orden y visibilidad del pull (ADR 0010, H8).
    index('audit_log_order_id_seq')
      .on(t.order_id, t.seq)
      .where(sql`order_id IS NOT NULL`),
    check('audit_log_datos_antes_json', json('datos_antes', true)),
    check('audit_log_datos_despues_json', json('datos_despues', true)),
    check('audit_log_alerta_reloj_booleano', booleano('alerta_reloj')),
    check('audit_log_fechas_iso', fechas([...MARCAS, 'server_at'], ['client_at'])),
  ],
);

// ---------------------------------------------------------------------------------------------
// Esquema completo, tipos y cliente
// ---------------------------------------------------------------------------------------------

export const schema = {
  users,
  devices,
  refresh_tokens,
  login_cupos,
  settings,
  materials,
  production_orders,
  order_supervisors,
  order_planned_materials,
  consumptions,
  incidents,
  evidences,
  validations,
  sync_mutations,
  audit_log,
};

export type FilaUsuario = Omit<typeof users.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevoUsuario = Omit<typeof users.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaDispositivo = typeof devices.$inferSelect;
export type NuevoDispositivo = typeof devices.$inferInsert;
export type FilaRefreshToken = Omit<typeof refresh_tokens.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevoRefreshToken = Omit<typeof refresh_tokens.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaLoginCupo = typeof login_cupos.$inferSelect;
export type FilaSetting = Omit<typeof settings.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevoSetting = Omit<typeof settings.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaMaterial = Omit<typeof materials.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevoMaterial = Omit<typeof materials.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaOrden = Omit<typeof production_orders.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevaOrden = Omit<typeof production_orders.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaSupervisorOrden = Omit<typeof order_supervisors.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevoSupervisorOrden = Omit<
  typeof order_supervisors.$inferInsert,
  typeof COLUMNA_MARCA
>;
export type FilaMaterialPlaneado = Omit<
  typeof order_planned_materials.$inferSelect,
  typeof COLUMNA_MARCA
>;
export type NuevoMaterialPlaneado = Omit<
  typeof order_planned_materials.$inferInsert,
  typeof COLUMNA_MARCA
>;
export type FilaConsumo = Omit<typeof consumptions.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevoConsumo = Omit<typeof consumptions.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaNovedad = Omit<typeof incidents.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevaNovedad = Omit<typeof incidents.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaEvidencia = Omit<typeof evidences.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevaEvidencia = Omit<typeof evidences.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaValidacion = Omit<typeof validations.$inferSelect, typeof COLUMNA_MARCA>;
export type NuevaValidacion = Omit<typeof validations.$inferInsert, typeof COLUMNA_MARCA>;
export type FilaMutacionSync = typeof sync_mutations.$inferSelect;
export type NuevaMutacionSync = typeof sync_mutations.$inferInsert;
export type FilaAuditoria = typeof audit_log.$inferSelect;
export type NuevaAuditoria = typeof audit_log.$inferInsert;

/** Cliente Drizzle tipado sobre el binding D1. */
export function crearDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof crearDb>;

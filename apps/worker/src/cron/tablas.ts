// Tablas que exporta el backup, su clave primaria y sus columnas (ADR 0014, revisión del esquema H9;
// ADR 0020 y ADR 0021).
//
// Orden de exportación (ADR 0021, punto 2):
// - Las tablas de negocio van hijos antes que padres (defensa en profundidad: como nada se borra,
//   una fila hija exportada tiene a su padre en un archivo exportado DESPUÉS).
// - `audit_log` va AL FINAL y acotada por `seq <= seq_final` (MAX(seq) al empezarla). Así toda
//   versión de una fila de negocio presente en el backup tiene su auditoría en el archivo (lema de
//   cobertura), y la restauración puede reconstruir el estado exacto en el corte
//   (`scripts/restauracion-nucleo.mjs`). Supone que las lecturas del backup van a la base primaria
//   (sin Sessions API ni réplicas de lectura de D1; ADR 0021, P5).
//
// `columnas` (ADR 0020) se usa para estimar en SQL el tamaño de cada fila (`octet_length`) y acotar
// la página por bytes. La prueba `fase6-cron-backup.test.ts` verifica que esta lista cubre todas las
// tablas del esquema y que `pk` y `columnas` son exactamente los de cada una.

export interface TablaBackup {
  readonly nombre: string;
  /** Columnas de la clave primaria, en el orden de paginación. */
  readonly pk: readonly string[];
  /** Todas las columnas de la tabla (en el orden del esquema). */
  readonly columnas: readonly string[];
  /** Solo `audit_log`: sus páginas se acotan a `seq <= seq_final` (ADR 0021). */
  readonly acotadaPorSeqFinal?: true;
}

const MARCAS = ['created_at', 'updated_at'] as const;

export const TABLAS_BACKUP: readonly TablaBackup[] = [
  {
    nombre: 'sync_mutations',
    pk: ['mutation_id'],
    columnas: [
      'mutation_id',
      'user_id',
      'device_id',
      'tipo',
      'resultado',
      'respuesta_json',
      'payload_json',
      'procesada_at',
      ...MARCAS,
    ],
  },
  {
    nombre: 'validations',
    pk: ['id'],
    columnas: [
      'id',
      'consumption_id',
      'decision',
      'motivo',
      'validado_por',
      'client_created_at',
      'server_received_at',
      ...MARCAS,
    ],
  },
  {
    nombre: 'evidences',
    pk: ['id'],
    columnas: [
      'id',
      'incident_id',
      'storage_key',
      'mime',
      'tamano_bytes',
      'sha256',
      'subido',
      'subido_at',
      ...MARCAS,
    ],
  },
  {
    nombre: 'incidents',
    pk: ['id'],
    columnas: [
      'id',
      'consumption_id',
      'tipo',
      'descripcion',
      'registrado_por',
      'client_created_at',
      'server_received_at',
      ...MARCAS,
    ],
  },
  {
    nombre: 'consumptions',
    pk: ['id'],
    columnas: [
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
      ...MARCAS,
    ],
  },
  {
    nombre: 'order_planned_materials',
    pk: ['order_id', 'material_id'],
    columnas: ['order_id', 'material_id', 'cantidad_planeada', 'unidad', ...MARCAS],
  },
  {
    nombre: 'order_supervisors',
    pk: ['order_id', 'user_id'],
    columnas: ['order_id', 'user_id', 'asignado_por', 'activo', ...MARCAS],
  },
  {
    nombre: 'refresh_tokens',
    pk: ['id'],
    columnas: [
      'id',
      'user_id',
      'device_id',
      'token_hash',
      'familia_id',
      'expira_at',
      'revocado_at',
      'reemplazado_por',
      ...MARCAS,
    ],
  },
  {
    nombre: 'login_cupos',
    pk: ['user_id', 'origen'],
    columnas: [
      'user_id',
      'origen',
      'fallos',
      'ventana_inicio',
      'bloqueado_hasta',
      'reserva_id',
      ...MARCAS,
    ],
  },
  {
    nombre: 'devices',
    pk: ['id'],
    columnas: [
      'id',
      'user_id',
      'instalacion_id',
      'nombre',
      'user_agent',
      'ultimo_sync_at',
      ...MARCAS,
    ],
  },
  {
    nombre: 'settings',
    pk: ['clave'],
    columnas: ['clave', 'valor', 'actualizado_por', ...MARCAS],
  },
  {
    nombre: 'production_orders',
    pk: ['id'],
    columnas: [
      'id',
      'codigo',
      'linea',
      'estado',
      'fecha_inicio',
      'fecha_fin',
      'creada_por',
      ...MARCAS,
    ],
  },
  {
    nombre: 'materials',
    pk: ['id'],
    columnas: ['id', 'codigo', 'nombre', 'unidad', 'costo_unitario_cop', 'activo', ...MARCAS],
  },
  {
    nombre: 'users',
    pk: ['id'],
    columnas: [
      'id',
      'nombre',
      'email',
      'password_hash',
      'rol',
      'activo',
      'intentos_fallidos',
      'bloqueado_hasta',
      ...MARCAS,
    ],
  },
  {
    nombre: 'audit_log',
    pk: ['seq'],
    columnas: [
      'seq',
      'id',
      'entidad',
      'entidad_id',
      'accion',
      'actor_id',
      'device_id',
      'datos_antes',
      'datos_despues',
      'client_at',
      'server_at',
      'alerta_reloj',
      ...MARCAS,
      'order_id',
    ],
    acotadaPorSeqFinal: true,
  },
];

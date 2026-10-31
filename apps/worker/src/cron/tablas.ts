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
// la página por bytes, y es la lista EXACTA de columnas que se exportan (la consulta no usa `*`).
// `columnasTecnicas` son las columnas del esquema que el backup omite a propósito: la marca de
// escritura `escritura_id` (ADR 0028, enmienda de la ADR 0021), interna y sin valor fuera de su
// batch; la restauración la deja en NULL. La prueba `fase6-cron-backup.test.ts` verifica que esta
// lista, junto con `TABLAS_EXCLUIDAS_BACKUP`, cubre todas las tablas del esquema, que `pk` es la de
// cada una y que `columnas ∪ columnasTecnicas` son exactamente sus columnas.

export interface TablaBackup {
  readonly nombre: string;
  /** Columnas de la clave primaria, en el orden de paginación. */
  readonly pk: readonly string[];
  /** Columnas que se exportan (todas las del esquema salvo `columnasTecnicas`, en su orden). */
  readonly columnas: readonly string[];
  /** Columnas del esquema que el backup NO exporta a propósito (ADR 0028). */
  readonly columnasTecnicas?: readonly string[];
  /** Solo `audit_log`: sus páginas se acotan a `seq <= seq_final` (ADR 0021). */
  readonly acotadaPorSeqFinal?: true;
}

const MARCAS = ['created_at', 'updated_at'] as const;

/** Marca de escritura (ADR 0028): interna, no se exporta. */
const TECNICAS = ['escritura_id'] as const;

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
    columnasTecnicas: TECNICAS,
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
    columnasTecnicas: TECNICAS,
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
    columnasTecnicas: TECNICAS,
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
    columnasTecnicas: TECNICAS,
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
    columnasTecnicas: TECNICAS,
    pk: ['order_id', 'material_id'],
    columnas: ['order_id', 'material_id', 'cantidad_planeada', 'unidad', ...MARCAS],
  },
  {
    nombre: 'order_supervisors',
    columnasTecnicas: TECNICAS,
    pk: ['order_id', 'user_id'],
    columnas: ['order_id', 'user_id', 'asignado_por', 'activo', ...MARCAS],
  },
  {
    nombre: 'refresh_tokens',
    columnasTecnicas: TECNICAS,
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
    columnasTecnicas: TECNICAS,
    pk: ['clave'],
    columnas: ['clave', 'valor', 'actualizado_por', ...MARCAS],
  },
  {
    nombre: 'production_orders',
    columnasTecnicas: TECNICAS,
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
    columnasTecnicas: TECNICAS,
    pk: ['id'],
    columnas: ['id', 'codigo', 'nombre', 'unidad', 'costo_unitario_cop', 'activo', ...MARCAS],
  },
  {
    nombre: 'users',
    columnasTecnicas: TECNICAS,
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

/**
 * Tablas del esquema que NO se exportan a R2, a propósito (lista explícita: la prueba de cobertura
 * exige que toda tabla esté en `TABLAS_BACKUP` o aquí).
 *
 * - `login_cupos` (S-06 de docs/auditoria/seguridad-correcciones.md, ADR 0018): su `origen`
 *   `ip:<hmac>` es un dato personal seudonimizado (con el secreto, el espacio IPv4 se recorre por
 *   fuerza bruta; Ley 1581). En D1 vive como mucho unas 24 h (purga del mantenimiento); en el
 *   backup se conservaría lo que dure su retención. Es estado técnico efímero: una base restaurada
 *   empieza sin cupos (`scripts/restauracion-nucleo.mjs` la deja vacía).
 */
export const TABLAS_EXCLUIDAS_BACKUP: readonly string[] = ['login_cupos'];

/**
 * Tablas que pueden quedar `incompleta` en un backup `parcial` sin impedir la restauración (ADR
 * 0021, 4.1). Debe coincidir con `INCOMPLETAS_ADMITIDAS` de scripts/restauracion-nucleo.mjs (lo
 * comprueba `fase6-cron-aislamiento.test.ts`). Con otra tabla incompleta, el día no es restaurable
 * desde R2 y `ejecutarCron` registra `backup_no_restaurable` (revisión de esquema R-03).
 */
export const INCOMPLETAS_ADMITIDAS_RESTAURACION: readonly string[] = [
  'sync_mutations',
  'refresh_tokens',
];

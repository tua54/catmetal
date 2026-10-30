// Tablas que exporta el backup y su clave primaria (ADR 0014, revisión del esquema H9).
//
// Orden de exportación: hijos antes que padres. Como nada se borra, cualquier fila hija exportada
// tiene a su padre en un archivo exportado DESPUÉS, así que al restaurar (en orden inverso, padres
// primero) no quedan FK colgando aunque el backup no sea una foto de un único instante.
//
// La prueba `fase6-cron-backup.test.ts` verifica que esta lista cubre todas las tablas del esquema y
// que las columnas de `pk` son exactamente la clave primaria de cada una.

export interface TablaBackup {
  readonly nombre: string;
  /** Columnas de la clave primaria, en el orden de paginación. */
  readonly pk: readonly string[];
}

export const TABLAS_BACKUP: readonly TablaBackup[] = [
  { nombre: 'audit_log', pk: ['seq'] },
  { nombre: 'sync_mutations', pk: ['mutation_id'] },
  { nombre: 'validations', pk: ['id'] },
  { nombre: 'evidences', pk: ['id'] },
  { nombre: 'incidents', pk: ['id'] },
  { nombre: 'consumptions', pk: ['id'] },
  { nombre: 'order_planned_materials', pk: ['order_id', 'material_id'] },
  { nombre: 'order_supervisors', pk: ['order_id', 'user_id'] },
  { nombre: 'refresh_tokens', pk: ['id'] },
  { nombre: 'devices', pk: ['id'] },
  { nombre: 'settings', pk: ['clave'] },
  { nombre: 'production_orders', pk: ['id'] },
  { nombre: 'materials', pk: ['id'] },
  { nombre: 'users', pk: ['id'] },
];

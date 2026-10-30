// API pública de la capa de datos local (Dexie + outbox), tarea 3.3. El motor de sync (3.5), el
// cliente de auth (3.4) y la UI (Fase 4) importan desde aquí.
export * from './tipos';
export {
  CatmetalDb,
  NOMBRE_DB,
  ESQUEMA_V1,
  ESQUEMA_V2,
  db,
  obtenerInstalacionId,
  claveEntidad,
} from './db';
export { ErrorDatosLocales, type CodigoErrorLocal } from './errores';
export * from './outbox';
export * from './retencion';
export * from './consultas';
export {
  aplicarCambios,
  aplicarEntidades,
  completarHidratacion,
  completarSnapshot,
  leerMetaSync,
  type AccionMotor,
  type EntidadSync,
  type ResultadoAplicarCambios,
} from './aplicar-cambios';
export { nombreCorto, textoEvento } from './trazabilidad';

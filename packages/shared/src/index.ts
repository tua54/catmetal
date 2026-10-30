// Punto de entrada de @catmetal/shared: contratos entre la PWA y el Worker.
export * from './dominio';
export * from './permisos';
export * from './errores';
export * from './unidades';
export * from './formato';
export * from './fechas';
export * from './uuid';
export * from './esquemas';
export * from './consultas';
export * from './reportes';
export type * from './tipos';

/** Nombre del paquete (lo usan las pruebas de humo de los demás paquetes). */
export const NOMBRE_PAQUETE = '@catmetal/shared';

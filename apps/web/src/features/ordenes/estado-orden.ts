import { ESTADOS_ORDEN, type EstadoOrden, type Rol } from '@catmetal/shared';

export const NOMBRE_ESTADO_ORDEN: Readonly<Record<EstadoOrden, string>> = {
  planeada: 'Planeada',
  en_proceso: 'En proceso',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

export function nombreEstadoOrden(estado: string): string {
  return (ESTADOS_ORDEN as readonly string[]).includes(estado)
    ? NOMBRE_ESTADO_ORDEN[estado as EstadoOrden]
    : estado;
}

/** Rol en minúscula para la línea de tiempo, como en el Figma: "Juan S. (supervisor)". */
export const ROL_EN_LINEA: Readonly<Record<Rol, string>> = {
  supervisor: 'supervisor',
  jefe: 'jefe',
  admin: 'administrador',
};

/** Clases del indicador de estado de una orden (texto + borde; el color no es lo único). */
export const CLASE_ESTADO_ORDEN: Readonly<Record<EstadoOrden, string>> = {
  planeada: 'border-ink-400 bg-surface-200 text-ink-700',
  en_proceso: 'border-brand-600 bg-white text-brand-600',
  finalizada: 'border-success-700/40 bg-success-100 text-success-700',
  cancelada: 'border-danger-700 bg-danger-100 text-danger-700',
};

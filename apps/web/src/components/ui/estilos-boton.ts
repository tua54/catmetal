// Clases de los botones (compartidas por `Boton` y `EnlaceBoton`). Archivo aparte para que los
// componentes solo exporten componentes (Fast Refresh).
import { cx } from './clases';

export type VarianteBoton =
  'primario' | 'exito' | 'peligro' | 'peligroRelleno' | 'secundario' | 'fantasma';
export type TamanoBoton = 'normal' | 'grande';

export const BASE =
  'relative inline-flex select-none items-center justify-center gap-2 rounded-lg px-5 text-base font-semibold leading-tight transition-colors touch-manipulation';

export const VARIANTES: Record<VarianteBoton, string> = {
  primario: 'bg-brand-600 text-white active:bg-brand-700 hover:bg-brand-500',
  exito: 'bg-success-700 text-white active:bg-success-800 hover:bg-success-800',
  peligro:
    'border-2 border-danger-700 bg-white text-danger-700 active:bg-danger-100 hover:bg-danger-50',
  // Confirmación final de una acción destructiva (dentro del diálogo). white / danger-700 = 6,47:1
  peligroRelleno: 'bg-danger-700 text-white active:bg-danger-800 hover:bg-danger-800',
  secundario:
    'border border-ink-400 bg-white text-ink-700 active:bg-surface-200 hover:bg-surface-50',
  fantasma:
    'bg-transparent text-brand-600 underline-offset-4 active:bg-brand-100 hover:bg-brand-50',
};

export const INACTIVO =
  'cursor-not-allowed border border-line-200 bg-surface-200 text-ink-500 shadow-none';

export const TAMANOS: Record<TamanoBoton, string> = {
  normal: 'min-h-11 min-w-11 py-2',
  grande: 'min-h-14 min-w-14 py-3 text-lg',
};

/**
 * Clases de un botón (también para enlaces que se ven como botón, ver `EnlaceBoton`): misma altura
 * táctil, variante y ancho que `Boton`, sin los estados de carga ni de deshabilitado.
 */
export function clasesBoton({
  variante = 'primario',
  tamano = 'normal',
  anchoCompleto = false,
}: { variante?: VarianteBoton; tamano?: TamanoBoton; anchoCompleto?: boolean } = {}): string {
  return cx(BASE, TAMANOS[tamano], VARIANTES[variante], anchoCompleto && 'w-full');
}

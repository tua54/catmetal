import type { ReactNode } from 'react';
import { cx } from './clases';
import { IconoAdvertencia } from './iconos';

export interface PropsBloqueNovedad {
  /**
   * Encabezado del bloque. Puede ser texto ("Justificación del supervisor:") o un control, por
   * ejemplo un `<Interruptor etiqueta="¿Hay una novedad en este consumo?">`.
   */
  titulo: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Contenedor ámbar del Figma para novedades: fondo warning-100, borde warning-500 (decorativo) e
 * ícono warning-700 (4,51:1). El texto dentro debe ir en ink-700 o warning-800, nunca en ink-500
 * (4,38:1, no cumple AA).
 */
export function BloqueNovedad({ titulo, children, className }: PropsBloqueNovedad) {
  return (
    <div
      className={cx(
        'rounded-lg border-2 border-warning-500 bg-warning-100 p-4 text-ink-700',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <IconoAdvertencia className="mt-2.5 size-5 shrink-0 text-warning-700" />
        <div className="min-w-0 flex-1 font-semibold text-ink-950">{titulo}</div>
      </div>
      {children && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

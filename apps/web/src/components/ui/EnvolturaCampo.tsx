import type { ReactNode } from 'react';
import { cx } from './clases';
import { IconoAdvertencia } from './iconos';

export interface PropsEnvolturaCampo {
  idControl: string;
  idAyuda: string;
  idError: string;
  /** Id de la etiqueta (para `aria-labelledby` de popups como el listbox del combobox). */
  idEtiqueta?: string;
  etiqueta: ReactNode;
  ayuda?: ReactNode;
  error?: ReactNode;
  requerido?: boolean;
  /** Oculta visualmente la etiqueta (sigue siendo el nombre accesible). Úsalo con moderación. */
  etiquetaOculta?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Estructura común de un campo: etiqueta visible asociada, control, ayuda y error.
 * El error lleva ícono y texto (no solo color) y se enlaza con `aria-describedby` desde el control.
 */
export function EnvolturaCampo({
  idControl,
  idAyuda,
  idError,
  idEtiqueta,
  etiqueta,
  ayuda,
  error,
  requerido,
  etiquetaOculta,
  className,
  children,
}: PropsEnvolturaCampo) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label
        id={idEtiqueta}
        htmlFor={idControl}
        className={cx('text-sm font-semibold text-ink-700', etiquetaOculta && 'sr-only')}
      >
        {etiqueta}
        {requerido && (
          <>
            <span aria-hidden="true" className="text-danger-700">
              {' '}
              *
            </span>
            <span className="sr-only"> (obligatorio)</span>
          </>
        )}
      </label>
      {children}
      {ayuda && (
        <p id={idAyuda} className="text-sm text-ink-500">
          {ayuda}
        </p>
      )}
      {error && (
        <p id={idError} className="flex items-start gap-1.5 text-sm font-medium text-danger-700">
          <IconoAdvertencia className="mt-px size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

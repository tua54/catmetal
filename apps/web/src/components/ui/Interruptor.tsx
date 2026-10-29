import { useId, type ReactNode } from 'react';
import { cx, unirIds } from './clases';
import { IconoCandado } from './iconos';

export interface PropsInterruptor {
  /** Etiqueta visible (nombre accesible del switch). Tocarla también cambia el estado. */
  etiqueta: ReactNode;
  activado: boolean;
  alCambiar: (activado: boolean) => void;
  /** Texto de ayuda bajo la etiqueta. */
  ayuda?: ReactNode;
  /**
   * Bloquea el interruptor en su estado actual y muestra el motivo (p. ej. el consumo supera la
   * tolerancia y la novedad es obligatoria). Queda enfocable (`aria-disabled`) para que el motivo
   * se lea con el lector de pantalla.
   */
  bloqueado?: boolean;
  motivoBloqueo?: ReactNode;
  /** Deshabilitado sin explicación (no enfocable). */
  deshabilitado?: boolean;
  id?: string;
  className?: string;
}

/**
 * Interruptor accesible: `<button role="switch" aria-checked>` con `<label for>` visible.
 * Espacio y Enter lo cambian (comportamiento nativo del botón). Toda la fila mide ≥ 44 px.
 */
export function Interruptor({
  etiqueta,
  activado,
  alCambiar,
  ayuda,
  bloqueado = false,
  motivoBloqueo,
  deshabilitado = false,
  id,
  className,
}: PropsInterruptor) {
  const idGenerado = useId();
  const idControl = id ?? `switch-${idGenerado}`;
  const idAyuda = `${idControl}-ayuda`;
  const idMotivo = `${idControl}-motivo`;
  const mostrarMotivo = bloqueado && Boolean(motivoBloqueo);

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className="flex min-h-11 items-center gap-4">
        <label
          htmlFor={idControl}
          className={cx(
            'flex min-h-11 flex-1 items-center py-2 text-base font-semibold text-ink-950',
            !bloqueado && !deshabilitado && 'cursor-pointer',
          )}
        >
          {etiqueta}
        </label>
        <button
          id={idControl}
          type="button"
          role="switch"
          aria-checked={activado}
          aria-disabled={bloqueado ? true : undefined}
          aria-describedby={unirIds(ayuda && idAyuda, mostrarMotivo && idMotivo)}
          disabled={deshabilitado}
          onClick={() => {
            if (!bloqueado) {
              alCambiar(!activado);
            }
          }}
          className={cx(
            // Objetivo táctil de 44 px de alto con la pista visible de 32 px.
            'relative inline-flex h-11 w-16 shrink-0 items-center rounded-full touch-manipulation',
            (bloqueado || deshabilitado) && 'cursor-not-allowed',
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              'absolute inset-x-0 top-1/2 h-8 -translate-y-1/2 rounded-full border-2 transition-colors',
              activado ? 'border-brand-600 bg-brand-600' : 'border-ink-400 bg-surface-200',
              deshabilitado && 'opacity-50',
            )}
          />
          <span
            aria-hidden="true"
            className={cx(
              'relative flex size-6 items-center justify-center rounded-full bg-white shadow transition-transform',
              activado ? 'translate-x-9' : 'translate-x-1',
            )}
          >
            {bloqueado && <IconoCandado className="size-3.5 text-ink-700" />}
          </span>
        </button>
      </div>
      {ayuda && (
        <p id={idAyuda} className="text-sm text-ink-700">
          {ayuda}
        </p>
      )}
      {mostrarMotivo && (
        <p id={idMotivo} className="flex items-start gap-1.5 text-sm font-medium text-ink-700">
          <IconoCandado className="mt-0.5 size-4 shrink-0" />
          <span>{motivoBloqueo}</span>
        </p>
      )}
    </div>
  );
}

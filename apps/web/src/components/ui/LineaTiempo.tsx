import { formatearHora } from '@catmetal/shared';
import { cx } from './clases';

/**
 * Tipo de evento: define el color del punto. El significado lo llevan el actor, el rol y la
 * descripción; el punto es refuerzo visual (y lleva un texto oculto con el tipo).
 */
export type TipoEventoLinea = 'sistema' | 'registro' | 'novedad' | 'validacion' | 'rechazo';

export interface EventoLinea {
  id: string;
  /** Instante ISO 8601 (hora de Bogotá en pantalla). */
  fechaHora: string;
  /** "Juan S.", "Sistema". */
  actor: string;
  /** "supervisor", "jefe"… Se muestra entre paréntesis. */
  rol?: string;
  descripcion: string;
  tipo: TipoEventoLinea;
}

// Puntos sobre blanco (≥ 3:1): ink-500 4,88 · navy-800 11,35 · warning-700 5,02 · success-700 5,02 · danger-700 6,47
const PUNTOS: Record<TipoEventoLinea, string> = {
  sistema: 'bg-ink-500',
  registro: 'bg-navy-800',
  novedad: 'bg-warning-700',
  validacion: 'bg-success-700',
  rechazo: 'bg-danger-700',
};

const NOMBRE_TIPO: Record<TipoEventoLinea, string> = {
  sistema: 'Evento del sistema',
  registro: 'Registro',
  novedad: 'Registro con novedad',
  validacion: 'Validación',
  rechazo: 'Rechazo',
};

export interface PropsLineaTiempo {
  /** Nombre accesible de la lista ("Trazabilidad completa de la orden"). */
  etiqueta: string;
  eventos: readonly EventoLinea[];
  /**
   * `completa` (jefe): hora — actor (rol) en negrita y descripción debajo.
   * `compacta` (supervisor, "este dispositivo"): una línea "10:24 a. m. · Juan S. registró…".
   */
  variante?: 'completa' | 'compacta';
  className?: string;
}

/** Línea de tiempo de trazabilidad (lista ordenada `<ol>` con `<time>`). */
export function LineaTiempo({
  etiqueta,
  eventos,
  variante = 'completa',
  className,
}: PropsLineaTiempo) {
  return (
    <ol aria-label={etiqueta} className={cx('flex flex-col', className)}>
      {eventos.map((evento, indice) => {
        const ultimo = indice === eventos.length - 1;
        const hora = formatearHora(evento.fechaHora);
        return (
          <li key={evento.id} className="relative flex gap-3 pb-4 last:pb-0">
            {/* Riel vertical entre puntos (decorativo). */}
            {!ultimo && (
              <span
                aria-hidden="true"
                className="absolute top-5 bottom-0 left-[5px] w-0.5 bg-line-200"
              />
            )}
            <span
              aria-hidden="true"
              className={cx(
                'relative mt-1.5 size-3 shrink-0 rounded-full ring-2 ring-white',
                PUNTOS[evento.tipo],
              )}
            />
            <span className="sr-only">{NOMBRE_TIPO[evento.tipo]}: </span>
            {variante === 'completa' ? (
              <div className="min-w-0 text-[0.9375rem]">
                <p className="cifras font-semibold text-ink-950">
                  <time dateTime={evento.fechaHora}>{hora}</time>
                  {' — '}
                  {evento.actor}
                  {evento.rol && <span className="font-normal text-ink-700"> ({evento.rol})</span>}
                </p>
                <p className="mt-0.5 text-ink-700">{evento.descripcion}</p>
              </div>
            ) : (
              <p className="cifras min-w-0 text-[0.9375rem] text-ink-700">
                <time dateTime={evento.fechaHora} className="font-semibold text-ink-950">
                  {hora}
                </time>
                {' · '}
                {evento.actor} {evento.descripcion}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

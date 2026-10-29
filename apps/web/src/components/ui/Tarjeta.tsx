import { useId, type ReactNode } from 'react';
import { cx } from './clases';

export interface PropsTarjeta {
  /** Título de la sección (nombre accesible de la región). */
  titulo?: ReactNode;
  /** Nivel del encabezado del título (por defecto h2: la página tiene su h1). */
  nivelTitulo?: 2 | 3 | 4;
  /** Línea corta de 3 px en brand-600 bajo el título, como en el sitio corporativo. */
  acento?: boolean;
  /** Contenido a la derecha del título (p. ej. el chip "3 pendientes" o un botón). */
  acciones?: ReactNode;
  /** Borde de 2 px en brand-600 (p. ej. la tarjeta de consumo seleccionada del jefe). */
  resaltada?: boolean;
  /** Pie fijo al fondo de la tarjeta (p. ej. "Guardar registro"). */
  pie?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Tarjeta blanca con título de sección. Si tiene título se expone como región (`<section>`). */
export function Tarjeta({
  titulo,
  nivelTitulo = 2,
  acento = false,
  acciones,
  resaltada = false,
  pie,
  children,
  className,
}: PropsTarjeta) {
  const idTitulo = useId();
  const Encabezado = `h${nivelTitulo}` as const;
  const Contenedor = titulo ? 'section' : 'div';

  return (
    <Contenedor
      aria-labelledby={titulo ? idTitulo : undefined}
      className={cx(
        'flex flex-col rounded-xl bg-white shadow-sm',
        resaltada ? 'border-2 border-brand-600' : 'border border-line-200',
        className,
      )}
    >
      {(titulo || acciones) && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          {titulo && (
            <div className="min-w-0">
              <Encabezado id={idTitulo} className="text-lg font-semibold text-ink-950">
                {titulo}
              </Encabezado>
              {acento && (
                <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-600" />
              )}
            </div>
          )}
          {acciones && <div className="flex shrink-0 items-center gap-2">{acciones}</div>}
        </div>
      )}
      <div className="flex-1 p-5">{children}</div>
      {pie && <div className="border-t border-line-200 p-5">{pie}</div>}
    </Contenedor>
  );
}

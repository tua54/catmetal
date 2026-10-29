import { formatearCantidad, formatearHora } from '@catmetal/shared';
import type { ReactNode } from 'react';
import { cx } from './clases';
import { IconoAdvertencia, IconoChevronDerecha } from './iconos';

export interface PropsListaRegistros {
  /** Nombre accesible de la lista (p. ej. "Registros de hoy"). */
  etiqueta: string;
  children: ReactNode;
  className?: string;
}

/** Lista semántica (`<ul>`) de filas de registro, con separación ≥ 8 px entre objetivos táctiles. */
export function ListaRegistros({ etiqueta, children, className }: PropsListaRegistros) {
  return (
    <ul aria-label={etiqueta} className={cx('flex flex-col gap-2', className)}>
      {children}
    </ul>
  );
}

export interface PropsFilaRegistro {
  /** Material, p. ej. "Arena sílice". */
  material: string;
  /** Texto secundario opcional (código o lote), p. ej. "MP-001 · Lote 4471". */
  detalle?: string;
  cantidad: number;
  unidad: string;
  /** Instante ISO 8601; se muestra como hora de Bogotá ("10:24 a. m."). */
  fechaHora: string;
  conNovedad?: boolean;
  /** Chip de estado (normalmente un `<Chip>` no accionable). */
  estado?: ReactNode;
  /**
   * Hace accionable toda la fila (área táctil completa, con chevron visible). Si la fila es
   * accionable, el chip no debe serlo: no se anidan controles.
   */
  alPresionar?: () => void;
}

/** Fila de "Registros de hoy": material, cantidad (cifras tabulares), hora, novedad y estado. */
export function FilaRegistro({
  material,
  detalle,
  cantidad,
  unidad,
  fechaHora,
  conNovedad = false,
  estado,
  alPresionar,
}: PropsFilaRegistro) {
  const hora = formatearHora(fechaHora);

  const cuerpo = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold text-ink-950">{material}</span>
        {detalle && <span className="cifras text-[0.9375rem] text-ink-500">{detalle}</span>}
        <span className="cifras flex flex-wrap items-center gap-x-2 text-[0.9375rem] text-ink-700">
          <span className="font-medium whitespace-nowrap">
            {formatearCantidad(cantidad)} {unidad}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={fechaHora} className="whitespace-nowrap">
            {hora}
          </time>
          {conNovedad && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 font-medium text-warning-800">
                <IconoAdvertencia className="size-4 shrink-0" />
                con novedad
              </span>
            </>
          )}
        </span>
      </span>
      {estado && <span className="shrink-0">{estado}</span>}
    </>
  );

  const clases =
    'flex w-full items-center gap-3 rounded-lg border border-line-200 bg-surface-50 px-4 py-3 text-left';

  return (
    <li>
      {alPresionar ? (
        <button
          type="button"
          onClick={alPresionar}
          className={cx(clases, 'min-h-14 active:bg-surface-200')}
        >
          {cuerpo}
          <IconoChevronDerecha className="size-5 shrink-0 text-ink-500" />
        </button>
      ) : (
        <div className={clases}>{cuerpo}</div>
      )}
    </li>
  );
}

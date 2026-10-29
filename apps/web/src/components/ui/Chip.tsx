import type { ReactNode } from 'react';
import { cx } from './clases';
import {
  IconoAdvertencia,
  IconoChevronDerecha,
  IconoDobleCheck,
  IconoNubeCheck,
  IconoReloj,
  IconoXCirculo,
} from './iconos';

export type EstadoChip =
  | 'pendiente_sync'
  | 'sincronizado'
  | 'validado'
  | 'rechazado'
  | 'falta_novedad'
  | 'con_novedad'
  | 'pendientes';

type Tono = 'ambar' | 'verde' | 'rojo';

const TONOS: Record<Tono, string> = {
  // warning-800 / warning-100 = 6,37:1 · success-700 / success-100 = 4,57:1 · danger-700 / danger-100 = 5,30:1
  ambar: 'border-warning-500 bg-warning-100 text-warning-800',
  verde: 'border-success-700/40 bg-success-100 text-success-700',
  rojo: 'border-danger-700 bg-danger-100 text-danger-700',
};

interface Definicion {
  tono: Tono;
  texto: (cantidad: number) => string;
  icono: ReactNode;
}

const ICONO = 'size-4 shrink-0';

const DEFINICIONES: Record<EstadoChip, Definicion> = {
  pendiente_sync: {
    tono: 'ambar',
    texto: () => 'Pendiente de sync',
    icono: <IconoReloj className={ICONO} />,
  },
  sincronizado: {
    tono: 'verde',
    texto: () => 'Sincronizado',
    icono: <IconoNubeCheck className={ICONO} />,
  },
  validado: {
    tono: 'verde',
    texto: () => 'Validado por jefe',
    icono: <IconoDobleCheck className={ICONO} />,
  },
  rechazado: {
    tono: 'rojo',
    texto: () => 'Rechazado',
    icono: <IconoXCirculo className={ICONO} />,
  },
  falta_novedad: {
    tono: 'ambar',
    texto: () => 'Falta novedad',
    icono: <IconoAdvertencia className={ICONO} />,
  },
  con_novedad: {
    tono: 'ambar',
    texto: () => 'Con novedad',
    icono: <IconoAdvertencia className={ICONO} />,
  },
  pendientes: {
    tono: 'ambar',
    texto: (cantidad) => (cantidad === 1 ? '1 pendiente' : `${cantidad} pendientes`),
    icono: <IconoReloj className={ICONO} />,
  },
};

export interface PropsChip {
  estado: EstadoChip;
  /** Solo para `pendientes`: el número que se muestra ("3 pendientes"). */
  cantidad?: number;
  /**
   * Hace el chip accionable (p. ej. "Rechazado" → ver el motivo y "Crear corrección").
   * Se vuelve un botón de ≥ 44 px con un chevron que indica la acción sin depender de hover.
   */
  alPresionar?: () => void;
  /** Texto extra para lectores de pantalla cuando es accionable (por defecto "ver detalle"). */
  textoAccion?: string;
  className?: string;
}

/** Chip de estado: color + ícono + texto (el significado nunca depende solo del color). */
export function Chip({
  estado,
  cantidad = 0,
  alPresionar,
  textoAccion = 'ver detalle',
  className,
}: PropsChip) {
  const definicion = DEFINICIONES[estado];
  const clases = cx(
    'cifras inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold',
    TONOS[definicion.tono],
    className,
  );

  if (alPresionar) {
    return (
      <button
        type="button"
        onClick={alPresionar}
        className={cx(clases, 'min-h-11 px-3.5 text-sm active:brightness-95')}
      >
        {definicion.icono}
        <span>{definicion.texto(cantidad)}</span>
        <span className="sr-only">, {textoAccion}</span>
        <IconoChevronDerecha className="-mr-1 size-4 shrink-0" />
      </button>
    );
  }

  return (
    <span className={cx(clases, 'min-h-8 px-3 py-1 text-sm')}>
      {definicion.icono}
      <span>{definicion.texto(cantidad)}</span>
    </span>
  );
}

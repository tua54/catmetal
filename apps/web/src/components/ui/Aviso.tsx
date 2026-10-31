import type { ReactNode } from 'react';
import { cx } from './clases';
import { IconoAdvertencia, IconoCheck, IconoInfo, IconoX, IconoXCirculo } from './iconos';
import type { TonoAviso } from './contexto-avisos';

const ESTILOS: Record<TonoAviso, { contenedor: string; icono: ReactNode; nombre: string }> = {
  info: {
    contenedor: 'border-brand-600 bg-white',
    icono: <IconoInfo className="size-6 shrink-0 text-brand-600" />,
    nombre: 'Información',
  },
  exito: {
    contenedor: 'border-success-700 bg-success-100',
    icono: <IconoCheck className="size-6 shrink-0 text-success-700" />,
    nombre: 'Éxito',
  },
  advertencia: {
    contenedor: 'border-warning-500 bg-warning-100',
    icono: <IconoAdvertencia className="size-6 shrink-0 text-warning-700" />,
    nombre: 'Advertencia',
  },
  error: {
    contenedor: 'border-danger-700 bg-danger-100',
    icono: <IconoXCirculo className="size-6 shrink-0 text-danger-700" />,
    nombre: 'Error',
  },
};

export interface PropsAviso {
  tono?: TonoAviso;
  titulo: string;
  children?: ReactNode;
  /** Si se pasa, muestra el botón "Cerrar aviso" de 44 px. */
  alCerrar?: () => void;
  /**
   * Anuncia el aviso al aparecer: `role="alert"` para `error`/`advertencia` y `role="status"` para
   * `info`/`exito`. Déjalo en `false` para avisos estáticos o si ya está dentro de una región viva.
   */
  anunciar?: boolean;
  /** Acción opcional (p. ej. "Reintentar"). */
  accion?: ReactNode;
  className?: string;
}

/**
 * Aviso en línea (también es el cuerpo de los toasts). Ícono + texto + borde: el tono no depende
 * solo del color (el nombre del tono va oculto para lectores de pantalla).
 */
export function Aviso({
  tono = 'info',
  titulo,
  children,
  alCerrar,
  anunciar = false,
  accion,
  className,
}: PropsAviso) {
  const estilo = ESTILOS[tono];
  const rol = anunciar
    ? tono === 'error' || tono === 'advertencia'
      ? 'alert'
      : 'status'
    : undefined;

  return (
    <div
      role={rol}
      className={cx(
        'flex items-start gap-3 rounded-lg border border-l-[6px] p-4 text-ink-700 shadow-sm',
        estilo.contenedor,
        className,
      )}
    >
      <span className="mt-0.5">{estilo.icono}</span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink-950">
          <span className="sr-only">{estilo.nombre}: </span>
          {titulo}
        </p>
        {children && <div className="mt-1 text-base">{children}</div>}
        {accion && <div className="mt-3">{accion}</div>}
      </div>
      {alCerrar && (
        <button
          type="button"
          onClick={alCerrar}
          aria-label="Cerrar aviso"
          className="-my-1 -mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-700 active:bg-ink-950/10"
        >
          <IconoX className="size-5" />
        </button>
      )}
    </div>
  );
}

import type { ReactNode } from 'react';
import { cx } from './clases';
import { IconoBandeja } from './iconos';

export interface PropsEstadoVacio {
  titulo: string;
  texto?: ReactNode;
  /** Ícono decorativo (por defecto una bandeja vacía). */
  icono?: ReactNode;
  /** Acción opcional (p. ej. un `<Boton>` "Registrar consumo"). */
  accion?: ReactNode;
  /** Nivel del título (por defecto h3, dentro de una tarjeta con h2). */
  nivelTitulo?: 2 | 3 | 4;
  className?: string;
}

/** Estado vacío: explica por qué no hay datos y, si aplica, qué hacer. */
export function EstadoVacio({
  titulo,
  texto,
  icono,
  accion,
  nivelTitulo = 3,
  className,
}: PropsEstadoVacio) {
  const Titulo = `h${nivelTitulo}` as const;
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-3 rounded-lg border border-dashed border-ink-400 px-6 py-8 text-center',
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-surface-200 text-ink-700">
        {icono ?? <IconoBandeja className="size-7" />}
      </span>
      <Titulo className="text-lg font-semibold text-ink-950">{titulo}</Titulo>
      {texto && <p className="max-w-prose text-base text-ink-700">{texto}</p>}
      {accion && <div className="mt-2">{accion}</div>}
    </div>
  );
}

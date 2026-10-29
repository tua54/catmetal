import { useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import { cx, unirIds } from './clases';
import { IconoGiro } from './iconos';

export type VarianteBoton =
  'primario' | 'exito' | 'peligro' | 'peligroRelleno' | 'secundario' | 'fantasma';
export type TamanoBoton = 'normal' | 'grande';

export interface PropsBoton extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  /** `primario` (brand-600), `exito` (verde relleno), `peligro` (rojo contorno), `peligroRelleno`, `secundario`, `fantasma`. */
  variante?: VarianteBoton;
  /** `normal` = 44 px de alto; `grande` = 56 px (botones principales de planta). */
  tamano?: TamanoBoton;
  /** Ocupa todo el ancho del contenedor. */
  anchoCompleto?: boolean;
  /** Muestra un indicador, marca `aria-busy` e ignora los clics hasta que termine. */
  cargando?: boolean;
  /** Texto accesible mientras carga (por defecto "Procesando…"). */
  textoCargando?: string;
  /** Ícono a la izquierda del texto (decorativo). */
  icono?: ReactNode;
  /**
   * Deja el botón deshabilitado **pero enfocable** (`aria-disabled`) y muestra el motivo debajo,
   * enlazado con `aria-describedby`. Úsalo cuando el usuario necesite saber por qué no puede actuar
   * (p. ej. "Validar" cuando falta la novedad). Para deshabilitar sin explicación usa `disabled`.
   */
  motivoDeshabilitado?: string;
  ref?: Ref<HTMLButtonElement>;
}

const BASE =
  'relative inline-flex select-none items-center justify-center gap-2 rounded-lg px-5 text-base font-semibold leading-tight transition-colors touch-manipulation';

const VARIANTES: Record<VarianteBoton, string> = {
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

const INACTIVO =
  'cursor-not-allowed border border-line-200 bg-surface-200 text-ink-500 shadow-none';

const TAMANOS: Record<TamanoBoton, string> = {
  normal: 'min-h-11 min-w-11 py-2',
  grande: 'min-h-14 min-w-14 py-3 text-lg',
};

/**
 * Botón base. Objetivos táctiles ≥ 44 px; el hover solo se aplica en dispositivos con puntero
 * fino (Tailwind 4 envuelve `hover:` en `@media (hover: hover)`); nada depende de él.
 */
export function Boton({
  children,
  variante = 'primario',
  tamano = 'normal',
  anchoCompleto = false,
  cargando = false,
  textoCargando = 'Procesando…',
  icono,
  motivoDeshabilitado,
  disabled,
  className,
  type = 'button',
  onClick,
  'aria-describedby': describedBy,
  ref,
  ...props
}: PropsBoton) {
  const idMotivo = useId();
  const inactivoEnfocable = Boolean(motivoDeshabilitado) || cargando;
  const inactivo = Boolean(disabled) || inactivoEnfocable;

  function manejarClic(evento: MouseEvent<HTMLButtonElement>) {
    if (inactivoEnfocable) {
      evento.preventDefault();
      return;
    }
    onClick?.(evento);
  }

  const boton = (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={inactivoEnfocable ? true : undefined}
      aria-busy={cargando ? true : undefined}
      aria-describedby={unirIds(describedBy, motivoDeshabilitado && idMotivo)}
      onClick={manejarClic}
      className={cx(
        BASE,
        TAMANOS[tamano],
        inactivo && !cargando ? INACTIVO : VARIANTES[variante],
        cargando && 'cursor-progress',
        anchoCompleto && 'w-full',
        className,
      )}
      {...props}
    >
      {cargando ? <IconoGiro className="size-5 shrink-0 motion-safe:animate-spin" /> : icono}
      <span>{children}</span>
      {cargando && <span className="sr-only">{textoCargando}</span>}
    </button>
  );

  if (!motivoDeshabilitado) {
    return boton;
  }

  return (
    <span className={cx('inline-flex flex-col gap-1', anchoCompleto && 'w-full')}>
      {boton}
      <span id={idMotivo} className="text-sm text-ink-700">
        {motivoDeshabilitado}
      </span>
    </span>
  );
}

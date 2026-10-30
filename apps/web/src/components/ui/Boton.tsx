import { useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import { cx, unirIds } from './clases';
import {
  BASE,
  INACTIVO,
  TAMANOS,
  VARIANTES,
  type TamanoBoton,
  type VarianteBoton,
} from './estilos-boton';
import { IconoGiro } from './iconos';

export type { TamanoBoton, VarianteBoton } from './estilos-boton';

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

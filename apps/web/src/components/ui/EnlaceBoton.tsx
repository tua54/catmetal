import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { clasesBoton, type TamanoBoton, type VarianteBoton } from './estilos-boton';
import { cx } from './clases';

export interface PropsEnlaceBoton extends Omit<LinkProps, 'className' | 'children'> {
  children: ReactNode;
  variante?: VarianteBoton;
  tamano?: TamanoBoton;
  anchoCompleto?: boolean;
  className?: string;
}

/**
 * Enlace de navegación con el aspecto de un `Boton` (≥ 44 px, sin depender de hover). Se usa para
 * las acciones de los estados vacíos y de error que llevan a otra pantalla: sigue siendo un enlace
 * (rol `link`), así el lector de pantalla anuncia que cambia de pantalla.
 */
export function EnlaceBoton({
  children,
  variante = 'secundario',
  tamano = 'normal',
  anchoCompleto = false,
  className,
  ...props
}: PropsEnlaceBoton) {
  return (
    <Link className={cx(clasesBoton({ variante, tamano, anchoCompleto }), className)} {...props}>
      {children}
    </Link>
  );
}

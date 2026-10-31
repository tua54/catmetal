import type { SVGProps } from 'react';

/**
 * Íconos SVG inline (trazo de 2 px, 24×24, `currentColor`). Sin fuentes de íconos externas:
 * funcionan offline y respetan la CSP `'self'`. Son decorativos por defecto (`aria-hidden`);
 * el significado siempre lo lleva el texto que los acompaña.
 */
export type PropsIcono = SVGProps<SVGSVGElement>;

function Base({ children, className, ...props }: PropsIcono) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? 'size-5 shrink-0'}
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconoCheck(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Base>
  );
}

export function IconoDobleCheck(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </Base>
  );
}

export function IconoX(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Base>
  );
}

export function IconoXCirculo(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </Base>
  );
}

export function IconoReloj(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Base>
  );
}

export function IconoNubeCheck(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6 6 0 1 0 6 17.3" />
      <path d="m9 15 2 2 4-4" />
    </Base>
  );
}

export function IconoAdvertencia(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Base>
  );
}

export function IconoInfo(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Base>
  );
}

export function IconoChevronAbajo(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m6 9 6 6 6-6" />
    </Base>
  );
}

export function IconoChevronDerecha(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m9 18 6-6-6-6" />
    </Base>
  );
}

export function IconoCandado(props: PropsIcono) {
  return (
    <Base {...props}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Base>
  );
}

export function IconoClip(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Base>
  );
}

export function IconoBandeja(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Base>
  );
}

export function IconoGiro(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </Base>
  );
}

export function IconoLupa(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Base>
  );
}

export function IconoAmpliar(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </Base>
  );
}

export function IconoReducir(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6" />
    </Base>
  );
}

export function IconoSinConexion(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M12 20h.01" />
      <path d="M8.5 16.43a5 5 0 0 1 7 0" />
      <path d="M2 2l20 20" />
      <path d="M5 12.86a10 10 0 0 1 5.17-2.69" />
      <path d="M19 12.86a10 10 0 0 0-2-1.39" />
      <path d="M2 8.82a15 15 0 0 1 4.17-2.65" />
      <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
    </Base>
  );
}

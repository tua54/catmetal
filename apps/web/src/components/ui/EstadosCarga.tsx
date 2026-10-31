import type { ReactNode } from 'react';
import { Aviso } from './Aviso';
import { Boton } from './Boton';
import { cx } from './clases';
import { IconoGiro } from './iconos';

export interface PropsTextoCargando {
  /** "Cargando órdenes…". */
  texto: string;
  className?: string;
}

/**
 * Indicador de carga en línea: texto (no solo un ícono) dentro de `role="status"`, así el lector de
 * pantalla lo anuncia sin interrumpir. El giro respeta `prefers-reduced-motion`.
 */
export function TextoCargando({ texto, className }: PropsTextoCargando) {
  return (
    <p role="status" className={cx('flex items-center gap-2 text-ink-700', className)}>
      <IconoGiro className="size-5 shrink-0 text-ink-500 motion-safe:animate-spin" />
      <span>{texto}</span>
    </p>
  );
}

export interface PropsErrorCarga {
  /** "No se pudieron leer las órdenes de esta tablet". */
  titulo: string;
  /** Qué pasó y qué puede hacer la persona (en español, sin detalles técnicos). */
  children?: ReactNode;
  /** Si se pasa, muestra el botón "Reintentar". */
  alReintentar?: () => void;
  /** Acción adicional (p. ej. un enlace para volver). */
  accion?: ReactNode;
  className?: string;
}

/**
 * Error al cargar datos: aviso de error anunciado (`role="alert"`) con la acción "Reintentar".
 * Nunca muestra el error crudo: el texto lo decide la pantalla.
 */
export function ErrorCarga({ titulo, children, alReintentar, accion, className }: PropsErrorCarga) {
  const acciones =
    alReintentar || accion ? (
      <div className="flex flex-wrap gap-3">
        {alReintentar && (
          <Boton variante="secundario" onClick={alReintentar}>
            Reintentar
          </Boton>
        )}
        {accion}
      </div>
    ) : undefined;
  return (
    <Aviso tono="error" anunciar titulo={titulo} accion={acciones} className={className}>
      {children}
    </Aviso>
  );
}

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './clases';
import { retenerFondo } from './inercia';

const ENFOCABLES = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function enfocables(contenedor: HTMLElement): HTMLElement[] {
  return Array.from(contenedor.querySelectorAll<HTMLElement>(ENFOCABLES)).filter(
    (elemento) => !elemento.closest('[hidden], [inert]'),
  );
}

export interface PropsCapaModal {
  abierto: boolean;
  /** Se llama con Escape (y al pulsar "Cancelar"/"Cerrar" desde el contenido). */
  alCerrar: () => void;
  /** Id del título visible (nombre accesible del diálogo). */
  idTitulo: string;
  idDescripcion?: string;
  /** `alertdialog` para confirmaciones de acciones irreversibles. */
  rol?: 'dialog' | 'alertdialog';
  /** Elemento que recibe el foco al abrir (si no, el primer enfocable). */
  refFocoInicial?: RefObject<HTMLElement | null>;
  /** Clases del fondo (overlay). */
  claseFondo?: string;
  /** Clases del panel. */
  className?: string;
  children: ReactNode;
}

/**
 * Base de los diálogos modales. Se usa un componente propio en lugar de `<dialog>` porque jsdom no
 * implementa `showModal()` y así el comportamiento se puede probar igual que en el navegador:
 *
 * - `role="dialog"`/`alertdialog` + `aria-modal="true"`, con título enlazado.
 * - Foco atrapado: Tab y Shift+Tab dan la vuelta dentro del panel.
 * - El resto de la página queda `inert` (no enfocable ni clicable) mientras el modal está abierto.
 * - Escape cierra; al cerrar, el foco vuelve al elemento que abrió el modal.
 * - Bloquea el desplazamiento del fondo.
 */
export function CapaModal({
  abierto,
  alCerrar,
  idTitulo,
  idDescripcion,
  rol = 'dialog',
  refFocoInicial,
  claseFondo,
  className,
  children,
}: PropsCapaModal) {
  const refFondo = useRef<HTMLDivElement>(null);
  const refPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) {
      return;
    }
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fondo = refFondo.current;
    const panel = refPanel.current;

    // Vuelve inerte todo lo que no es este modal y bloquea el scroll. Es una pila (F6-09): al
    // cerrar, lo que otra capa abierta retiene (p. ej. la pantalla de bloqueo) sigue inerte.
    const liberarFondo = retenerFondo(fondo);

    const inicial = refFocoInicial?.current ?? (panel ? enfocables(panel)[0] : undefined) ?? panel;
    inicial?.focus();

    return () => {
      liberarFondo();
      // Si otra capa sigue reteniendo el elemento que abrió este modal, el foco se queda en esa capa.
      if (previo?.isConnected && previo.closest('[inert]') === null) {
        previo.focus();
      }
    };
  }, [abierto, refFocoInicial]);

  if (!abierto) {
    return null;
  }

  function manejarTecla(evento: KeyboardEvent<HTMLDivElement>) {
    if (evento.key === 'Escape') {
      if (!evento.defaultPrevented) {
        evento.preventDefault();
        evento.stopPropagation();
        alCerrar();
      }
      return;
    }
    if (evento.key !== 'Tab' || !refPanel.current) {
      return;
    }
    const lista = enfocables(refPanel.current);
    const primero = lista[0];
    const ultimo = lista[lista.length - 1];
    if (!primero || !ultimo) {
      evento.preventDefault();
      return;
    }
    const activo = document.activeElement;
    if (evento.shiftKey && (activo === primero || activo === refPanel.current)) {
      evento.preventDefault();
      ultimo.focus();
    } else if (!evento.shiftKey && activo === ultimo) {
      evento.preventDefault();
      primero.focus();
    }
  }

  return createPortal(
    <div
      ref={refFondo}
      className={cx(
        'fixed inset-0 z-50 flex items-center justify-center',
        claseFondo ?? 'bg-ink-950/60 p-4',
      )}
    >
      <div
        ref={refPanel}
        role={rol}
        aria-modal="true"
        aria-labelledby={idTitulo}
        aria-describedby={idDescripcion}
        tabIndex={-1}
        onKeyDown={manejarTecla}
        className={cx('motion-safe:animate-entrada focus:outline-none', className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

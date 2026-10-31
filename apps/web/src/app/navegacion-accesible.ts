// Accesibilidad de la navegación en la SPA (WCAG 2.4.2 y 2.4.3): título del documento por pantalla
// y foco en el `<h1>` de la pantalla nueva al cambiar de ruta (como haría una carga de página).

import { useEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router';

export const TITULO_APP = 'Control de Materia Prima · Catmetal';

/** "<pantalla> · Control de Materia Prima · Catmetal" (o solo el nombre de la app). */
export function tituloDocumento(pantalla: string | null): string {
  return pantalla ? `${pantalla} · ${TITULO_APP}` : TITULO_APP;
}

/** Pone el título de la pestaña mientras el componente está montado. */
export function useTituloDocumento(pantalla: string | null): void {
  useEffect(() => {
    document.title = tituloDocumento(pantalla);
  }, [pantalla]);
}

/**
 * Tiempo durante el que se vigila si la pantalla nueva reemplaza su `<h1>` (p. ej. "Cargando…" →
 * datos de IndexedDB): si el foco se pierde en ese lapso, vuelve al `<h1>` nuevo.
 */
export const VENTANA_FOCO_MS = 2000;

/** El foco no está en nada útil: en `<body>`, desconectado o en la barra superior. */
function focoLibre(): boolean {
  const activo = document.activeElement;
  if (activo === null || activo === document.body || !activo.isConnected) {
    return true;
  }
  return activo.closest('header') !== null;
}

/** El `<h1>` de la pantalla (enfocable solo por programa) o, si no hay, la región principal. */
function destinoDelFoco(principal: HTMLElement): HTMLElement {
  const titulo = principal.querySelector<HTMLElement>('h1');
  if (titulo === null) {
    return principal;
  }
  if (!titulo.hasAttribute('tabindex')) {
    titulo.setAttribute('tabindex', '-1');
  }
  return titulo;
}

/**
 * Al cambiar de pantalla (cambia `pathname`, no los filtros de la URL), mueve el foco al `<h1>` de
 * la pantalla nueva dentro de `principal`, para que el lector de pantalla la anuncie y el teclado
 * siga desde ahí.
 *
 * - No lo hace en la primera carga del documento (el navegador ya empieza arriba).
 * - No le quita el foco a un control que la pantalla nueva enfocó a propósito (p. ej. el primer
 *   campo de una corrección) ni a un diálogo: solo actúa si el foco quedó en `<body>` o en la barra.
 * - Si durante `VENTANA_FOCO_MS` la pantalla reemplaza su `<h1>` y el foco se pierde, lo recupera.
 *   Cualquier toque o tecla de la persona termina esa vigilancia.
 */
export function useFocoAlNavegar(principal: RefObject<HTMLElement | null>): void {
  const { pathname, key } = useLocation();
  const keyInicial = useRef(key);
  const primera = useRef(true);

  useEffect(() => {
    const esPrimera = primera.current;
    primera.current = false;
    // Primera entrada del historial (carga del documento o router en memoria de las pruebas).
    if (esPrimera && keyInicial.current === 'default') {
      return;
    }
    const contenedor = principal.current;
    if (contenedor === null || !focoLibre()) {
      return;
    }
    destinoDelFoco(contenedor).focus();

    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observador = new MutationObserver(() => {
      if (focoLibre()) {
        destinoDelFoco(contenedor).focus();
      }
    });
    observador.observe(contenedor, { childList: true, subtree: true });
    const terminar = () => {
      observador.disconnect();
      window.clearTimeout(temporizador);
      document.removeEventListener('pointerdown', terminar, true);
      document.removeEventListener('keydown', terminar, true);
    };
    const temporizador = window.setTimeout(terminar, VENTANA_FOCO_MS);
    document.addEventListener('pointerdown', terminar, true);
    document.addEventListener('keydown', terminar, true);
    return terminar;
  }, [pathname, principal]);
}

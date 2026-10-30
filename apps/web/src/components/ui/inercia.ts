// `inert` del fondo y bloqueo del scroll como una PILA de capas modales (F6-09).
//
// Cada capa abierta "retiene" los hermanos de `<body>` que no son ella: un elemento solo deja de ser
// `inert` cuando lo liberan TODAS las capas que lo retienen. Así, si se abre un diálogo, luego la
// pantalla de bloqueo por inactividad y el diálogo se cierra (por ejemplo, al terminar una petición),
// el contenido de la app sigue `inert` bajo la capa opaca hasta desbloquear.
//
// Lo que ya era `inert` por otra razón (no lo puso una capa) no se toca nunca.

/** Cuántas capas retienen cada elemento como `inert`. */
const retenciones = new Map<Element, number>();
/** Capas abiertas que bloquean el scroll del fondo. */
let capasConScrollBloqueado = 0;
/** El `overflow-hidden` del body ya estaba antes de la primera capa: no se quita al cerrar. */
let scrollYaBloqueado = false;

const CLASE_SIN_SCROLL = 'overflow-hidden';

/**
 * Vuelve `inert` todos los hijos de `<body>` salvo `capa` y bloquea el scroll del fondo. Devuelve la
 * función que libera lo retenido por esta capa (idempotente).
 */
export function retenerFondo(capa: Element | null): () => void {
  const retenidos: Element[] = [];
  for (const hermano of Array.from(document.body.children)) {
    if (hermano === capa) {
      continue;
    }
    const cuenta = retenciones.get(hermano);
    if (cuenta !== undefined) {
      retenciones.set(hermano, cuenta + 1);
      retenidos.push(hermano);
    } else if (!hermano.hasAttribute('inert')) {
      hermano.setAttribute('inert', '');
      retenciones.set(hermano, 1);
      retenidos.push(hermano);
    }
  }

  if (capasConScrollBloqueado === 0) {
    scrollYaBloqueado = document.body.classList.contains(CLASE_SIN_SCROLL);
  }
  capasConScrollBloqueado += 1;
  document.body.classList.add(CLASE_SIN_SCROLL);

  let liberada = false;
  return () => {
    if (liberada) {
      return;
    }
    liberada = true;
    for (const elemento of retenidos) {
      const cuenta = (retenciones.get(elemento) ?? 1) - 1;
      if (cuenta > 0) {
        retenciones.set(elemento, cuenta);
      } else {
        retenciones.delete(elemento);
        elemento.removeAttribute('inert');
      }
    }
    capasConScrollBloqueado -= 1;
    if (capasConScrollBloqueado === 0 && !scrollYaBloqueado) {
      document.body.classList.remove(CLASE_SIN_SCROLL);
    }
  };
}

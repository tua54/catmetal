// Lógica del Service Worker sin dependencias de `lib.webworker` ni del DOM, para poder probarla con
// Vitest y compartirla entre el proyecto del SW (src/pwa/sw/tsconfig.json) y el de la app.
//
// No importa nada de `src/sync`: ese código usa Dexie y el DOM, y no debe entrar al bundle del SW.
// Las constantes se duplican a propósito; una prueba verifica que coinciden con las de la app.

/** Etiqueta de Background Sync que registra la app (`TAG_BACKGROUND_SYNC` en src/sync). */
export const TAG_SYNC = 'catmetal-sync';

/** Tipo del mensaje que el SW envía a sus pestañas (`MENSAJE_SYNC` en src/sync). */
export const MENSAJE_SYNC = 'catmetal-sync';

/**
 * Navegaciones que NUNCA se responden con el shell de la SPA: la API siempre va a la red (y el SW
 * no tiene ninguna ruta de caché para ella).
 */
export const RUTAS_FUERA_DEL_SHELL: readonly RegExp[] = [/^\/api(\/|$)/];

/** ¿Una navegación a esta ruta se puede responder con el shell precacheado? */
export function esNavegacionDelShell(pathname: string): boolean {
  return !RUTAS_FUERA_DEL_SHELL.some((patron) => patron.test(pathname));
}

/** Mensaje de `workbox-window` (`messageSkipWaiting`) para activar una versión nueva. */
export function esMensajeSaltarEspera(datos: unknown): boolean {
  return (
    typeof datos === 'object' && datos !== null && 'type' in datos && datos.type === 'SKIP_WAITING'
  );
}

/** Lo que el SW necesita de `self.clients` (subconjunto de `Clients`). */
export interface ClientesSw {
  matchAll(opciones: {
    type: 'window';
    includeUncontrolled: boolean;
  }): Promise<readonly { postMessage(mensaje: unknown): void }[]>;
}

/**
 * Evento `sync` de Background Sync: el SW NO sincroniza (el access token vive solo en la memoria de
 * la pestaña y nunca se comparte con el SW). Avisa a las pestañas abiertas con
 * `{ tipo: 'catmetal-sync' }` y ellas programan la sincronización. Devuelve cuántas avisó.
 * Sin pestañas abiertas no hay nada que hacer: la app sincroniza al volver a abrirse.
 */
export async function reenviarSyncAClientes(clientes: ClientesSw): Promise<number> {
  const ventanas = await clientes.matchAll({ type: 'window', includeUncontrolled: true });
  for (const ventana of ventanas) {
    ventana.postMessage({ tipo: MENSAJE_SYNC });
  }
  return ventanas.length;
}

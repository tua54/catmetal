// Service Worker de la PWA (estrategia `injectManifest` de vite-plugin-pwa, tarea 4.2).
//
// - Precachea el shell (HTML, JS, CSS, fuentes e íconos del build) y responde las navegaciones con
//   `index.html` para que la app abra sin conexión. Las navegaciones a `/api/*` quedan excluidas.
// - NUNCA cachea `/api/*`: no hay ninguna ruta de runtime; esas peticiones van siempre a la red.
// - Actualización con aviso (`registerType: 'prompt'`): la versión nueva espera hasta que la app
//   envía `SKIP_WAITING` (botón "Actualizar").
// - Background Sync: el evento `sync` con la etiqueta `catmetal-sync` se reenvía a las pestañas
//   como `{ tipo: 'catmetal-sync' }`; la sincronización la hace la pestaña (ver logica.ts).

import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import {
  esMensajeSaltarEspera,
  reenviarSyncAClientes,
  RUTAS_FUERA_DEL_SHELL,
  TAG_SYNC,
} from './logica';

declare const self: ServiceWorkerGlobalScope & {
  /** Lista de precache que inyecta vite-plugin-pwa en el build. */
  __WB_MANIFEST: (string | PrecacheEntry)[];
};

/** `SyncEvent` de Background Sync (no está en `lib.webworker`). */
interface EventoSync extends ExtendableEvent {
  readonly tag: string;
}

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [...RUTAS_FUERA_DEL_SHELL],
  }),
);

self.addEventListener('message', (evento) => {
  if (esMensajeSaltarEspera(evento.data)) {
    void self.skipWaiting();
  }
});

self.addEventListener('sync', (evento) => {
  const sync = evento as EventoSync;
  if (sync.tag === TAG_SYNC) {
    sync.waitUntil(reenviarSyncAClientes(self.clients));
  }
});

// En la primera instalación, toma el control de la pestaña abierta (no hay versión anterior que
// reemplazar). En las actualizaciones la versión nueva espera a `SKIP_WAITING`.
clientsClaim();

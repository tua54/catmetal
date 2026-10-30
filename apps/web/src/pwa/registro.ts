// Registro del Service Worker desde la app (tarea 4.2). `main.tsx` pasa el `registerSW` de
// `virtual:pwa-register`; aquí no se importa el módulo virtual para poder probar esto con Vitest
// (que no carga el plugin PWA).

import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { create, type StoreApi, type UseBoundStore } from 'zustand';

export interface EstadoPwa {
  /** Hay una versión nueva instalada que espera para activarse ("Hay una versión nueva"). */
  actualizacionDisponible: boolean;
  /** El shell quedó precacheado: la app ya abre sin conexión (se avisa una vez). */
  listaSinConexion: boolean;
  /** Activa la versión nueva y recarga la página. `null` hasta registrar el SW. */
  actualizar: (() => Promise<void>) | null;
}

export type StoreEstadoPwa = UseBoundStore<StoreApi<EstadoPwa>>;

export function crearStoreEstadoPwa(): StoreEstadoPwa {
  return create<EstadoPwa>()(() => ({
    actualizacionDisponible: false,
    listaSinConexion: false,
    actualizar: null,
  }));
}

/** Estado del Service Worker para la UI. */
export const useEstadoPwa = crearStoreEstadoPwa();

export type RegistrarSW = (opciones: RegisterSWOptions) => (recargar?: boolean) => Promise<void>;

/** Cada cuánto se busca una versión nueva (tablets que pasan días con la app abierta). */
export const INTERVALO_ACTUALIZACION_MS = 60 * 60 * 1000;

export interface OpcionesRegistro {
  store?: StoreEstadoPwa;
  intervaloMs?: number;
  enLinea?: () => boolean;
  alError?: (error: unknown) => void;
}

/**
 * Registra el SW con aviso de actualización (`registerType: 'prompt'`): cuando hay una versión
 * nueva, la UI muestra "Hay una versión nueva · Actualizar" y solo se activa si el usuario acepta
 * (no se recarga en medio de un registro). Busca actualizaciones cada hora si hay conexión.
 */
export function registrarServiceWorker(
  registerSW: RegistrarSW,
  opciones: OpcionesRegistro = {},
): void {
  const store = opciones.store ?? useEstadoPwa;
  const enLinea = opciones.enLinea ?? (() => globalThis.navigator?.onLine ?? true);
  const alError = opciones.alError ?? ((error: unknown) => console.error(error));

  const actualizarSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      store.setState({ actualizacionDisponible: true });
    },
    onOfflineReady() {
      store.setState({ listaSinConexion: true });
    },
    onRegisteredSW(_url, registro) {
      if (registro === undefined) {
        return;
      }
      setInterval(() => {
        if (enLinea() && registro.installing === null) {
          registro.update().catch(alError);
        }
      }, opciones.intervaloMs ?? INTERVALO_ACTUALIZACION_MS);
    },
    onRegisterError: alError,
  });

  store.setState({ actualizar: () => actualizarSW(true) });
}

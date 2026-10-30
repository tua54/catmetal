// Registro del Service Worker desde la app (tarea 4.2). `main.tsx` pasa el `registerSW` de
// `virtual:pwa-register`; aquí no se importa el módulo virtual para poder probar esto con Vitest
// (que no carga el plugin PWA).
//
// Actualización forzada (B5, ADR 0026): si el servidor responde 426 `CLIENTE_DESACTUALIZADO`, el
// cliente HTTP llama a `avisarClienteDesactualizado`. La app muestra un aviso bloqueante, busca la
// versión nueva (`registration.update()`), la activa (`SKIP_WAITING`) y recarga. El outbox, las fotos
// y las particiones viven en IndexedDB y las migraciones de Dexie solo agregan: no se pierde nada.
// Sin versión nueva (sin red, por ejemplo) el aviso sigue y se reintenta con el siguiente 426, es
// decir, en el siguiente disparador de sync.

import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { create, type StoreApi, type UseBoundStore } from 'zustand';

export interface EstadoPwa {
  /** Hay una versión nueva instalada que espera para activarse ("Hay una versión nueva"). */
  actualizacionDisponible: boolean;
  /** El shell quedó precacheado: la app ya abre sin conexión (se avisa una vez). */
  listaSinConexion: boolean;
  /** Activa la versión nueva y recarga la página. `null` hasta registrar el SW. */
  actualizar: (() => Promise<void>) | null;
  /** B5: el servidor exige una versión más nueva (426 `CLIENTE_DESACTUALIZADO`). Aviso bloqueante. */
  desactualizado: boolean;
  /** `details.version_minima` del 426, si vino y es válida. */
  versionMinima: number | null;
  /** Se buscó la versión nueva y no estaba disponible: se reintenta en el siguiente 426. */
  sinVersionNueva: boolean;
  /**
   * Busca la versión nueva y, si la hay, la activa y recarga sin preguntar. `null` hasta registrar
   * el SW (en desarrollo no hay SW).
   */
  forzarActualizacion: (() => Promise<void>) | null;
}

export type StoreEstadoPwa = UseBoundStore<StoreApi<EstadoPwa>>;

export function crearStoreEstadoPwa(): StoreEstadoPwa {
  return create<EstadoPwa>()(() => ({
    actualizacionDisponible: false,
    listaSinConexion: false,
    actualizar: null,
    desactualizado: false,
    versionMinima: null,
    sinVersionNueva: false,
    forzarActualizacion: null,
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

  let registroSW: ServiceWorkerRegistration | undefined;
  /** Hay una versión instalada esperando `SKIP_WAITING`. */
  let enEspera = false;
  let busqueda: Promise<void> | null = null;

  const actualizarSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      enEspera = true;
      store.setState({ actualizacionDisponible: true, sinVersionNueva: false });
      if (store.getState().desactualizado) {
        // B5: la versión nueva terminó de instalarse tras un 426: se activa y recarga sin preguntar.
        actualizarSW(true).catch(alError);
      }
    },
    onOfflineReady() {
      store.setState({ listaSinConexion: true });
    },
    onRegisteredSW(_url, registro) {
      if (registro === undefined) {
        return;
      }
      registroSW = registro;
      setInterval(() => {
        if (enLinea() && registro.installing === null) {
          registro.update().catch(alError);
        }
      }, opciones.intervaloMs ?? INTERVALO_ACTUALIZACION_MS);
    },
    onRegisterError: alError,
  });

  /** B5: activa la versión en espera o la busca; si no hay ninguna, lo deja indicado. */
  async function buscarYActivar(): Promise<void> {
    store.setState({ sinVersionNueva: false });
    if (enEspera) {
      // Con `SKIP_WAITING`, workbox-window recarga la página cuando la versión nueva toma el control.
      await actualizarSW(true);
      return;
    }
    const registro = registroSW;
    if (registro !== undefined && enLinea()) {
      try {
        await registro.update();
      } catch (error) {
        alError(error);
      }
      if (enEspera || registro.waiting !== null) {
        enEspera = true;
        await actualizarSW(true);
        return;
      }
      if (registro.installing !== null) {
        // Se está instalando: al quedar en espera, `onNeedRefresh` la activa.
        return;
      }
    }
    store.setState({ sinVersionNueva: true });
  }

  store.setState({
    actualizar: () => actualizarSW(true),
    forzarActualizacion: () => {
      // Una búsqueda a la vez (varios 426 seguidos no disparan varias).
      busqueda ??= buscarYActivar()
        .catch(alError)
        .finally(() => {
          busqueda = null;
        });
      return busqueda;
    },
  });
}

/** `details.version_minima` de un 426, si es un entero positivo. */
function versionMinimaDe(detalles: unknown): number | null {
  if (typeof detalles !== 'object' || detalles === null) {
    return null;
  }
  const valor = (detalles as Record<string, unknown>).version_minima;
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor > 0 ? valor : null;
}

/**
 * El servidor respondió 426 `CLIENTE_DESACTUALIZADO` (B5, ADR 0026): se muestra el aviso bloqueante
 * y se busca y activa la versión nueva. Sin SW registrado (desarrollo) solo queda el aviso.
 */
export function avisarClienteDesactualizado(
  detalles: unknown,
  store: StoreEstadoPwa = useEstadoPwa,
): void {
  const { forzarActualizacion } = store.getState();
  store.setState({
    desactualizado: true,
    versionMinima: versionMinimaDe(detalles),
    ...(forzarActualizacion === null ? { sinVersionNueva: true } : {}),
  });
  void forzarActualizacion?.();
}

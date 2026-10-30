// Disparadores del motor de sync (docs/spec.md §6 punto 3): evento `online`, apertura de la app,
// cada 60 s si hay pendientes, botón "Sincronizar ahora", vuelta a la pestaña visible, cambio local
// y Background Sync donde exista. iOS no tiene Background Sync; los demás disparadores lo cubren.
//
// Background Sync: `registrarBackgroundSync()` registra la etiqueta `catmetal-sync`. El Service
// Worker (Fase 4) debe atender el evento `sync` con esa etiqueta enviando a sus clientes el mensaje
// `{ tipo: 'catmetal-sync' }` (`MENSAJE_SYNC`); aquí se escucha ese mensaje. El SW NO sincroniza
// solo: el access token vive en la memoria de la pestaña y nunca se comparte con el SW.

import type { MotivoSync, ResumenSync } from './motor';
import type { StoreEstadoSync } from './estado';

export const TAG_BACKGROUND_SYNC = 'catmetal-sync';
export const MENSAJE_SYNC = 'catmetal-sync';
export const INTERVALO_MS = 60_000;
export const ESPERA_MS = 1_500;

interface Escuchable {
  addEventListener(tipo: string, oyente: (evento: Event) => void): void;
  removeEventListener(tipo: string, oyente: (evento: Event) => void): void;
}

export interface OpcionesDisparadores {
  motor: { sincronizar(motivo: MotivoSync): Promise<ResumenSync> };
  estado: StoreEstadoSync;
  /** ¿Hay mutaciones o fotos pendientes del usuario de la sesión? (para el intervalo de 60 s). */
  hayPendientes: () => Promise<boolean>;
  /** Recalcula los contadores del indicador tras un cambio local. */
  actualizarContadores?: () => Promise<void>;
  ventana?: Escuchable;
  documento?: Escuchable & { visibilityState: DocumentVisibilityState };
  serviceWorker?: Escuchable | null;
  intervaloMs?: number;
  /** Agrupa varios disparos seguidos en uno solo. */
  esperaMs?: number;
  /** Errores inesperados del motor (por defecto, `console.error`). */
  alError?: (error: unknown) => void;
}

export interface Disparadores {
  /** Botón "Sincronizar ahora": inmediato, sin agrupar. */
  sincronizarAhora(): Promise<ResumenSync>;
  /** La app escribió en la cola local: actualiza el indicador y programa una sincronización. */
  cambioLocal(): void;
  /** Programa una sincronización agrupada. */
  programar(motivo: MotivoSync): void;
  detener(): void;
}

export function iniciarDisparadores(opciones: OpcionesDisparadores): Disparadores {
  const ventana = opciones.ventana ?? globalThis.window;
  const documento = opciones.documento ?? globalThis.document;
  const serviceWorker =
    opciones.serviceWorker === undefined
      ? (globalThis.navigator?.serviceWorker ?? null)
      : opciones.serviceWorker;
  const alError = opciones.alError ?? ((error: unknown) => console.error(error));
  let temporizador: ReturnType<typeof setTimeout> | null = null;
  let motivoProgramado: MotivoSync | null = null;
  let detenido = false;

  const ejecutar = (motivo: MotivoSync): Promise<ResumenSync> =>
    opciones.motor.sincronizar(motivo).catch((error: unknown) => {
      alError(error);
      throw error;
    });

  function programar(motivo: MotivoSync): void {
    if (detenido) {
      return;
    }
    motivoProgramado ??= motivo;
    if (temporizador !== null) {
      return;
    }
    temporizador = setTimeout(() => {
      temporizador = null;
      const motivoActual = motivoProgramado ?? motivo;
      motivoProgramado = null;
      ejecutar(motivoActual).catch(() => undefined);
    }, opciones.esperaMs ?? ESPERA_MS);
  }

  const alOnline = (): void => {
    opciones.estado.setState({ conexion: 'en_linea' });
    programar('online');
  };
  const alOffline = (): void => {
    opciones.estado.setState({ conexion: 'sin_conexion' });
  };
  const alVisible = (): void => {
    if (documento?.visibilityState === 'visible') {
      programar('visible');
    }
  };
  const alMensaje = (evento: Event): void => {
    const datos: unknown = (evento as MessageEvent).data;
    if (typeof datos === 'object' && datos !== null && 'tipo' in datos) {
      if (datos.tipo === MENSAJE_SYNC) {
        programar('background');
      }
    }
  };

  ventana?.addEventListener('online', alOnline);
  ventana?.addEventListener('offline', alOffline);
  documento?.addEventListener('visibilitychange', alVisible);
  serviceWorker?.addEventListener('message', alMensaje);

  const intervalo = setInterval(() => {
    opciones
      .hayPendientes()
      .then((hay) => {
        if (hay) {
          programar('intervalo');
        }
      })
      .catch(alError);
  }, opciones.intervaloMs ?? INTERVALO_MS);

  // Apertura de la app.
  programar('apertura');

  return {
    sincronizarAhora: () => ejecutar('manual'),
    cambioLocal() {
      opciones.actualizarContadores?.().catch(alError);
      programar('local');
    },
    programar,
    detener() {
      detenido = true;
      if (temporizador !== null) {
        clearTimeout(temporizador);
        temporizador = null;
      }
      clearInterval(intervalo);
      ventana?.removeEventListener('online', alOnline);
      ventana?.removeEventListener('offline', alOffline);
      documento?.removeEventListener('visibilitychange', alVisible);
      serviceWorker?.removeEventListener('message', alMensaje);
    },
  };
}

/** Subconjunto de `ServiceWorkerRegistration` con Background Sync (no está en lib.dom). */
export interface RegistroConSync {
  sync?: { register(tag: string): Promise<void> };
}

/**
 * Pide al navegador un Background Sync (Chrome/Android). Devuelve `false` si no existe (iOS,
 * Firefox) o falla: los demás disparadores cubren esos casos.
 */
export async function registrarBackgroundSync(registro?: RegistroConSync | null): Promise<boolean> {
  try {
    const reg =
      registro === undefined
        ? ((await globalThis.navigator?.serviceWorker?.ready) as RegistroConSync | undefined)
        : registro;
    if (reg?.sync === undefined) {
      return false;
    }
    await reg.sync.register(TAG_BACKGROUND_SYNC);
    return true;
  } catch {
    return false;
  }
}

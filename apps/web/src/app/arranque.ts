// Arranque de la PWA (tarea 4.2): sincronización (una sola vez), registro del Service Worker,
// retención de datos de la tablet, restauración de la sesión, vigilancia de inactividad y
// Background Sync. Lo llama `main.tsx` antes de montar React.

import { sesion as sesionDeLaApp, vigilarInactividad } from '../auth';
import { aplicarRetencionDelDispositivo } from '../datos/retencion';
import {
  iniciarSincronizacion,
  registrarBackgroundSync,
  useEstadoSync,
  type EstadoSync,
  type Sincronizacion,
  type StoreEstadoSync,
} from '../sync';
import { useArranque, type StoreArranque } from './estado-arranque';

let sincronizacion: Sincronizacion | null = null;

/**
 * Motor de sync de la app. Se crea UNA vez por pestaña (las llamadas siguientes devuelven el mismo):
 * dos motores duplicarían los disparadores y los intervalos.
 */
export function obtenerSincronizacion(iniciar: () => Sincronizacion = iniciarSincronizacion) {
  sincronizacion ??= iniciar();
  return sincronizacion;
}

/** Solo pruebas: olvida el motor creado (lo detiene). */
export function reiniciarSincronizacionParaPruebas(): void {
  sincronizacion?.detener();
  sincronizacion = null;
}

function necesitaBackgroundSync(estado: EstadoSync): boolean {
  return estado.conexion === 'sin_conexion' && estado.pendientes + estado.fotosPendientes > 0;
}

/**
 * Pide un Background Sync (Chrome/Android) cada vez que la tablet pasa a "sin conexión con
 * pendientes": así la sync se dispara al volver la red aunque la pestaña esté en segundo plano.
 * Devuelve la función para dejar de vigilar.
 */
export function vigilarBackgroundSync(
  estado: StoreEstadoSync = useEstadoSync,
  registrar: () => Promise<boolean> = () => registrarBackgroundSync(),
): () => void {
  if (necesitaBackgroundSync(estado.getState())) {
    void registrar();
  }
  return estado.subscribe((actual, previo) => {
    if (necesitaBackgroundSync(actual) && !necesitaBackgroundSync(previo)) {
      void registrar();
    }
  });
}

export interface OpcionesArranque {
  sesion?: { restaurar(): Promise<unknown> };
  /** Retención de la tablet en todas las particiones (ADR 0017 §5). */
  aplicarRetencion?: () => Promise<unknown>;
  /** Bloqueo por inactividad (ADR 0017 §1). Devuelve la función para dejar de vigilar. */
  vigilarInactividad?: () => () => void;
  iniciar?: () => Sincronizacion;
  /** Registra el Service Worker (en producción, con `virtual:pwa-register`). */
  registrarServiceWorker?: () => void;
  estadoSync?: StoreEstadoSync;
  arranque?: StoreArranque;
  registrarBackgroundSync?: () => Promise<boolean>;
  alError?: (error: unknown) => void;
}

/**
 * 1. Inicia la sincronización antes de restaurar, para que su suscripción a la sesión vea el paso a
 *    `online` y programe la primera sync.
 * 2. Registra el SW.
 * 3. Aplica la retención de la tablet (purga en TODAS las particiones, perfiles caducados y
 *    verificadores de admin), antes de restaurar y de mostrar el login.
 * 4. Restaura la sesión del servidor (con la cookie). Sin red queda `sin_sesion` y el login ofrece
 *    entrar sin conexión. Si el último acceso es viejo, la sesión queda bloqueada. Pase lo que pase,
 *    marca el arranque como listo.
 * 5. Vigila la inactividad (bloqueo a los 10 min) y cuándo pedir Background Sync.
 */
export async function arrancar(opciones: OpcionesArranque = {}): Promise<Sincronizacion> {
  const alError = opciones.alError ?? ((error: unknown) => console.error(error));
  const arranque = opciones.arranque ?? useArranque;
  const sync = obtenerSincronizacion(opciones.iniciar);
  try {
    opciones.registrarServiceWorker?.();
  } catch (error) {
    alError(error);
  }
  try {
    await (opciones.aplicarRetencion ?? (() => aplicarRetencionDelDispositivo()))();
  } catch (error) {
    alError(error);
  }
  try {
    await (opciones.sesion ?? sesionDeLaApp).restaurar();
  } catch (error) {
    alError(error);
  } finally {
    arranque.setState({ listo: true });
  }
  try {
    (opciones.vigilarInactividad ?? (() => vigilarInactividad({ sesion: sesionDeLaApp })))();
  } catch (error) {
    alError(error);
  }
  vigilarBackgroundSync(opciones.estadoSync, opciones.registrarBackgroundSync);
  return sync;
}

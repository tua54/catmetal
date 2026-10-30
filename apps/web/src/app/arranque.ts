// Arranque de la PWA (tarea 4.2): sincronización (una sola vez), registro del Service Worker,
// retención de datos de la tablet (al arrancar, una vez al día y al cerrar sesión), vaciado de la
// caché de consultas al cambiar de usuario, restauración de la sesión, vigilancia de inactividad y
// Background Sync. Lo llama `main.tsx` antes de montar React.

import { sesion as sesionDeLaApp, vigilarInactividad } from '../auth';
import { aplicarRetencionDelDispositivo } from '../datos/retencion';
import { vaciarCacheAlCambiarDeUsuario } from '../lib/query-client';
import {
  iniciarSincronizacion,
  registrarBackgroundSync,
  useEstadoSync,
  type EstadoSync,
  type Sincronizacion,
  type StoreEstadoSync,
} from '../sync';
import { useArranque, type StoreArranque } from './estado-arranque';
import {
  crearRetencionPeriodica,
  type SesionObservada,
  type TemporizadoresPeriodicos,
} from './retencion-periodica';

let sincronizacion: Sincronizacion | null = null;
/** Vigilancias que crea `arrancar` (las pruebas las detienen al reiniciar). */
const vigilancias: (() => void)[] = [];

/**
 * Motor de sync de la app. Se crea UNA vez por pestaña (las llamadas siguientes devuelven el mismo):
 * dos motores duplicarían los disparadores y los intervalos.
 */
export function obtenerSincronizacion(iniciar: () => Sincronizacion = iniciarSincronizacion) {
  sincronizacion ??= iniciar();
  return sincronizacion;
}

/** Solo pruebas: olvida el motor creado (lo detiene) y detiene las vigilancias del arranque. */
export function reiniciarSincronizacionParaPruebas(): void {
  sincronizacion?.detener();
  sincronizacion = null;
  for (const detener of vigilancias.splice(0)) {
    detener();
  }
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
  /**
   * Sesión que se observa para vaciar la caché al cambiar de usuario y aplicar la retención al
   * cerrar sesión (por defecto, la de la app).
   */
  sesionObservada?: SesionObservada;
  /** Caché de TanStack Query: se vacía cada vez que cambia el usuario de la sesión (F6-04). */
  cacheConsultas?: { clear(): void };
  /**
   * Retención de la tablet en todas las particiones (ADR 0017 §5). Se aplica al arrancar, una vez
   * al día con la app abierta y al cerrar sesión (F6-07); `excluir` es el usuario de la sesión.
   */
  aplicarRetencion?: (opciones: { excluir: string | null }) => Promise<unknown>;
  /** Temporizador de la revisión diaria de la retención. */
  temporizadoresRetencion?: TemporizadoresPeriodicos;
  ahora?: () => number;
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
 * 3. Vacía la caché de consultas en cada cambio de usuario (F6-04) y aplica la retención de la
 *    tablet (purga en TODAS las particiones, perfiles caducados y verificadores de admin) antes de
 *    restaurar y de mostrar el login; después, una vez al día y al cerrar sesión (F6-07).
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
  const sesionObservada = opciones.sesionObservada ?? sesionDeLaApp;
  if (opciones.cacheConsultas !== undefined) {
    vigilancias.push(vaciarCacheAlCambiarDeUsuario(opciones.cacheConsultas, sesionObservada));
  }
  const retencion = crearRetencionPeriodica({
    aplicar: opciones.aplicarRetencion ?? ((filtro) => aplicarRetencionDelDispositivo(filtro)),
    sesion: sesionObservada,
    temporizadores: opciones.temporizadoresRetencion,
    ahora: opciones.ahora,
    alError,
  });
  vigilancias.push(() => retencion.detener());
  // Los errores de la retención van a `alError`: nunca impiden arrancar.
  await retencion.aplicarAhora();
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

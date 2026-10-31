// API pública del motor de sincronización (tarea 3.5). La app la arranca una vez (Fase 4, en
// `main.tsx`) con `iniciarSincronizacion()` y usa `useEstadoSync` + `textoIndicador` en la UI.

import { sesion as sesionDeLaApp, type EstadoSesion } from '../auth/sesion';
import { contarEvidenciasPendientes, contarPendientes } from '../datos/outbox';
import { solicitarPersistencia } from './almacenamiento';
import {
  iniciarDisparadores,
  registrarBackgroundSync,
  type Disparadores,
  type OpcionesDisparadores,
} from './disparadores';
import { actualizarContadores, useEstadoSync, type StoreEstadoSync } from './estado';
import { MotorSync, type SesionParaSync } from './motor';

export * from './almacenamiento';
export * from './disparadores';
export * from './estado';
export * from './motor';

export interface Sincronizacion extends Disparadores {
  motor: MotorSync;
}

export interface OpcionesSincronizacion {
  sesion?: SesionParaSync & { suscribir(oyente: (estado: EstadoSesion) => void): () => void };
  estado?: StoreEstadoSync;
  disparadores?: Pick<
    OpcionesDisparadores,
    'ventana' | 'documento' | 'serviceWorker' | 'intervaloMs' | 'esperaMs' | 'alError'
  >;
}

/**
 * Arranca la sincronización: motor, disparadores, persistencia del almacenamiento y reacción a los
 * cambios de sesión (al pasar a `online` se programa una sincronización).
 */
export function iniciarSincronizacion(opciones: OpcionesSincronizacion = {}): Sincronizacion {
  const gestor = opciones.sesion ?? sesionDeLaApp;
  const estado = opciones.estado ?? useEstadoSync;
  const motor = new MotorSync({ sesion: gestor, estado });
  const usuarioActual = (): string | null => gestor.usuarioDeLaSesion()?.id ?? null;
  const contar = (): Promise<void> => actualizarContadores(estado, usuarioActual());

  const disparadores = iniciarDisparadores({
    ...opciones.disparadores,
    motor,
    estado,
    actualizarContadores: contar,
    hayPendientes: async () => {
      const userId = usuarioActual();
      if (userId === null) {
        return false;
      }
      return (await contarPendientes(userId)) + (await contarEvidenciasPendientes(userId)) > 0;
    },
  });
  void solicitarPersistencia(estado);
  const desuscribir = gestor.suscribir((e) => {
    void contar();
    if (e.modo === 'online') {
      disparadores.programar('sesion');
    }
  });

  return {
    ...disparadores,
    motor,
    cambioLocal() {
      disparadores.cambioLocal();
      if (estado.getState().conexion === 'sin_conexion') {
        // Chrome/Android sincronizará al volver la red aunque la pestaña esté en segundo plano.
        void registrarBackgroundSync();
      }
    },
    detener() {
      desuscribir();
      disparadores.detener();
    },
  };
}

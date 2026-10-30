// Estado global de sincronización para la UI (docs/spec.md §6, puntos 7 y 8): indicador global y
// aviso de almacenamiento no persistente. Solo datos; la lógica está en el motor y los disparadores.

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { contarEvidenciasPendientes, contarPendientes, mutacionesAtascadas } from '../datos/outbox';
import { mutacionesConProblema } from '../datos/consultas';
import type { ErrorSync } from '../datos/tipos';

export type Conexion = 'en_linea' | 'sin_conexion';
export type Persistencia = 'desconocida' | 'concedida' | 'denegada' | 'no_disponible';

export interface EstadoSync {
  conexion: Conexion;
  sincronizando: boolean;
  /** Mutaciones del usuario de la sesión aún sin confirmar. */
  pendientes: number;
  /** Fotos con bytes locales aún sin subir. */
  fotosPendientes: number;
  /** Mutaciones rechazadas por el servidor (se conservan). */
  rechazados: number;
  conflictos: number;
  /**
   * Mutaciones en cola con 10 o más intentos fallidos por errores transitorios (B4): no se rechazan
   * solas; la UI las muestra como "atascadas" para que alguien revise.
   */
  atascadas: number;
  /** Fin de la última sincronización completa sin error (ISO). */
  ultimoSync: string | null;
  error: ErrorSync | null;
  persistencia: Persistencia;
}

export const AVISO_PERSISTENCIA = 'Sincroniza al menos una vez al día';

export function estadoSyncInicial(): EstadoSync {
  const enLinea = globalThis.navigator?.onLine ?? true;
  return {
    conexion: enLinea ? 'en_linea' : 'sin_conexion',
    sincronizando: false,
    pendientes: 0,
    fotosPendientes: 0,
    rechazados: 0,
    conflictos: 0,
    atascadas: 0,
    ultimoSync: null,
    error: null,
    persistencia: 'desconocida',
  };
}

export type StoreEstadoSync = UseBoundStore<StoreApi<EstadoSync>>;

export function crearStoreEstadoSync(): StoreEstadoSync {
  return create<EstadoSync>()(() => estadoSyncInicial());
}

/** Hook del estado de sync: `const texto = useEstadoSync(textoIndicador)`. */
export const useEstadoSync = crearStoreEstadoSync();

/**
 * Texto del indicador global (§6 punto 8). "Por sincronizar" cuenta mutaciones y fotos pendientes;
 * los rechazos y conflictos se muestran aparte porque no se resuelven reintentando.
 */
export function textoIndicador(estado: EstadoSync): string {
  if (estado.sincronizando) {
    return 'Sincronizando…';
  }
  const porSincronizar = estado.pendientes + estado.fotosPendientes;
  const prefijo = estado.conexion === 'en_linea' ? 'En línea' : 'Sin conexión';
  return porSincronizar === 0
    ? `${prefijo} · Todo sincronizado`
    : `${prefijo} · ${porSincronizar} por sincronizar`;
}

/** El aviso permanente "Sincroniza al menos una vez al día" aplica (§6 punto 7). */
export function requiereAvisoPersistencia(estado: EstadoSync): boolean {
  return estado.persistencia === 'denegada' || estado.persistencia === 'no_disponible';
}

/** Generación de la última actualización pedida por store (gana la más reciente, no la más lenta). */
const generaciones = new WeakMap<StoreEstadoSync, number>();

/**
 * Recalcula los contadores del usuario de la sesión (o los pone en cero sin sesión). Si mientras
 * tanto empezó otra actualización, esta se descarta: un conteo viejo nunca pisa uno nuevo.
 */
export async function actualizarContadores(
  store: StoreEstadoSync,
  userId: string | null,
): Promise<void> {
  const generacion = (generaciones.get(store) ?? 0) + 1;
  generaciones.set(store, generacion);
  if (userId === null) {
    store.setState({
      pendientes: 0,
      fotosPendientes: 0,
      rechazados: 0,
      conflictos: 0,
      atascadas: 0,
    });
    return;
  }
  const [pendientes, fotosPendientes, problemas, atascadas] = await Promise.all([
    contarPendientes(userId),
    contarEvidenciasPendientes(userId),
    mutacionesConProblema(userId),
    mutacionesAtascadas(userId),
  ]);
  if (generaciones.get(store) !== generacion) {
    return;
  }
  store.setState({
    pendientes,
    fotosPendientes,
    rechazados: problemas.filter((m) => m.estado === 'rechazada').length,
    conflictos: problemas.filter((m) => m.estado === 'conflicto').length,
    atascadas: atascadas.length,
  });
}

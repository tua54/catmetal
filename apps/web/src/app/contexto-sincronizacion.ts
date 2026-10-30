import { createContext, useContext } from 'react';
import type { ResumenSync } from '../sync';

/** Lo que la UI puede pedir al motor de sync (lo cumple `Sincronizacion` de src/sync). */
export interface ServiciosSincronizacion {
  /** Botón "Sincronizar ahora": inmediato. */
  sincronizarAhora: () => Promise<ResumenSync>;
  /** La app escribió en la cola local (registro, novedad…): actualiza contadores y programa sync. */
  cambioLocal: () => void;
}

export const ContextoSincronizacion = createContext<ServiciosSincronizacion | null>(null);

/** `const { sincronizarAhora, cambioLocal } = useSincronizacion()`. Requiere `<App sincronizacion>`. */
export function useSincronizacion(): ServiciosSincronizacion {
  const servicios = useContext(ContextoSincronizacion);
  if (servicios === null) {
    throw new Error('useSincronizacion debe usarse dentro de <App sincronizacion={…}>.');
  }
  return servicios;
}

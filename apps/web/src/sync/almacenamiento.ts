// Almacenamiento persistente (docs/spec.md §6 punto 7; ADR 0012 punto 5). Sin persistencia, Safari
// puede borrar IndexedDB tras 7 días sin uso: si no se concede, la UI muestra el aviso permanente
// "Sincroniza al menos una vez al día" (`requiereAvisoPersistencia`).

import type { Persistencia, StoreEstadoSync } from './estado';

export interface AlmacenamientoNavegador {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

export async function solicitarPersistencia(
  estado: StoreEstadoSync,
  storage: AlmacenamientoNavegador | undefined = globalThis.navigator?.storage,
): Promise<Persistencia> {
  let resultado: Persistencia;
  try {
    if (storage?.persist === undefined) {
      resultado = 'no_disponible';
    } else if ((await storage.persisted?.()) === true) {
      resultado = 'concedida';
    } else {
      resultado = (await storage.persist()) ? 'concedida' : 'denegada';
    }
  } catch {
    resultado = 'no_disponible';
  }
  estado.setState({ persistencia: resultado });
  return resultado;
}

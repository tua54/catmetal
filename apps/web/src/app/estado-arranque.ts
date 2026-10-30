// Estado del arranque de la app: mientras se intenta restaurar la sesión del servidor, las guardas
// muestran "Cargando…" en lugar de mandar al login a alguien que sí tiene sesión.

import { create, type StoreApi, type UseBoundStore } from 'zustand';

export interface EstadoArranque {
  /** `restaurar()` terminó (con o sin sesión). */
  listo: boolean;
}

export type StoreArranque = UseBoundStore<StoreApi<EstadoArranque>>;

export function crearStoreArranque(): StoreArranque {
  return create<EstadoArranque>()(() => ({ listo: false }));
}

export const useArranque = crearStoreArranque();

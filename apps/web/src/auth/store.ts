// Estado de sesión para React (Zustand). Solo refleja el `GestorSesion`: no tiene lógica propia ni
// el access token (que nunca sale del gestor).

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  sesion,
  type EstadoSesion,
  type GestorSesion,
  type PerfilDelDispositivo,
  type ResultadoCierre,
} from './sesion';

export interface StoreSesion extends EstadoSesion {
  iniciarSesion: (email: string, password: string) => Promise<EstadoSesion>;
  cerrarSesion: () => Promise<ResultadoCierre>;
  restaurar: () => Promise<{ estado: EstadoSesion; perfiles: PerfilDelDispositivo[] }>;
  /** "Confirme que es <nombre>" tras el bloqueo por inactividad (ADR 0017 §1). */
  confirmarIdentidad: (password: string) => Promise<EstadoSesion>;
}

export function crearStoreSesion(gestor: GestorSesion): UseBoundStore<StoreApi<StoreSesion>> {
  const store = create<StoreSesion>()(() => ({
    ...gestor.estado(),
    iniciarSesion: (email, password) => gestor.iniciarSesion(email, password),
    cerrarSesion: () => gestor.cerrarSesion(),
    restaurar: () => gestor.restaurar(),
    confirmarIdentidad: (password) => gestor.confirmarIdentidad(password),
  }));
  gestor.suscribir((estado) => store.setState({ ...estado }));
  return store;
}

/** Hook de la sesión de la PWA: `const { modo, usuario } = useSesion()`. */
export const useSesion = crearStoreSesion(sesion);

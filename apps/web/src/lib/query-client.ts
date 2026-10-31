import type { Perfil } from '@catmetal/shared';
import { QueryClient } from '@tanstack/react-query';

/**
 * Crea el cliente de TanStack Query de la aplicación.
 * Es una fábrica (no un singleton) para que cada prueba use un cliente aislado.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // App offline-first: las consultas se ejecutan aunque el navegador reporte estar sin red
        // (el caché local responde y el error de red se maneja en cada pantalla).
        networkMode: 'offlineFirst',
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** Subconjunto del `GestorSesion` que se observa (solo importa el id del usuario). */
export interface SesionConUsuario {
  usuarioDeLaSesion(): Pick<Perfil, 'id'> | null;
  suscribir(oyente: (estado: { usuario: Pick<Perfil, 'id'> | null }) => void): () => void;
}

/**
 * F6-04: vacía la caché de TanStack Query (consultas y mutaciones) cada vez que cambia el usuario
 * de la sesión, incluido el paso a `null` al cerrar sesión. En una tablet compartida, lo que el
 * servidor devolvió a un usuario (por ejemplo, la lista de usuarios del admin con sus correos) no
 * queda en memoria ni se muestra al siguiente que entra en la misma pestaña. `clear()` también
 * cancela las consultas en vuelo del usuario anterior.
 *
 * Devuelve la función para dejar de observar. Se llama una vez por pestaña, en el arranque.
 */
export function vaciarCacheAlCambiarDeUsuario(
  cliente: Pick<QueryClient, 'clear'>,
  sesion: SesionConUsuario,
): () => void {
  let usuarioPrevio = sesion.usuarioDeLaSesion()?.id ?? null;
  return sesion.suscribir((estado) => {
    const usuarioActual = estado.usuario?.id ?? null;
    if (usuarioActual !== usuarioPrevio) {
      usuarioPrevio = usuarioActual;
      cliente.clear();
    }
  });
}

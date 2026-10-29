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

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { RouterProvider, type DataRouter } from 'react-router';
import {
  ContextoSincronizacion,
  type ServiciosSincronizacion,
} from './app/contexto-sincronizacion';

export interface AppProps {
  /** Router de datos: `createBrowserRouter` en la app, `createMemoryRouter` en las pruebas. */
  router: DataRouter;
  queryClient: QueryClient;
  /** Motor de sync de la pestaña (`obtenerSincronizacion()`); en pruebas, uno simulado. */
  sincronizacion: ServiciosSincronizacion;
}

/**
 * Raíz de la aplicación: proveedores globales + router.
 *
 * Se usa el `RouterProvider` del punto de entrada `react-router` (no `react-router/dom`) y se le
 * pasa `flushSync`, que es exactamente lo que hace el de `react-router/dom`. Así todo el código
 * importa un solo punto de entrada y se evita que Vitest cargue dos copias del paquete
 * (CJS + ESM) con contextos de router distintos.
 */
export function App({ router, queryClient, sincronizacion }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ContextoSincronizacion.Provider value={sincronizacion}>
        <RouterProvider
          router={router}
          flushSync={(fn) => {
            flushSync(fn);
          }}
        />
      </ContextoSincronizacion.Provider>
    </QueryClientProvider>
  );
}

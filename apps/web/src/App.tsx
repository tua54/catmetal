import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { RouterProvider, type DataRouter } from 'react-router';

export interface AppProps {
  /** Router de datos: `createBrowserRouter` en la app, `createMemoryRouter` en las pruebas. */
  router: DataRouter;
  queryClient: QueryClient;
}

/**
 * Raíz de la aplicación: proveedores globales + router.
 *
 * Se usa el `RouterProvider` del punto de entrada `react-router` (no `react-router/dom`) y se le
 * pasa `flushSync`, que es exactamente lo que hace el de `react-router/dom`. Así todo el código
 * importa un solo punto de entrada y se evita que Vitest cargue dos copias del paquete
 * (CJS + ESM) con contextos de router distintos.
 */
export function App({ router, queryClient }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router}
        flushSync={(fn) => {
          flushSync(fn);
        }}
      />
    </QueryClientProvider>
  );
}

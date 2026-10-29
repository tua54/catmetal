import type { RouteObject } from 'react-router';
import { AppLayout, type HandleRuta } from './components/layout/AppLayout';
import { DisenoPage } from './pages/DisenoPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';

/**
 * Árbol de rutas (React Router 7, modo data).
 * Se comparte entre `createBrowserRouter` (main.tsx) y `createMemoryRouter` (pruebas).
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      {
        // Muestra del sistema visual (Tarea 4.1): solo datos de ejemplo, sin API.
        path: 'diseno',
        element: <DisenoPage />,
        handle: {
          titulo: 'Sistema visual',
          subtitulo: 'Componentes base · Catmetal',
        } satisfies HandleRuta,
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

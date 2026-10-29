import type { RouteObject } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
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
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { AppLayout, type HandleRuta } from '../components/layout/AppLayout';
import { NotFoundPage } from '../pages/NotFoundPage';
import { PantallaCarga } from '../pages/comunes/PantallaCarga';
import { RouteErrorPage } from '../pages/RouteErrorPage';
import { EstadoSincronizacionPage } from '../pages/comunes/EstadoSincronizacionPage';
import { LoginPage } from '../pages/comunes/LoginPage';
import { PantallaEnConstruccion } from '../pages/comunes/PantallaEnConstruccion';
import { InicioPorRol, RequiereArea, RequiereSesion } from './guardas';
import { RaizApp } from './RaizApp';

/** Carga diferida de la página `/diseno`. */
export type CargarDiseno = () => Promise<{ DisenoPage: ComponentType }>;

export interface OpcionesRutas {
  /**
   * Si se pasa, registra `/diseno` (muestra del sistema visual) con carga diferida. La app la pasa
   * solo si `import.meta.env.DEV`: en producción el `import()` desaparece del bundle (y del precache).
   */
  diseno: CargarDiseno | null;
}

/**
 * Árbol de rutas (React Router 7, modo data). Se comparte entre `createBrowserRouter` (main.tsx) y
 * `createMemoryRouter` (pruebas).
 *
 * - `/login`: pública.
 * - Con sesión (`online` u `offline`): `/` redirige por rol; `/supervisor`, `/jefe` y `/admin`
 *   exigen el permiso de su área; `/sincronizacion` es de todos.
 * - `/diseno`: solo en desarrollo, sin sesión (usa datos de ejemplo, nunca la API).
 */
export function crearRutas({ diseno }: OpcionesRutas): RouteObject[] {
  const rutasDev: RouteObject[] = diseno
    ? [
        {
          element: <AppLayout />,
          children: [
            {
              path: 'diseno',
              lazy: async () => ({ Component: (await diseno()).DisenoPage }),
              handle: {
                titulo: 'Sistema visual',
                subtitulo: 'Componentes base · Catmetal',
              } satisfies HandleRuta,
            },
          ],
        },
      ]
    : [];

  return [
    {
      path: '/',
      element: <RaizApp />,
      errorElement: <RouteErrorPage />,
      // Mientras se carga una ruta diferida en la primera navegación.
      hydrateFallbackElement: <PantallaCarga />,
      children: [
        { path: 'login', element: <LoginPage /> },
        ...rutasDev,
        {
          element: <RequiereSesion />,
          children: [
            {
              element: <AppLayout />,
              children: [
                { index: true, element: <InicioPorRol /> },
                {
                  path: 'supervisor',
                  element: <RequiereArea area="supervisor" />,
                  handle: {
                    titulo: 'Mis órdenes en proceso',
                    subtitulo: 'Supervisor · Registro de consumo',
                  } satisfies HandleRuta,
                  children: [
                    {
                      index: true,
                      element: (
                        <PantallaEnConstruccion
                          titulo="Mis órdenes en proceso"
                          descripcion="Aquí verá las órdenes asignadas en proceso y podrá registrar consumos."
                        />
                      ),
                    },
                  ],
                },
                {
                  path: 'jefe',
                  element: <RequiereArea area="jefe" />,
                  handle: {
                    titulo: 'Validación de consumos',
                    subtitulo: 'Panel del jefe · Rol: Aprobador',
                  } satisfies HandleRuta,
                  children: [
                    {
                      index: true,
                      element: (
                        <PantallaEnConstruccion
                          titulo="Validación de consumos"
                          descripcion="Aquí verá la cola de consumos por validar de cada orden."
                        />
                      ),
                    },
                  ],
                },
                {
                  path: 'admin',
                  element: <RequiereArea area="admin" />,
                  handle: {
                    titulo: 'Administración',
                    subtitulo: 'Usuarios, materiales, asignaciones y tolerancia',
                  } satisfies HandleRuta,
                  children: [
                    {
                      index: true,
                      element: (
                        <PantallaEnConstruccion
                          titulo="Administración"
                          descripcion="Aquí podrá gestionar usuarios, materiales, asignaciones y la tolerancia."
                        />
                      ),
                    },
                  ],
                },
                {
                  path: 'sincronizacion',
                  element: <EstadoSincronizacionPage />,
                  handle: {
                    titulo: 'Estado de sincronización',
                    subtitulo: 'Registros guardados en esta tablet',
                  } satisfies HandleRuta,
                },
                { path: '*', element: <NotFoundPage /> },
              ],
            },
          ],
        },
      ],
    },
  ];
}

import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { AppLayout, type HandleRuta } from '../components/layout/AppLayout';
import { NotFoundPage } from '../pages/NotFoundPage';
import { PantallaCarga } from '../pages/comunes/PantallaCarga';
import { RouteErrorPage } from '../pages/RouteErrorPage';
import { EstadoSincronizacionPage } from '../pages/comunes/EstadoSincronizacionPage';
import { LoginPage } from '../pages/comunes/LoginPage';
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
                  // Pantallas del supervisor en un fragmento aparte (carga diferida por rol): el
                  // jefe y el admin no descargan el formulario ni el compresor de fotos. Los
                  // fragmentos igual quedan en el precache del Service Worker (funcionan offline).
                  children: [
                    {
                      index: true,
                      lazy: async () => ({
                        Component: (await import('../pages/supervisor')).MisOrdenesPage,
                      }),
                    },
                    {
                      path: 'ordenes/:id',
                      handle: { titulo: 'Detalle de orden' } satisfies HandleRuta,
                      lazy: async () => ({
                        Component: (await import('../pages/supervisor')).DetalleOrdenPage,
                      }),
                    },
                    {
                      path: 'ordenes/:id/registrar',
                      handle: { titulo: 'Registro de Consumo' } satisfies HandleRuta,
                      lazy: async () => ({
                        Component: (await import('../pages/supervisor')).RegistroConsumoPage,
                      }),
                    },
                  ],
                },
                {
                  path: 'jefe',
                  element: <RequiereArea area="jefe" />,
                  handle: {
                    titulo: 'Validación de Consumos',
                    subtitulo: 'Panel del jefe · Rol: Aprobador',
                  } satisfies HandleRuta,
                  // Pantallas del jefe en su propio fragmento (carga diferida por rol), como las
                  // del supervisor: también quedan en el precache del Service Worker.
                  children: [
                    {
                      index: true,
                      lazy: async () => ({
                        Component: (await import('../pages/jefe')).ValidacionPage,
                      }),
                    },
                    {
                      path: 'ordenes',
                      handle: {
                        titulo: 'Órdenes de producción',
                        subtitulo: 'Panel del jefe · Gestión de órdenes',
                      } satisfies HandleRuta,
                      children: [
                        {
                          index: true,
                          lazy: async () => ({
                            Component: (await import('../pages/jefe')).OrdenesPage,
                          }),
                        },
                        {
                          path: 'nueva',
                          lazy: async () => ({
                            Component: (await import('../pages/jefe')).NuevaOrdenPage,
                          }),
                        },
                        {
                          path: ':id',
                          lazy: async () => ({
                            Component: (await import('../pages/jefe')).DetalleOrdenJefePage,
                          }),
                        },
                      ],
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
                  // Pantallas del admin en su propio fragmento (carga diferida por rol). Trabajan
                  // contra el servidor: sin conexión explican que la necesitan.
                  children: [
                    {
                      lazy: async () => ({
                        Component: (await import('../pages/admin')).AdminLayout,
                      }),
                      children: [
                        {
                          index: true,
                          handle: {
                            titulo: 'Administración',
                            subtitulo: 'Usuarios',
                          } satisfies HandleRuta,
                          lazy: async () => ({
                            Component: (await import('../pages/admin')).UsuariosPage,
                          }),
                        },
                        {
                          path: 'materiales',
                          handle: {
                            titulo: 'Administración',
                            subtitulo: 'Materiales',
                          } satisfies HandleRuta,
                          lazy: async () => ({
                            Component: (await import('../pages/admin')).MaterialesPage,
                          }),
                        },
                        {
                          path: 'asignaciones',
                          handle: {
                            titulo: 'Administración',
                            subtitulo: 'Asignación de supervisores',
                          } satisfies HandleRuta,
                          lazy: async () => ({
                            Component: (await import('../pages/admin')).AsignacionesPage,
                          }),
                        },
                        {
                          path: 'tolerancia',
                          handle: {
                            titulo: 'Administración',
                            subtitulo: 'Tolerancia',
                          } satisfies HandleRuta,
                          lazy: async () => ({
                            Component: (await import('../pages/admin')).ToleranciaPage,
                          }),
                        },
                      ],
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

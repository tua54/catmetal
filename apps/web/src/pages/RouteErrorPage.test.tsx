import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, data, Link, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tituloDocumento } from '../app/navegacion-accesible';
import { clasificarErrorRuta } from '../rutas/errores-ruta';
import { RouteErrorPage } from './RouteErrorPage';

function Rota(): never {
  throw new Error('TypeError: x is undefined');
}

function montar(rutaInicial: string, historial: string[] = []) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <main>
            <Outlet />
          </main>
        ),
        children: [
          {
            errorElement: <RouteErrorPage variante="seccion" />,
            children: [
              { index: true, element: <Link to="/rota">Abrir la rota</Link> },
              { path: 'rota', element: <Rota /> },
              {
                path: 'perdida',
                loader: () => {
                  // eslint-disable-next-line @typescript-eslint/only-throw-error -- así señala React Router un 404 de ruta
                  throw data(null, { status: 404 });
                },
                element: <p>nunca</p>,
              },
            ],
          },
        ],
      },
    ],
    { initialEntries: [...historial, rutaInicial] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  // React registra en consola los errores que atrapa el límite: aquí son esperados.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('clasificarErrorRuta', () => {
  it('distingue 404, fragmento no descargado (con y sin red) e inesperado', () => {
    const fragmento = new TypeError(
      'Failed to fetch dynamically imported module: https://x/assets/jefe.js',
    );
    expect(clasificarErrorRuta(fragmento, false)).toBe('sin_conexion');
    expect(clasificarErrorRuta(fragmento, true)).toBe('carga');
    expect(clasificarErrorRuta(new TypeError('Importing a module script failed.'), true)).toBe(
      'carga',
    );
    expect(clasificarErrorRuta(new Error('x is undefined'), true)).toBe('inesperado');
    expect(clasificarErrorRuta('cadena', true)).toBe('inesperado');
  });
});

describe('RouteErrorPage', () => {
  it('error inesperado: mensaje amable, sin detalles técnicos, foco en el h1 y "Volver"', async () => {
    const usuario = userEvent.setup();
    const router = montar('/');
    await usuario.click(screen.getByRole('link', { name: 'Abrir la rota' }));

    const titulo = await screen.findByRole('heading', { level: 1, name: 'Algo salió mal' });
    expect(titulo).toHaveFocus();
    expect(document.body).not.toHaveTextContent('x is undefined');
    expect(document.body).toHaveTextContent('Sus registros siguen guardados en esta tablet');
    expect(document.title).toBe(tituloDocumento('Algo salió mal'));
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Volver' }));
    expect(await screen.findByRole('link', { name: 'Abrir la rota' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('abierta directamente (sin pantalla anterior) ofrece "Ir al inicio"', async () => {
    const usuario = userEvent.setup();
    const router = montar('/rota');
    await screen.findByRole('heading', { level: 1, name: 'Algo salió mal' });
    expect(screen.queryByRole('button', { name: 'Volver' })).not.toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Ir al inicio' }));
    expect(await screen.findByRole('link', { name: 'Abrir la rota' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('404 de una ruta: "Página no encontrada" sin "Reintentar"', async () => {
    montar('/perdida', ['/']);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Página no encontrada' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver' })).toBeInTheDocument();
  });

  it('la variante de página trae su propio <main>', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <Rota />, errorElement: <RouteErrorPage /> }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { level: 1, name: 'Algo salió mal' });
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});

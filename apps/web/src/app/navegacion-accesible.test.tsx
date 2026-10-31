import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { createMemoryRouter, Link, Outlet, RouterProvider, useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TITULO_APP,
  tituloDocumento,
  useFocoAlNavegar,
  useTituloDocumento,
} from './navegacion-accesible';

function Layout() {
  const ref = useRef<HTMLElement>(null);
  useFocoAlNavegar(ref);
  return (
    <>
      <header>
        <Link to="/b">Ir a B desde la barra</Link>
      </header>
      <main ref={ref} tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

function PaginaA() {
  useTituloDocumento('Pantalla A');
  const navegar = useNavigate();
  return (
    <>
      <h1>Pantalla A</h1>
      <Link to="/b">Ir a B</Link>
      <Link to="/a?filtro=1">Filtrar</Link>
      <Link to="/con-campo">Ir al formulario</Link>
      <button type="button" onClick={() => void navegar('/carga')}>
        Abrir la que carga
      </button>
    </>
  );
}

function PaginaB() {
  useTituloDocumento('Pantalla B');
  return <h1>Pantalla B</h1>;
}

/** Enfoca su campo al montar (como el formulario de corrección): la navegación no se lo quita. */
function PaginaConCampo() {
  return (
    <>
      <h1>Con campo</h1>
      <input aria-label="Primer campo" autoFocus />
    </>
  );
}

/** Reemplaza su `<h1>` cuando "llegan los datos" (otro elemento): el foco no se pierde. */
function PaginaQueCarga() {
  const [lista, setLista] = useState(false);
  return lista ? (
    <section>
      <h1>Datos cargados</h1>
    </section>
  ) : (
    <div>
      <h1>Cargando pantalla</h1>
      <button type="button" onClick={() => setLista(true)} hidden>
        terminar
      </button>
    </div>
  );
}

function montar(inicial = '/a') {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: 'a', element: <PaginaA /> },
          { path: 'b', element: <PaginaB /> },
          { path: 'con-campo', element: <PaginaConCampo /> },
          { path: 'carga', element: <PaginaQueCarga /> },
        ],
      },
    ],
    { initialEntries: [inicial] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  document.title = '';
});

describe('título del documento', () => {
  it('compone "<pantalla> · Control de Materia Prima · Catmetal"', () => {
    expect(tituloDocumento('Usuarios')).toBe(`Usuarios · ${TITULO_APP}`);
    expect(tituloDocumento(null)).toBe(TITULO_APP);
  });

  it('cada pantalla pone su título al montarse', async () => {
    const usuario = userEvent.setup();
    montar();
    expect(document.title).toBe(tituloDocumento('Pantalla A'));
    await usuario.click(screen.getByRole('link', { name: 'Ir a B' }));
    await screen.findByRole('heading', { name: 'Pantalla B' });
    expect(document.title).toBe(tituloDocumento('Pantalla B'));
  });
});

describe('foco al cambiar de pantalla', () => {
  it('en la primera carga no mueve el foco', () => {
    montar();
    expect(screen.getByRole('heading', { name: 'Pantalla A' })).not.toHaveFocus();
  });

  it('al navegar lleva el foco al h1 de la pantalla nueva (también desde la barra)', async () => {
    const usuario = userEvent.setup();
    const router = montar();
    await usuario.click(screen.getByRole('link', { name: 'Ir a B' }));
    const titulo = await screen.findByRole('heading', { name: 'Pantalla B' });
    expect(titulo).toHaveFocus();
    expect(titulo).toHaveAttribute('tabindex', '-1');

    await act(() => router.navigate('/a'));
    // Desde un enlace de la barra (que sigue montado y tenía el foco).
    await usuario.click(screen.getByRole('link', { name: 'Ir a B desde la barra' }));
    expect(await screen.findByRole('heading', { name: 'Pantalla B' })).toHaveFocus();
  });

  it('si solo cambian los parámetros de la URL, el foco se queda donde estaba', async () => {
    const usuario = userEvent.setup();
    const router = montar();
    const filtrar = screen.getByRole('link', { name: 'Filtrar' });
    await usuario.click(filtrar);
    await waitFor(() => expect(router.state.location.search).toBe('?filtro=1'));
    expect(filtrar).toHaveFocus();
  });

  it('no le quita el foco a un campo que la pantalla nueva enfocó a propósito', async () => {
    const usuario = userEvent.setup();
    montar();
    await usuario.click(screen.getByRole('link', { name: 'Ir al formulario' }));
    expect(await screen.findByRole('textbox', { name: 'Primer campo' })).toHaveFocus();
  });

  it('si la pantalla reemplaza su h1 al cargar, el foco pasa al h1 nuevo', async () => {
    const usuario = userEvent.setup();
    montar();
    await usuario.click(screen.getByRole('button', { name: 'Abrir la que carga' }));
    expect(await screen.findByRole('heading', { name: 'Cargando pantalla' })).toHaveFocus();
    act(() => {
      screen.getByText('terminar').click();
    });
    expect(await screen.findByRole('heading', { name: 'Datos cargados' })).toHaveFocus();
  });
});

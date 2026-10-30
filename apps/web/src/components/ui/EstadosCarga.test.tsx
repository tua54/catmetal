import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { EnlaceBoton } from './EnlaceBoton';
import { ErrorCarga, TextoCargando } from './EstadosCarga';

describe('TextoCargando', () => {
  it('anuncia el texto con role="status" (no solo un ícono)', () => {
    render(<TextoCargando texto="Cargando órdenes…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Cargando órdenes…');
  });
});

describe('ErrorCarga', () => {
  it('se anuncia como alerta y "Reintentar" llama a la acción', async () => {
    const usuario = userEvent.setup();
    const alReintentar = vi.fn();
    render(
      <ErrorCarga titulo="No se pudieron leer las órdenes" alReintentar={alReintentar}>
        Sus registros no se han borrado.
      </ErrorCarga>,
    );
    const alerta = screen.getByRole('alert');
    expect(alerta).toHaveTextContent('Error: No se pudieron leer las órdenes');
    expect(alerta).toHaveTextContent('Sus registros no se han borrado.');
    await usuario.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(alReintentar).toHaveBeenCalledTimes(1);
  });

  it('sin acción de reintento no muestra el botón', () => {
    render(<ErrorCarga titulo="Falló" />);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });
});

describe('EnlaceBoton', () => {
  it('es un enlace (rol link) con el alto táctil de un botón', () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <EnlaceBoton to="/sincronizacion">Ir a sincronización</EnlaceBoton> }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    const enlace = screen.getByRole('link', { name: 'Ir a sincronización' });
    expect(enlace).toHaveAttribute('href', '/sincronizacion');
    expect(enlace).toHaveClass('min-h-11');
  });
});

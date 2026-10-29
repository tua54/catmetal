import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { createQueryClient } from './lib/query-client';
import { routes } from './routes';

function renderEn(ruta: string) {
  const router = createMemoryRouter(routes, { initialEntries: [ruta] });
  return render(<App router={router} queryClient={createQueryClient()} />);
}

describe('App (esqueleto)', () => {
  it('muestra la barra superior con el logo de Catmetal y el contenido principal', async () => {
    renderEn('/');

    const barra = await screen.findByRole('banner');
    expect(barra).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Catmetal' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Control de Materia Prima' }),
    ).toBeInTheDocument();
  });

  it('ofrece un enlace para saltar al contenido principal', async () => {
    renderEn('/');

    const salto = await screen.findByRole('link', { name: 'Saltar al contenido' });
    expect(salto).toHaveAttribute('href', '#contenido');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'contenido');
  });

  it('muestra la página 404 en una ruta desconocida, dentro del layout', async () => {
    renderEn('/ruta/que/no/existe');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Página no encontrada' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/');
  });
});

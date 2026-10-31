import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entrarSinConexion, reiniciarApp, renderizarApp } from './test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

describe('App', () => {
  it('sin sesión, la raíz lleva al login con el logo de Catmetal', async () => {
    const { router } = renderizarApp('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Control de Materia Prima' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Catmetal' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('con sesión muestra la barra superior, el salto al contenido y el contenido principal', async () => {
    await entrarSinConexion('supervisor');
    renderizarApp('/');

    expect(await screen.findByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Catmetal' })).toBeInTheDocument();
    const salto = screen.getByRole('link', { name: 'Saltar al contenido' });
    expect(salto).toHaveAttribute('href', '#contenido');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'contenido');
  });

  it('muestra la página 404 en una ruta desconocida, dentro del layout', async () => {
    await entrarSinConexion('supervisor');
    renderizarApp('/ruta/que/no/existe');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Página no encontrada' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/');
  });
});

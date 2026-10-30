import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useArranque } from '../app/estado-arranque';
import { DisenoPage } from '../pages/DisenoPage';
import { entrarSinConexion, reiniciarApp, renderizarApp } from '../test/app';
import { crearRutas } from './rutas';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

const h1 = (nombre: string) => screen.findByRole('heading', { level: 1, name: nombre });

describe('guardas de sesión', () => {
  it('sin sesión, una ruta protegida manda al login', async () => {
    const { router } = renderizarApp('/jefe');
    expect(await h1('Control de Materia Prima')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.state).toEqual({ desde: '/jefe' });
  });

  it('mientras se restaura la sesión muestra "Cargando…" y no redirige', async () => {
    useArranque.setState({ listo: false });
    const { router } = renderizarApp('/supervisor');
    expect(await screen.findByText('Cargando…')).toHaveAttribute('role', 'status');
    expect(router.state.location.pathname).toBe('/supervisor');
  });
});

describe('redirección inicial por rol', () => {
  it.each([
    ['supervisor', '/supervisor', 'Mis órdenes en proceso', 'Mis órdenes en proceso'],
    ['jefe', '/jefe', 'Validación de consumos', 'Validación de Consumos'],
    ['admin', '/admin', 'Administración', 'Administración'],
  ] as const)('%s → %s', async (rol, ruta, titulo, tituloBarra) => {
    await entrarSinConexion(rol);
    const { router } = renderizarApp('/');
    expect(await h1(titulo)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(ruta);
    // La barra superior toma el título del `handle` de la ruta.
    expect(screen.getByRole('banner')).toHaveTextContent(tituloBarra);
    // Las pantallas de jefe y admin ya existen (Fase 5): ningún marcador "en construcción".
    expect(
      screen.queryByRole('heading', { name: 'Pantalla en construcción' }),
    ).not.toBeInTheDocument();
  });

  it('admin con sesión sin conexión: explica que la pantalla necesita conexión', async () => {
    await entrarSinConexion('admin');
    renderizarApp('/admin');
    expect(
      await screen.findByRole('heading', { name: 'Esta pantalla necesita conexión' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Secciones de administración' })).toBeVisible();
  });
});

describe('guardas por permiso', () => {
  it.each(['/jefe', '/admin'])('el supervisor no entra a %s', async (ruta) => {
    await entrarSinConexion('supervisor');
    renderizarApp(ruta);
    expect(await h1('No tiene acceso a esta pantalla')).toBeInTheDocument();
    expect(
      screen.getByText('Su rol (Supervisor) no permite abrir esta sección.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a mi inicio' })).toHaveAttribute(
      'href',
      '/supervisor',
    );
  });

  it.each(['/supervisor', '/admin'])('el jefe no entra a %s', async (ruta) => {
    await entrarSinConexion('jefe');
    renderizarApp(ruta);
    expect(await h1('No tiene acceso a esta pantalla')).toBeInTheDocument();
  });

  it('la pantalla de sincronización es de todos los roles', async () => {
    await entrarSinConexion('admin');
    renderizarApp('/sincronizacion');
    expect(await h1('Estado de sincronización')).toBeInTheDocument();
  });
});

describe('/diseno', () => {
  it('existe en desarrollo (sin sesión)', async () => {
    renderizarApp('/diseno', {
      rutas: crearRutas({ diseno: () => Promise.resolve({ DisenoPage }) }),
    });
    expect(await h1('Sistema visual · Componentes base')).toBeInTheDocument();
  });

  it('no existe fuera de desarrollo: con sesión es un 404', async () => {
    await entrarSinConexion('supervisor');
    renderizarApp('/diseno', { rutas: crearRutas({ diseno: null }) });
    expect(await h1('Página no encontrada')).toBeInTheDocument();
  });

  it('no existe fuera de desarrollo: sin sesión lleva al login', async () => {
    const { router } = renderizarApp('/diseno', { rutas: crearRutas({ diseno: null }) });
    expect(await h1('Control de Materia Prima')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });
});

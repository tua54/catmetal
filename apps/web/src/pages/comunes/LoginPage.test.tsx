import { MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sesion } from '../../auth';
import { crearServidorFalso } from '../../auth/pruebas/servidor-falso';
import { db } from '../../datos/db';
import { registrarConsumoLocal } from '../../datos/outbox';
import {
  CLAVE,
  fijarConexion,
  guardarPerfilEnTablet,
  perfilDe,
  reiniciarApp,
  renderizarApp,
} from '../../test/app';
import { MENSAJE_SIN_LOGIN_PREVIO, mensajeErrorLogin } from './mensajes-login';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

async function escribirCredenciales(correo: string, clave: string) {
  const usuario = userEvent.setup();
  await usuario.type(await screen.findByLabelText(/^Correo/), correo);
  await usuario.type(screen.getByLabelText(/^Contraseña/), clave);
  await usuario.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
}

describe('LoginPage', () => {
  it('muestra el logo, el formulario accesible y valida los campos vacíos', async () => {
    const usuario = userEvent.setup();
    renderizarApp('/login');
    expect(await screen.findByRole('img', { name: 'Catmetal' })).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(screen.getByLabelText(/^Correo/)).toHaveAccessibleDescription('Escriba su correo.');
    expect(screen.getByLabelText(/^Contraseña/)).toHaveAccessibleDescription(
      'Escriba su contraseña.',
    );
    expect(screen.getByLabelText(/^Correo/)).toHaveFocus();
  });

  it('con conexión inicia sesión en el servidor y redirige por rol', async () => {
    const servidor = crearServidorFalso();
    servidor.agregarUsuario('Beto Ruiz', 'beto@catmetal.co', CLAVE, 'jefe');
    vi.stubGlobal('fetch', servidor.fetch);
    fijarConexion(true);
    const { router } = renderizarApp('/login');

    await escribirCredenciales('beto@catmetal.co', CLAVE);

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Validación de consumos' },
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/jefe');
    expect(sesion.estado().modo).toBe('online');
    expect(servidor.peticionesA('/api/v1/auth/login')).toHaveLength(1);
  });

  it('con conexión vuelve a la ruta pedida si el rol la permite', async () => {
    const servidor = crearServidorFalso();
    servidor.agregarUsuario('Ana Gómez', 'ana@catmetal.co', CLAVE, 'supervisor');
    vi.stubGlobal('fetch', servidor.fetch);
    fijarConexion(true);
    const { router } = renderizarApp('/sincronizacion');
    await screen.findByRole('heading', { level: 1, name: 'Control de Materia Prima' });

    await escribirCredenciales('ana@catmetal.co', CLAVE);

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Estado de sincronización' },
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sincronizacion');
  });

  it('credenciales inválidas en el servidor: mensaje genérico', async () => {
    const servidor = crearServidorFalso();
    vi.stubGlobal('fetch', servidor.fetch);
    fijarConexion(true);
    renderizarApp('/login');

    await escribirCredenciales('nadie@catmetal.co', 'otra-clave');

    expect(await screen.findByText(MENSAJES_ERROR.CREDENCIALES_INVALIDAS)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Contraseña/)).toHaveValue('');
    expect(screen.getByLabelText(/^Contraseña/)).toHaveFocus();
  });

  it('demasiados intentos: lo explica en español', async () => {
    const servidor = crearServidorFalso();
    servidor.forzarErrorLogin = 'DEMASIADOS_INTENTOS';
    vi.stubGlobal('fetch', servidor.fetch);
    fijarConexion(true);
    renderizarApp('/login');

    await escribirCredenciales('ana@catmetal.co', CLAVE);

    expect(await screen.findByText(MENSAJES_ERROR.DEMASIADOS_INTENTOS)).toBeInTheDocument();
  });

  it('sin conexión lo indica y entra con el verificador local de quien ya entró en la tablet', async () => {
    const perfil = perfilDe('supervisor');
    await guardarPerfilEnTablet(perfil);
    fijarConexion(false);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { router } = renderizarApp('/login');

    expect(
      await screen.findByText(/Solo pueden entrar quienes ya iniciaron sesión con conexión/),
    ).toBeInTheDocument();
    await escribirCredenciales(perfil.email, CLAVE);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mis órdenes en proceso' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/supervisor');
    expect(sesion.estado().modo).toBe('offline');
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText('Trabajando sin conexión')).toBeInTheDocument();
  });

  it('sin conexión y sin login previo en esta tablet: explica qué hacer', async () => {
    fijarConexion(false);
    renderizarApp('/login');

    await escribirCredenciales('nuevo@catmetal.co', CLAVE);

    expect(
      await screen.findByText(
        'No hay conexión. Para entrar sin conexión, primero inicie sesión con conexión en esta tablet.',
      ),
    ).toBeInTheDocument();
    expect(sesion.estado().modo).toBe('sin_sesion');
  });

  it('sin conexión con contraseña equivocada: mensaje genérico', async () => {
    const perfil = perfilDe('supervisor');
    await guardarPerfilEnTablet(perfil);
    fijarConexion(false);
    renderizarApp('/login');

    await escribirCredenciales(perfil.email, 'no-es-la-clave');

    expect(await screen.findByText(MENSAJES_ERROR.CREDENCIALES_INVALIDAS)).toBeInTheDocument();
  });

  it('tablet compartida: avisa los pendientes de otros usuarios y lista los perfiles', async () => {
    const usuario = userEvent.setup();
    const ana = perfilDe('supervisor', 'Ana Gómez');
    await guardarPerfilEnTablet(ana);
    for (let i = 0; i < 2; i += 1) {
      await registrarConsumoLocal(ana.id, {
        order_id: uuidv7(),
        material_id: uuidv7(),
        cantidad: 1,
        unidad: 'kg',
        lote: `L-${i}`,
      });
    }
    renderizarApp('/login');

    expect(await screen.findByText('Hay 2 registros pendientes de Ana Gómez')).toBeInTheDocument();

    const perfiles = screen.getByRole('region', { name: 'Usuarios de esta tablet' });
    await usuario.click(within(perfiles).getByRole('button', { name: /Ana Gómez/ }));
    expect(screen.getByLabelText(/^Correo/)).toHaveValue(ana.email);
    expect(screen.getByLabelText(/^Contraseña/)).toHaveFocus();
    expect(within(perfiles).getByText(/Puede entrar sin conexión/)).toBeInTheDocument();
  });

  it('con sesión activa, /login redirige al inicio del rol', async () => {
    const perfil = perfilDe('admin');
    await guardarPerfilEnTablet(perfil);
    fijarConexion(false);
    await sesion.iniciarSesion(perfil.email, CLAVE);
    const { router } = renderizarApp('/login');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Administración' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin');
    expect(await db.perfiles.count()).toBe(1);
  });
});

describe('mensajeErrorLogin', () => {
  it('traduce errores locales, del servidor y desconocidos', async () => {
    const { ErrorApi, ErrorSesion } = await import('../../auth');
    expect(mensajeErrorLogin(new ErrorSesion('SIN_LOGIN_PREVIO'))).toBe(MENSAJE_SIN_LOGIN_PREVIO);
    expect(mensajeErrorLogin(new ErrorSesion('VALIDACION'))).toMatch(/correo válido/);
    expect(mensajeErrorLogin(new ErrorApi('ORIGEN_INVALIDO', 403, 'texto del servidor'))).toBe(
      MENSAJES_ERROR.ORIGEN_INVALIDO,
    );
    expect(mensajeErrorLogin(new ErrorApi('VALIDACION', 400))).toMatch(/correo válido/);
    expect(mensajeErrorLogin(new ErrorApi('ERROR_INTERNO', 500))).toMatch(/No se pudo/);
    expect(mensajeErrorLogin(new Error('x'))).toMatch(/No se pudo/);
  });
});

import { uuidv7 } from '@catmetal/shared';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sesion } from '../../auth';
import { crearServidorFalso } from '../../auth/pruebas/servidor-falso';
import { db } from '../../datos/db';
import { registrarConsumoLocal } from '../../datos/outbox';
import { useEstadoPwa } from '../../pwa/registro';
import { useEstadoSync } from '../../sync';
import {
  entrarSinConexion,
  fijarConexion,
  guardarPerfilEnTablet,
  perfilDe,
  reiniciarApp,
  renderizarApp,
} from '../../test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

function consumo(lote = 'L-1') {
  return { order_id: uuidv7(), material_id: uuidv7(), cantidad: 2.5, unidad: 'kg' as const, lote };
}

async function abrirSupervisor() {
  await screen.findByRole('heading', { level: 1, name: 'Mis órdenes en proceso' });
}

describe('píldora de conexión', () => {
  it('muestra los tres estados del indicador global y lleva a /sincronizacion', async () => {
    const usuario = userEvent.setup();
    await entrarSinConexion('supervisor');
    act(() => useEstadoSync.setState({ conexion: 'en_linea', pendientes: 0, fotosPendientes: 0 }));
    const { router } = renderizarApp('/supervisor');
    await abrirSupervisor();
    const barra = screen.getByRole('banner');

    expect(
      within(barra).getByRole('button', { name: /^En línea, Todo sincronizado/ }),
    ).toBeInTheDocument();

    act(() =>
      useEstadoSync.setState({ conexion: 'sin_conexion', pendientes: 2, fotosPendientes: 1 }),
    );
    expect(
      within(barra).getByRole('button', { name: /^Sin conexión, 3 por sincronizar/ }),
    ).toBeInTheDocument();

    act(() => useEstadoSync.setState({ conexion: 'en_linea', sincronizando: true }));
    const pildora = within(barra).getByRole('button', { name: /^Sincronizando…/ });

    await usuario.click(pildora);
    expect(router.state.location.pathname).toBe('/sincronizacion');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Estado de sincronización' }),
    ).toBeInTheDocument();
  });
});

describe('menú de la cuenta', () => {
  it('muestra nombre, rol, el enlace al estado de sincronización y se cierra con Escape', async () => {
    const usuario = userEvent.setup();
    await entrarSinConexion('supervisor', 'Ana Gómez');
    renderizarApp('/supervisor');
    await abrirSupervisor();

    const boton = screen.getByRole('button', { name: 'Cuenta de Ana Gómez, Supervisor' });
    expect(boton).toHaveAttribute('aria-expanded', 'false');
    await usuario.click(boton);
    expect(boton).toHaveAttribute('aria-expanded', 'true');
    const menu = document.getElementById(boton.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(menu).getByText('Ana Gómez')).toBeVisible();
    expect(within(menu).getByText('Supervisor')).toBeVisible();
    expect(within(menu).getByRole('link', { name: 'Estado de sincronización' })).toHaveAttribute(
      'href',
      '/sincronizacion',
    );

    await usuario.keyboard('{Escape}');
    expect(boton).toHaveAttribute('aria-expanded', 'false');
    expect(boton).toHaveFocus();
  });

  it('cerrar sesión sin pendientes: confirma, borra los datos y vuelve al login', async () => {
    const usuario = userEvent.setup();
    const perfil = await entrarSinConexion('supervisor', 'Ana Gómez');
    const { router } = renderizarApp('/supervisor');
    await abrirSupervisor();

    await usuario.click(screen.getByRole('button', { name: /^Cuenta de Ana Gómez/ }));
    await usuario.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    const dialogo = await screen.findByRole('alertdialog', { name: '¿Cerrar sesión?' });
    expect(dialogo).toHaveTextContent('Todo está sincronizado');

    await usuario.click(within(dialogo).getByRole('button', { name: 'Cerrar sesión' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Control de Materia Prima' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(sesion.estado().modo).toBe('sin_sesion');
    expect(await screen.findByText('Sesión cerrada')).toBeInTheDocument();
    // El perfil (y su verificador) se conserva para poder volver a entrar sin conexión.
    expect(await db.perfiles.get(perfil.id)).toBeDefined();
  });

  it('cerrar sesión con pendientes: advierte que se conservan y no los borra', async () => {
    const usuario = userEvent.setup();
    const perfil = await entrarSinConexion('supervisor', 'Ana Gómez');
    await registrarConsumoLocal(perfil.id, consumo());
    renderizarApp('/supervisor');
    await abrirSupervisor();

    await usuario.click(screen.getByRole('button', { name: /^Cuenta de Ana Gómez/ }));
    await usuario.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    const dialogo = await screen.findByRole('alertdialog', { name: '¿Cerrar sesión?' });
    expect(dialogo).toHaveTextContent('Tiene 1 registro sin sincronizar.');
    expect(dialogo).toHaveTextContent('No se borran: se conservan en esta tablet');

    await usuario.click(within(dialogo).getByRole('button', { name: 'Cerrar sesión' }));

    expect(await screen.findByText('Hay 1 registro pendiente de Ana Gómez')).toBeInTheDocument();
    expect(await db.outbox.where('user_id').equals(perfil.id).count()).toBe(1);
    expect(
      await db.consumos
        .where('[user_id+estado_local]')
        .equals([perfil.id, 'pendiente_sync'])
        .count(),
    ).toBe(1);
    expect(screen.getByText(/siguen guardados en esta tablet/)).toBeInTheDocument();
  });

  it('cancelar no cierra la sesión', async () => {
    const usuario = userEvent.setup();
    await entrarSinConexion('jefe', 'Beto Ruiz');
    renderizarApp('/jefe');
    await screen.findByRole('heading', { level: 1, name: 'Validación de consumos' });

    await usuario.click(
      screen.getByRole('button', { name: 'Cuenta de Beto Ruiz, Jefe de producción' }),
    );
    await usuario.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    const dialogo = await screen.findByRole('alertdialog');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(sesion.estado().modo).toBe('offline');
  });
});

describe('avisos permanentes', () => {
  it('sin persistencia del almacenamiento: "Sincroniza al menos una vez al día"', async () => {
    await entrarSinConexion('supervisor');
    act(() => useEstadoSync.setState({ persistencia: 'denegada' }));
    renderizarApp('/supervisor');
    await abrirSupervisor();
    expect(screen.getByText('Sincroniza al menos una vez al día')).toBeInTheDocument();
  });

  it('sesión sin conexión: los registros se guardan en la tablet', async () => {
    await entrarSinConexion('supervisor');
    renderizarApp('/supervisor');
    await abrirSupervisor();
    expect(screen.getByText('Trabajando sin conexión')).toBeInTheDocument();
    expect(screen.queryByText('Sincroniza al menos una vez al día')).not.toBeInTheDocument();
  });

  it('tablet compartida: B ve los pendientes de A', async () => {
    const ana = perfilDe('supervisor', 'Ana Gómez');
    await guardarPerfilEnTablet(ana);
    await registrarConsumoLocal(ana.id, consumo('L-1'));
    await registrarConsumoLocal(ana.id, consumo('L-2'));
    await entrarSinConexion('jefe', 'Beto Ruiz');
    renderizarApp('/jefe');

    expect(await screen.findByText('Hay 2 registros pendientes de Ana Gómez')).toBeInTheDocument();
    expect(screen.getByText(/No se envían con su sesión/)).toBeInTheDocument();
  });

  it('sesión del servidor perdida: pide la contraseña para sincronizar', async () => {
    const usuario = userEvent.setup();
    await entrarSinConexion('supervisor');
    act(() => sesion.marcarRequiereContrasena());
    fijarConexion(true);
    const servidor = crearServidorFalso();
    servidor.modo = 'caido';
    vi.stubGlobal('fetch', servidor.fetch);
    renderizarApp('/supervisor');
    await abrirSupervisor();

    expect(screen.getByText('Sus registros no se pueden enviar todavía')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Escribir contraseña' }));
    const dialogo = screen.getByRole('dialog', { name: 'Escriba de nuevo su contraseña' });
    const campo = within(dialogo).getByLabelText(/^Contraseña/);
    expect(campo).toHaveFocus();

    await usuario.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
    expect(campo).toHaveAccessibleDescription('Escriba su contraseña.');

    // El servidor no responde: entra con el verificador local, pero sin sesión del servidor.
    await usuario.type(campo, 'clave-de-prueba');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
    expect(await within(dialogo).findByText(/No hay conexión con el servidor/)).toBeInTheDocument();
  });

  it('sin red y sin sesión del servidor, no ofrece escribir la contraseña todavía', async () => {
    await entrarSinConexion('supervisor');
    act(() => sesion.marcarRequiereContrasena());
    renderizarApp('/supervisor');
    await abrirSupervisor();
    expect(
      screen.getByText(/Cuando vuelva la conexión, escriba de nuevo su contraseña/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Escribir contraseña' })).not.toBeInTheDocument();
  });
});

describe('actualización de la PWA', () => {
  it('avisa la versión nueva y "Actualizar" la activa', async () => {
    const usuario = userEvent.setup();
    const actualizar = vi.fn(() => new Promise<void>(() => undefined));
    await entrarSinConexion('supervisor');
    renderizarApp('/supervisor');
    await abrirSupervisor();
    expect(screen.queryByText('Hay una versión nueva')).not.toBeInTheDocument();

    act(() => useEstadoPwa.setState({ actualizacionDisponible: true, actualizar }));
    expect(screen.getByText('Hay una versión nueva')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(actualizar).toHaveBeenCalledTimes(1);
  });

  it('avisa una vez cuando la app queda lista sin conexión', async () => {
    await entrarSinConexion('supervisor');
    renderizarApp('/supervisor');
    await abrirSupervisor();
    act(() => useEstadoPwa.setState({ listaSinConexion: true }));
    expect(await screen.findByText('Lista para trabajar sin conexión')).toBeInTheDocument();
    expect(useEstadoPwa.getState().listaSinConexion).toBe(false);
  });
});

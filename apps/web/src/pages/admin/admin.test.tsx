// Pantallas del admin montadas con el router real y la sesión real de la PWA (login con conexión
// contra el servidor falso de auth). La red de administración se simula con el contrato del Worker
// (`crearServidorAdmin`): mismos esquemas de @catmetal/shared, mismos códigos de error.

import type { Usuario } from '@catmetal/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sesion } from '../../auth';
import { crearServidorFalso } from '../../auth/pruebas/servidor-falso';
import {
  TEXTO_CODIGO_UNIDAD_FIJOS,
  TEXTO_COSTO_HISTORICO,
} from '../../features/admin/DialogosMaterial';
import {
  MENSAJE_CONFLICTO_USUARIO,
  MENSAJE_CORREO_DUPLICADO,
  MENSAJE_CODIGO_DUPLICADO,
  MENSAJE_ULTIMO_ADMIN,
  TITULO_SIN_CONEXION,
} from '../../features/admin/errores';
import { MENSAJE_COSTO } from '../../features/admin/formato';
import {
  crearServidorAdmin,
  type ServidorAdmin,
} from '../../features/admin/pruebas/servidor-admin';
import {
  CLAVE,
  entrarSinConexion,
  fijarConexion,
  reiniciarApp,
  renderizarApp,
} from '../../test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

let servidor: ServidorAdmin;
let admin: Usuario;

/** Login CON conexión del admin "Carla Díaz" (sesión `online`, con access token). */
async function entrarComoAdmin(): Promise<void> {
  const auth = crearServidorFalso();
  const perfil = auth.agregarUsuario('Carla Díaz', 'carla@catmetal.co', CLAVE, 'admin');
  servidor = crearServidorAdmin(auth);
  admin = servidor.agregarUsuario({
    id: perfil.id,
    nombre: 'Carla Díaz',
    email: 'carla@catmetal.co',
    rol: 'admin',
  });
  vi.stubGlobal('fetch', servidor.fetch);
  fijarConexion(true);
  await sesion.iniciarSesion('carla@catmetal.co', CLAVE);
}

async function listaDe(nombre: string): Promise<HTMLElement> {
  return screen.findByRole('list', { name: nombre });
}

function dialogo(nombre: string | RegExp): HTMLElement {
  return screen.getByRole('dialog', { name: nombre });
}

function confirmacion(nombre: string | RegExp): HTMLElement {
  return screen.getByRole('alertdialog', { name: nombre });
}

describe('Administración · navegación y conexión', () => {
  it('muestra el encabezado y las secciones como enlaces, con la actual marcada', async () => {
    await entrarComoAdmin();
    const usuario = userEvent.setup();
    const { router } = renderizarApp('/admin');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Administración' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Secciones de administración' });
    expect(within(nav).getByRole('link', { name: 'Usuarios' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await usuario.click(within(nav).getByRole('link', { name: 'Tolerancia' }));
    expect(
      await screen.findByRole('heading', { name: 'Tolerancia sobre lo planeado' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/admin/tolerancia');
    expect(within(nav).getByRole('link', { name: 'Tolerancia' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('sin red explica que la pantalla necesita conexión y no pide nada al servidor', async () => {
    await entrarComoAdmin();
    fijarConexion(false);
    renderizarApp('/admin/materiales');

    expect(await screen.findByRole('heading', { name: TITULO_SIN_CONEXION })).toBeInTheDocument();
    expect(screen.getByText('Sin conexión con el servidor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear material' })).toBeDisabled();
    expect(servidor.peticiones).toHaveLength(0);
  });

  it('con sesión iniciada sin conexión también lo explica (sin fallar)', async () => {
    await entrarSinConexion('admin');
    renderizarApp('/admin');
    expect(await screen.findByRole('heading', { name: TITULO_SIN_CONEXION })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Administración' })).toBeInTheDocument();
  });

  it('si el servidor no responde, muestra "necesita conexión" con Reintentar', async () => {
    await entrarComoAdmin();
    servidor.modo = 'caido';
    const usuario = userEvent.setup();
    renderizarApp('/admin/tolerancia');

    expect(await screen.findByRole('heading', { name: TITULO_SIN_CONEXION })).toBeInTheDocument();
    servidor.modo = 'normal';
    await usuario.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('5 %')).toBeInTheDocument();
  });
});

describe('Administración · usuarios', () => {
  it('lista con rol y estado, y pagina por cursor con "Cargar más usuarios"', async () => {
    await entrarComoAdmin();
    for (let i = 1; i <= 54; i += 1) {
      servidor.agregarUsuario({
        nombre: `Supervisor ${String(i).padStart(2, '0')}`,
        rol: 'supervisor',
        activo: i !== 3,
      });
    }
    const usuario = userEvent.setup();
    renderizarApp('/admin');

    const lista = await listaDe('Usuarios');
    expect(within(lista).getAllByRole('listitem')).toHaveLength(50);
    const propia = within(lista).getByText('Carla Díaz').closest('li') as HTMLElement;
    expect(within(propia).getByText('(usted)')).toBeInTheDocument();
    expect(within(propia).getByText('Administrador')).toBeInTheDocument();
    expect(within(propia).getByText('Activo')).toBeInTheDocument();
    const inactivo = within(lista).getByText('Supervisor 03').closest('li') as HTMLElement;
    expect(within(inactivo).getByText('Inactivo')).toBeInTheDocument();
    expect(
      within(inactivo).getByRole('button', { name: 'Reactivar a Supervisor 03' }),
    ).toBeVisible();
    // Nunca se borra un usuario.
    expect(screen.queryByRole('button', { name: /eliminar|borrar/i })).not.toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Cargar más usuarios' }));
    await waitFor(() => expect(within(lista).getAllByRole('listitem')).toHaveLength(55));
    expect(screen.queryByRole('button', { name: 'Cargar más usuarios' })).not.toBeInTheDocument();
    const paginas = servidor.peticionesA('GET', '/users');
    expect(paginas).toHaveLength(2);
    expect(paginas[0]?.query.get('cursor')).toBeNull();
    expect(paginas[1]?.query.get('cursor')).toBe([...servidor.usuarios.keys()].sort()[49]);
  });

  it('crear: valida los campos, la contraseña corta y el correo duplicado', async () => {
    await entrarComoAdmin();
    servidor.agregarUsuario({ nombre: 'Ana Gómez', email: 'ana@catmetal.co', rol: 'supervisor' });
    const usuario = userEvent.setup();
    renderizarApp('/admin');
    await listaDe('Usuarios');

    await usuario.click(screen.getByRole('button', { name: 'Crear usuario' }));
    const crear = dialogo('Crear usuario');
    await usuario.click(within(crear).getByRole('button', { name: 'Crear usuario' }));
    expect(within(crear).getByLabelText(/^Nombre completo/)).toHaveAccessibleDescription(
      'El nombre es obligatorio.',
    );
    expect(within(crear).getByLabelText(/^Rol/)).toHaveAccessibleDescription('Elija el rol.');

    await usuario.type(within(crear).getByLabelText(/^Nombre completo/), 'Luis Pérez');
    await usuario.type(within(crear).getByLabelText(/^Correo/), ' ANA@catmetal.co ');
    await usuario.selectOptions(within(crear).getByLabelText(/^Rol/), 'Supervisor');
    const clave = within(crear).getByLabelText(/^Contraseña/);
    await usuario.type(clave, 'corta1');
    expect(within(crear).getByText('Muy corta: faltan 4 caracteres.')).toBeInTheDocument();
    await usuario.click(within(crear).getByRole('button', { name: 'Crear usuario' }));
    expect(clave).toHaveAccessibleDescription(
      expect.stringContaining('La contraseña debe tener al menos 10 caracteres.'),
    );
    expect(servidor.peticionesA('POST', '/users')).toHaveLength(0);

    await usuario.type(clave, '23456');
    expect(within(crear).getByText(/Longitud aceptable/)).toBeInTheDocument();
    await usuario.click(within(crear).getByRole('button', { name: 'Crear usuario' }));
    // 409 CONFLICTO por correo: se marca en el campo.
    expect(await within(crear).findByText(MENSAJE_CORREO_DUPLICADO)).toBeInTheDocument();
    expect(within(crear).getByLabelText(/^Correo/)).toHaveFocus();
    expect(servidor.peticionesA('POST', '/users')[0]?.cuerpo).toEqual({
      nombre: 'Luis Pérez',
      email: 'ana@catmetal.co',
      rol: 'supervisor',
      password: 'corta123456',
    });

    const correo = within(crear).getByLabelText(/^Correo/);
    await usuario.clear(correo);
    await usuario.type(correo, 'luis@catmetal.co');
    await usuario.click(within(crear).getByRole('button', { name: 'Crear usuario' }));
    expect(await screen.findByText('Usuario creado')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Crear usuario' })).not.toBeInTheDocument();
    const lista = await listaDe('Usuarios');
    expect(await within(lista).findByText('Luis Pérez')).toBeInTheDocument();
  });

  it('desactivar pide confirmación, avisa que cierra sus sesiones y se puede cancelar', async () => {
    await entrarComoAdmin();
    const ana = servidor.agregarUsuario({ nombre: 'Ana Gómez', rol: 'supervisor' });
    const usuario = userEvent.setup();
    renderizarApp('/admin');
    await listaDe('Usuarios');

    await usuario.click(screen.getByRole('button', { name: 'Desactivar a Ana Gómez' }));
    const dialogoDesactivar = confirmacion('¿Desactivar a Ana Gómez?');
    expect(dialogoDesactivar).toHaveTextContent(/se cerrarán todas sus sesiones abiertas/);
    await usuario.click(within(dialogoDesactivar).getByRole('button', { name: 'Cancelar' }));
    expect(servidor.peticionesA('PATCH', `/users/${ana.id}`)).toHaveLength(0);

    await usuario.click(screen.getByRole('button', { name: 'Desactivar a Ana Gómez' }));
    await usuario.click(
      within(confirmacion('¿Desactivar a Ana Gómez?')).getByRole('button', {
        name: 'Desactivar usuario',
      }),
    );
    expect(await screen.findByText('Usuario desactivado')).toBeInTheDocument();
    expect(servidor.peticionesA('PATCH', `/users/${ana.id}`)[0]?.cuerpo).toEqual({ activo: false });
    expect(await screen.findByRole('button', { name: 'Reactivar a Ana Gómez' })).toBeVisible();
  });

  it('último admin: el servidor lo impide y la pantalla lo explica', async () => {
    await entrarComoAdmin();
    const usuario = userEvent.setup();
    renderizarApp('/admin');
    await listaDe('Usuarios');

    await usuario.click(screen.getByRole('button', { name: 'Desactivar a Carla Díaz' }));
    const dialogoPropio = confirmacion('¿Desactivar a Carla Díaz?');
    expect(dialogoPropio).toHaveTextContent(/Es su propia cuenta/);
    await usuario.click(within(dialogoPropio).getByRole('button', { name: 'Desactivar usuario' }));
    expect(await screen.findByText(MENSAJE_ULTIMO_ADMIN)).toBeInTheDocument();
    expect(servidor.usuarios.get(admin.id)?.activo).toBe(true);

    // Cambiar su rol también: el error se muestra dentro del diálogo de edición.
    await usuario.click(screen.getByRole('button', { name: 'Editar a Carla Díaz' }));
    const editar = dialogo('Editar a Carla Díaz');
    await usuario.selectOptions(within(editar).getByLabelText(/^Rol/), 'Supervisor');
    expect(within(editar).getByText('Se cerrarán sus sesiones')).toBeInTheDocument();
    await usuario.click(within(editar).getByRole('button', { name: 'Guardar cambios' }));
    expect(await within(editar).findByText(MENSAJE_ULTIMO_ADMIN)).toBeInTheDocument();
    expect(servidor.usuarios.get(admin.id)?.rol).toBe('admin');
  });

  it('desbloquear: muestra "Bloqueado hasta" y lo quita tras confirmar', async () => {
    await entrarComoAdmin();
    const beto = servidor.agregarUsuario({
      nombre: 'Beto Ruiz',
      rol: 'jefe',
      intentos_fallidos: 5,
      bloqueado_hasta: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const usuario = userEvent.setup();
    renderizarApp('/admin');
    const lista = await listaDe('Usuarios');
    const fila = within(lista).getByText('Beto Ruiz').closest('li') as HTMLElement;
    expect(within(fila).getByText(/^Bloqueado hasta /)).toBeInTheDocument();

    await usuario.click(within(fila).getByRole('button', { name: 'Desbloquear a Beto Ruiz' }));
    await usuario.click(
      within(confirmacion('¿Desbloquear a Beto Ruiz?')).getByRole('button', {
        name: 'Desbloquear usuario',
      }),
    );
    expect(await screen.findByText('Usuario desbloqueado')).toBeInTheDocument();
    expect(servidor.peticionesA('PATCH', `/users/${beto.id}`)[0]?.cuerpo).toEqual({
      desbloquear: true,
    });
    await waitFor(() =>
      expect(within(lista).queryByText(/^Bloqueado hasta /)).not.toBeInTheDocument(),
    );
  });

  it('editar envía solo lo cambiado; restablecer contraseña avisa del cierre de sesiones', async () => {
    await entrarComoAdmin();
    const ana = servidor.agregarUsuario({ nombre: 'Ana Gómez', rol: 'supervisor' });
    const usuario = userEvent.setup();
    renderizarApp('/admin');
    await listaDe('Usuarios');

    await usuario.click(screen.getByRole('button', { name: 'Editar a Ana Gómez' }));
    let editar = dialogo('Editar a Ana Gómez');
    await usuario.click(within(editar).getByRole('button', { name: 'Guardar cambios' }));
    expect(within(editar).getByText('No hay cambios para guardar.')).toBeInTheDocument();
    await usuario.selectOptions(within(editar).getByLabelText(/^Rol/), 'Jefe de producción');
    await usuario.click(within(editar).getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Cambios guardados')).toBeInTheDocument();
    expect(servidor.peticionesA('PATCH', `/users/${ana.id}`)[0]?.cuerpo).toEqual({ rol: 'jefe' });

    await usuario.click(
      screen.getByRole('button', { name: 'Restablecer la contraseña de Ana Gómez' }),
    );
    editar = dialogo('Restablecer la contraseña de Ana Gómez');
    expect(editar).toHaveTextContent(/Se cerrarán todas las sesiones abiertas de Ana Gómez/);
    await usuario.type(within(editar).getByLabelText(/^Nueva contraseña/), 'una-clave-nueva-larga');
    expect(within(editar).getByText('Longitud robusta.')).toBeInTheDocument();
    await usuario.click(within(editar).getByRole('button', { name: 'Restablecer contraseña' }));
    expect(await screen.findByText('Contraseña restablecida')).toBeInTheDocument();
    expect(servidor.peticionesA('PATCH', `/users/${ana.id}`)[1]?.cuerpo).toEqual({
      password: 'una-clave-nueva-larga',
    });
  });

  it('409 CONFLICTO: recarga la lista y explica que otro admin cambió el usuario', async () => {
    await entrarComoAdmin();
    servidor.agregarUsuario({ nombre: 'Ana Gómez', rol: 'supervisor' });
    const usuario = userEvent.setup();
    renderizarApp('/admin');
    await listaDe('Usuarios');
    const lecturas = servidor.peticionesA('GET', '/users').length;

    servidor.forzarError = 'CONFLICTO';
    await usuario.click(screen.getByRole('button', { name: 'Editar a Ana Gómez' }));
    const editar = dialogo('Editar a Ana Gómez');
    await usuario.clear(within(editar).getByLabelText(/^Nombre completo/));
    await usuario.type(within(editar).getByLabelText(/^Nombre completo/), 'Ana María Gómez');
    await usuario.click(within(editar).getByRole('button', { name: 'Guardar cambios' }));

    expect(await screen.findByText(MENSAJE_CONFLICTO_USUARIO)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Editar a Ana Gómez' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(servidor.peticionesA('GET', '/users').length).toBeGreaterThan(lecturas),
    );
  });
});

describe('Administración · materiales', () => {
  async function abrirMateriales(usuario: UserEvent) {
    renderizarApp('/admin/materiales');
    await listaDe('Materiales');
    return usuario;
  }

  it('crear con vista previa del costo en COP; el código repetido se marca', async () => {
    await entrarComoAdmin();
    servidor.agregarMaterial({ codigo: 'MP-001', nombre: 'Arena sílice', unidad: 'kg' });
    const usuario = await abrirMateriales(userEvent.setup());

    await usuario.click(screen.getByRole('button', { name: 'Crear material' }));
    const crear = dialogo('Crear material');
    expect(crear).toHaveTextContent(TEXTO_CODIGO_UNIDAD_FIJOS);
    await usuario.type(within(crear).getByLabelText(/^Código/), 'MP-001');
    await usuario.type(within(crear).getByLabelText(/^Nombre/), 'Resina furánica');
    await usuario.selectOptions(within(crear).getByLabelText(/^Unidad/), 'l (litros)');
    const costo = within(crear).getByLabelText(/^Costo unitario/);
    await usuario.type(costo, '4,5');
    await usuario.click(within(crear).getByRole('button', { name: 'Crear material' }));
    expect(costo).toHaveAccessibleDescription(expect.stringContaining(MENSAJE_COSTO));

    await usuario.clear(costo);
    await usuario.type(costo, '4.182');
    expect(costo).toHaveAccessibleDescription('Vista previa: $ 4.182');
    await usuario.click(within(crear).getByRole('button', { name: 'Crear material' }));
    expect(await within(crear).findByText(MENSAJE_CODIGO_DUPLICADO)).toBeInTheDocument();
    expect(servidor.peticionesA('POST', '/materials')[0]?.cuerpo).toEqual({
      codigo: 'MP-001',
      nombre: 'Resina furánica',
      unidad: 'l',
      costo_unitario_cop: 4182,
    });

    const codigo = within(crear).getByLabelText(/^Código/);
    await usuario.clear(codigo);
    await usuario.type(codigo, 'MP-002');
    await usuario.click(within(crear).getByRole('button', { name: 'Crear material' }));
    expect(await screen.findByText('Material creado')).toBeInTheDocument();
    const lista = await listaDe('Materiales');
    expect(await within(lista).findByText(/Resina furánica/)).toBeInTheDocument();
    expect(within(lista).getByText(/\$ 4\.182 por l/)).toBeInTheDocument();
  });

  it('editar costo avisa que los consumos registrados no cambian; código y unidad no se editan', async () => {
    await entrarComoAdmin();
    const arena = servidor.agregarMaterial({
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      costo_unitario_cop: 1000,
    });
    const usuario = await abrirMateriales(userEvent.setup());

    await usuario.click(screen.getByRole('button', { name: 'Editar el material MP-001' }));
    const editar = dialogo('Editar el material MP-001');
    // Código y unidad se muestran como texto, sin campos para editarlos.
    expect(within(editar).queryByLabelText(/^Código/)).not.toBeInTheDocument();
    expect(within(editar).queryByLabelText(/^Unidad/)).not.toBeInTheDocument();
    expect(within(editar).getByText('kg (kilogramos)')).toBeInTheDocument();
    expect(editar).toHaveTextContent(TEXTO_CODIGO_UNIDAD_FIJOS);
    expect(editar).toHaveTextContent(TEXTO_COSTO_HISTORICO);

    const costo = within(editar).getByLabelText(/^Costo unitario/);
    await usuario.clear(costo);
    await usuario.type(costo, '1.500');
    expect(within(editar).getByText('El costo pasa de $ 1.000 a $ 1.500.')).toBeInTheDocument();
    await usuario.click(within(editar).getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Material actualizado')).toBeInTheDocument();
    expect(servidor.peticionesA('PATCH', `/materials/${arena.id}`)[0]?.cuerpo).toEqual({
      costo_unitario_cop: 1500,
    });
  });

  it('filtra activos/inactivos y desactiva con confirmación', async () => {
    await entrarComoAdmin();
    const arena = servidor.agregarMaterial({
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
    });
    servidor.agregarMaterial({
      codigo: 'MP-007',
      nombre: 'Bentonita sódica',
      unidad: 'kg',
      activo: false,
    });
    const usuario = await abrirMateriales(userEvent.setup());

    await usuario.selectOptions(screen.getByLabelText('Mostrar'), 'Solo inactivos');
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Materiales' })).getAllByRole('listitem'),
      ).toHaveLength(1),
    );
    expect(screen.getByText(/Bentonita sódica/)).toBeInTheDocument();
    expect(servidor.peticionesA('GET', '/materials').at(-1)?.query.get('activo')).toBe('false');

    await usuario.selectOptions(screen.getByLabelText('Mostrar'), 'Solo activos');
    await usuario.click(
      await screen.findByRole('button', { name: 'Desactivar el material MP-001' }),
    );
    const dialogoDesactivar = confirmacion(/Desactivar el material MP-001/);
    expect(dialogoDesactivar).toHaveTextContent(/el servidor los rechazará al recibirlos/);
    await usuario.click(
      within(dialogoDesactivar).getByRole('button', { name: 'Desactivar material' }),
    );
    expect(await screen.findByText('Material desactivado')).toBeInTheDocument();
    expect(servidor.peticionesA('PATCH', `/materials/${arena.id}`)[0]?.cuerpo).toEqual({
      activo: false,
    });
  });
});

describe('Administración · asignaciones', () => {
  it('reemplaza la lista de supervisores tras confirmar a quién se quita', async () => {
    await entrarComoAdmin();
    const ana = servidor.agregarUsuario({ nombre: 'Ana Gómez', rol: 'supervisor' });
    const beto = servidor.agregarUsuario({ nombre: 'Beto Ruiz', rol: 'supervisor' });
    servidor.agregarUsuario({ nombre: 'Dora Jefe', rol: 'jefe' });
    servidor.agregarUsuario({ nombre: 'Eva Inactiva', rol: 'supervisor', activo: false });
    const orden = servidor.agregarOrden({ codigo: 'OP-2026-0587' });
    servidor.agregarOrden({ codigo: 'OP-2026-0001', estado: 'finalizada' });
    servidor.asignar(orden.id, ana.id);
    const usuario = userEvent.setup();
    renderizarApp('/admin/asignaciones');

    const selector = await screen.findByLabelText('Orden de producción');
    // Solo órdenes planeadas y en proceso.
    expect(within(selector).queryByText(/OP-2026-0001/)).not.toBeInTheDocument();
    await usuario.selectOptions(selector, orden.id);

    const grupo = await screen.findByRole('group', {
      name: 'Supervisores de la orden OP-2026-0587',
    });
    // Solo supervisores activos.
    expect(within(grupo).getAllByRole('checkbox')).toHaveLength(2);
    const casillaAna = within(grupo).getByRole('checkbox', { name: /Ana Gómez/ });
    const casillaBeto = within(grupo).getByRole('checkbox', { name: /Beto Ruiz/ });
    expect(casillaAna).toBeChecked();
    expect(casillaBeto).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Guardar asignaciones' }),
    ).toHaveAccessibleDescription('No hay cambios para guardar.');

    await usuario.click(casillaAna);
    await usuario.click(casillaBeto);
    // Sin el motivo, el botón se vuelve a montar (deja de ir envuelto): se busca de nuevo.
    await usuario.click(screen.getByRole('button', { name: 'Guardar asignaciones' }));
    const dialogoGuardar = confirmacion('¿Guardar las asignaciones de la orden OP-2026-0587?');
    expect(dialogoGuardar).toHaveTextContent('Se asigna a: Beto Ruiz.');
    expect(dialogoGuardar).toHaveTextContent(
      'Se quita a: Ana Gómez. Dejará de ver esta orden en su tablet cuando sincronice.',
    );
    await usuario.click(
      within(dialogoGuardar).getByRole('button', { name: 'Guardar asignaciones' }),
    );

    expect(await screen.findByText('Asignaciones guardadas')).toBeInTheDocument();
    expect(servidor.peticionesA('PUT', `/orders/${orden.id}/supervisors`)[0]?.cuerpo).toEqual({
      supervisores: [beto.id],
    });
    const asignados = screen.getByRole('region', {
      name: 'Asignados ahora en la orden OP-2026-0587',
    });
    await waitFor(() => expect(within(asignados).getByText('Beto Ruiz')).toBeInTheDocument());
    expect(within(asignados).queryByText('Ana Gómez')).not.toBeInTheDocument();
  });
});

describe('Administración · tolerancia', () => {
  it('valida el rango, confirma y envía el nuevo valor', async () => {
    await entrarComoAdmin();
    const usuario = userEvent.setup();
    renderizarApp('/admin/tolerancia');

    expect(await screen.findByText('5 %')).toBeInTheDocument();
    expect(screen.getByText(/el supervisor debe registrar una novedad/)).toBeInTheDocument();
    const campo = screen.getByLabelText(/^Nueva tolerancia/);
    const cambiar = screen.getByRole('button', { name: 'Cambiar tolerancia' });

    await usuario.type(campo, '150');
    await usuario.click(cambiar);
    expect(campo).toHaveAccessibleDescription(
      expect.stringContaining('La tolerancia no puede superar 100 %.'),
    );
    await usuario.clear(campo);
    await usuario.type(campo, 'abc');
    await usuario.click(cambiar);
    expect(campo).toHaveAccessibleDescription(expect.stringContaining('entre 0 y 100'));
    await usuario.clear(campo);
    await usuario.type(campo, '5');
    await usuario.click(cambiar);
    expect(campo).toHaveAccessibleDescription(expect.stringContaining('La tolerancia ya es 5 %.'));
    expect(servidor.peticionesA('PATCH', '/settings/tolerancia')).toHaveLength(0);

    await usuario.clear(campo);
    await usuario.type(campo, '7,5');
    await usuario.click(cambiar);
    const dialogoCambio = confirmacion('¿Cambiar la tolerancia de 5 % a 7,5 %?');
    await usuario.click(within(dialogoCambio).getByRole('button', { name: 'Cambiar tolerancia' }));

    expect(await screen.findByText('Tolerancia actualizada')).toBeInTheDocument();
    expect(servidor.peticionesA('PATCH', '/settings/tolerancia')[0]?.cuerpo).toEqual({
      tolerancia_pct: 7.5,
    });
    expect(await screen.findByText('7,5 %')).toBeInTheDocument();
  });
});

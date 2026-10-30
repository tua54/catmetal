import { MENSAJES_ERROR, uuidv7, type Perfil } from '@catmetal/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../datos/db';
import { registrarConsumoLocal } from '../../datos/outbox';
import { actualizarContadores, useEstadoSync } from '../../sync';
import {
  entrarSinConexion,
  fijarConexion,
  reiniciarApp,
  renderizarApp,
  sincronizacionFalsa,
} from '../../test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

const ARENA = uuidv7();

async function registrar(perfil: Perfil, lote: string) {
  return registrarConsumoLocal(perfil.id, {
    order_id: uuidv7(),
    material_id: ARENA,
    cantidad: 12.5,
    unidad: 'kg',
    lote,
  });
}

/** Un pendiente, un rechazado por el servidor, uno rechazado por el jefe y un conflicto. */
async function prepararDatos(perfil: Perfil) {
  await db.materiales.put({
    user_id: perfil.id,
    id: ARENA,
    codigo: 'MP-001',
    nombre: 'Arena sílice',
    unidad: 'kg',
    costo_unitario_cop: 1000,
    activo: true,
  });
  await registrar(perfil, 'L-PEND');

  const rechazado = await registrar(perfil, 'L-RECH');
  await db.outbox.update(rechazado.mutation_id, {
    estado: 'rechazada',
    error: { code: 'ORDEN_NO_EN_PROCESO', message: 'texto del servidor' },
  });
  await db.consumos.update([perfil.id, rechazado.id], {
    estado_local: 'rechazado_sync',
    error_sync: { code: 'ORDEN_NO_EN_PROCESO', message: 'texto del servidor' },
  });

  const delJefe = await registrar(perfil, 'L-JEFE');
  await db.outbox.update(delJefe.mutation_id, { estado: 'aplicada' });
  await db.consumos.update([perfil.id, delJefe.id], {
    estado_local: 'rechazado',
    motivo_rechazo: 'No coincide con la báscula',
  });

  const conflicto = await registrar(perfil, 'L-CONF');
  await db.outbox.update(conflicto.mutation_id, {
    estado: 'conflicto',
    error: { code: 'CONFLICTO', message: 'texto del servidor' },
  });
  await db.consumos.update([perfil.id, conflicto.id], { estado_local: 'conflicto' });

  await actualizarContadores(useEstadoSync, perfil.id);
}

describe('Estado de sincronización', () => {
  it('lista pendientes, rechazados con su motivo y conflictos', async () => {
    const perfil = await entrarSinConexion('supervisor');
    await prepararDatos(perfil);
    renderizarApp('/sincronizacion');

    const pendientes = await screen.findByRole('region', { name: 'Pendientes de enviar' });
    expect(within(pendientes).getByText('Arena sílice')).toBeInTheDocument();
    expect(within(pendientes).getByText('Lote L-PEND')).toBeInTheDocument();
    expect(within(pendientes).getByText('Pendiente de sync')).toBeInTheDocument();

    const rechazados = screen.getByRole('list', { name: 'Rechazados' });
    const items = within(rechazados).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Registro de consumo');
    expect(items[0]).toHaveTextContent('Lote L-RECH');
    expect(items[0]).toHaveTextContent(`Motivo: ${MENSAJES_ERROR.ORDEN_NO_EN_PROCESO}`);
    expect(items[0]).toHaveTextContent('Código: ORDEN_NO_EN_PROCESO');
    expect(items[1]).toHaveTextContent('Rechazado por el jefe');
    expect(items[1]).toHaveTextContent('Motivo: No coincide con la báscula');

    const conflictos = screen.getByRole('list', { name: 'Conflictos' });
    expect(conflictos).toHaveTextContent('Lote L-CONF');
    expect(conflictos).toHaveTextContent(MENSAJES_ERROR.CONFLICTO);

    const resumen = screen.getByRole('region', { name: 'Resumen' });
    expect(resumen).toHaveTextContent('Sin conexión · 1 por sincronizar');
    expect(resumen).toHaveTextContent(/Rechazados\s*1/);
    expect(resumen).toHaveTextContent(/Conflictos\s*1/);
    expect(resumen).toHaveTextContent(/Última sincronización\s*Todavía no/);
  });

  it('sin registros muestra los estados vacíos', async () => {
    await entrarSinConexion('jefe');
    renderizarApp('/sincronizacion');
    expect(await screen.findByText('No hay registros pendientes')).toBeInTheDocument();
    expect(screen.getByText('No hay registros rechazados')).toBeInTheDocument();
    expect(screen.getByText('No hay conflictos')).toBeInTheDocument();
  });

  it('"Sincronizar ahora" está deshabilitado sin conexión y explica por qué', async () => {
    const usuario = userEvent.setup();
    const sincronizacion = sincronizacionFalsa();
    await entrarSinConexion('supervisor');
    renderizarApp('/sincronizacion', { sincronizacion });

    const boton = await screen.findByRole('button', { name: 'Sincronizar ahora' });
    expect(boton).toHaveAttribute('aria-disabled', 'true');
    expect(boton).toHaveAccessibleDescription(
      'Sin conexión: se sincronizará solo cuando vuelva la señal.',
    );
    await usuario.click(boton);
    expect(sincronizacion.sincronizarAhora).not.toHaveBeenCalled();
  });

  it('con conexión sincroniza y avisa el resultado', async () => {
    const usuario = userEvent.setup();
    const sincronizacion = sincronizacionFalsa({ aplicadas: 2 });
    await entrarSinConexion('supervisor');
    fijarConexion(true);
    act(() => useEstadoSync.setState({ ultimoSync: '2026-10-29T15:24:00.000Z' }));
    renderizarApp('/sincronizacion', { sincronizacion });

    const resumen = await screen.findByRole('region', { name: 'Resumen' });
    expect(resumen).toHaveTextContent('En línea · Todo sincronizado');
    expect(resumen).toHaveTextContent('10:24 a. m.');

    await usuario.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    expect(sincronizacion.sincronizarAhora).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Sincronización completa')).toBeInTheDocument();
  });

  it('informa cuando la sincronización no se pudo hacer o falló', async () => {
    const usuario = userEvent.setup();
    await entrarSinConexion('supervisor');
    fijarConexion(true);
    const omitida = sincronizacionFalsa({ ejecutada: false, omitida: 'requiere_contrasena' });
    const { unmount } = renderizarApp('/sincronizacion', { sincronizacion: omitida });
    await usuario.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    expect(await screen.findByText('No se sincronizó')).toBeInTheDocument();
    expect(screen.getByText(/Escriba de nuevo su contraseña/)).toBeInTheDocument();
    unmount();

    const fallida = sincronizacionFalsa({
      error: { code: 'ERROR_INTERNO', message: 'x' },
    });
    renderizarApp('/sincronizacion', { sincronizacion: fallida });
    await usuario.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    expect(await screen.findByText('La sincronización no terminó')).toBeInTheDocument();
  });

  it('mientras sincroniza, el botón queda ocupado; el error actual se muestra con su código', async () => {
    await entrarSinConexion('supervisor');
    fijarConexion(true);
    act(() =>
      useEstadoSync.setState({
        sincronizando: true,
        error: { code: 'SESION_REVOCADA', message: 'x' },
      }),
    );
    renderizarApp('/sincronizacion');
    const boton = await screen.findByRole('button', { name: /Sincronizar ahora/ });
    expect(boton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('La última sincronización falló')).toBeInTheDocument();
    expect(screen.getByText(MENSAJES_ERROR.SESION_REVOCADA)).toBeInTheDocument();
    expect(screen.getByText('Código: SESION_REVOCADA')).toBeInTheDocument();
  });
});

describe('Registros que el servidor perdió y envíos atascados', () => {
  it('lista los consumos perdidos y "Enviar de nuevo" los vuelve a encolar', async () => {
    const usuario = userEvent.setup();
    const sincronizacion = sincronizacionFalsa();
    const perfil = await entrarSinConexion('supervisor');
    await db.materiales.put({
      user_id: perfil.id,
      id: ARENA,
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      costo_unitario_cop: 1000,
      activo: true,
    });
    const perdido = await registrar(perfil, 'L-PERD');
    await db.outbox.update(perdido.mutation_id, { estado: 'aplicada' });
    await db.consumos.update([perfil.id, perdido.id], {
      estado_local: 'sincronizado',
      perdido_en_restauracion: true,
    });
    renderizarApp('/sincronizacion', { sincronizacion });

    const seccion = await screen.findByRole('region', { name: 'Registros que el servidor perdió' });
    expect(seccion).toHaveTextContent('Arena sílice');
    expect(seccion).toHaveTextContent('Lote L-PERD');
    await usuario.click(
      within(seccion).getByRole('button', { name: 'Enviar de nuevo: Arena sílice, lote L-PERD' }),
    );

    expect(await screen.findByText('Registro puesto en cola para enviar')).toBeInTheDocument();
    expect(sincronizacion.cambioLocal).toHaveBeenCalledTimes(1);
    const enCola = await db.outbox.where('estado').equals('pendiente').toArray();
    expect(enCola).toHaveLength(1);
    expect(enCola[0]).toMatchObject({
      tipo: 'consumo.crear',
      entidad_id: perdido.id,
      payload: { id: perdido.id, lote: 'L-PERD' },
    });
    expect(enCola[0]?.mutation_id).not.toBe(perdido.mutation_id);
    expect((await db.consumos.get([perfil.id, perdido.id]))?.perdido_en_restauracion).toBe(false);
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Registros que el servidor perdió' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('sin perdidos no muestra la sección', async () => {
    await entrarSinConexion('supervisor');
    renderizarApp('/sincronizacion');
    await screen.findByText('No hay registros pendientes');
    expect(
      screen.queryByRole('region', { name: 'Registros que el servidor perdió' }),
    ).not.toBeInTheDocument();
  });

  it('avisa los registros atascados con tipo, hora y último error', async () => {
    const perfil = await entrarSinConexion('supervisor');
    const atascado = await registrar(perfil, 'L-ATAS');
    await db.outbox.update(atascado.mutation_id, {
      intentos: 12,
      error: { code: 'ERROR_INTERNO', message: 'x' },
    });
    await actualizarContadores(useEstadoSync, perfil.id);
    renderizarApp('/sincronizacion');

    const aviso = await screen.findByText(
      '1 registro no se ha podido enviar después de varios intentos. Avise a soporte.',
    );
    expect(aviso.closest('[role="alert"]')).not.toBeNull();
    const lista = await screen.findByRole('list', {
      name: 'Registros que no se han podido enviar',
    });
    expect(lista).toHaveTextContent('Registro de consumo');
    expect(lista).toHaveTextContent(
      `Último error: ${MENSAJES_ERROR.ERROR_INTERNO} (ERROR_INTERNO)`,
    );
    expect(lista).toHaveTextContent('12 intentos');
  });

  it('sin atascados no hay aviso', async () => {
    const perfil = await entrarSinConexion('supervisor');
    await registrar(perfil, 'L-OK');
    await actualizarContadores(useEstadoSync, perfil.id);
    renderizarApp('/sincronizacion');
    await screen.findByRole('region', { name: 'Pendientes de enviar' });
    expect(screen.queryByText(/Avise a soporte/)).not.toBeInTheDocument();
  });
});

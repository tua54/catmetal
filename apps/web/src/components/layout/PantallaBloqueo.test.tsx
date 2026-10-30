import { MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MENSAJE_ESPERA_INTENTOS, sesion } from '../../auth';
import { db } from '../../datos/db';
import { registrarConsumoLocal } from '../../datos/outbox';
import { CLAVE, entrarSinConexion, reiniciarApp, renderizarApp } from '../../test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

async function abrirBloqueada() {
  const perfil = await entrarSinConexion('supervisor', 'Ana Gómez');
  const app = renderizarApp('/supervisor');
  const titulo = await screen.findByRole('heading', { level: 1, name: 'Mis órdenes en proceso' });
  act(() => sesion.bloquear());
  const dialogo = await screen.findByRole('dialog', { name: 'Confirme que es Ana Gómez' });
  return { ...app, perfil, titulo, dialogo };
}

describe('pantalla de bloqueo por inactividad (F4-01, ADR 0017 §1)', () => {
  it('tapa la app (inerte, con su estado) y pide la contraseña con el foco en el campo', async () => {
    const { titulo, dialogo } = await abrirBloqueada();
    expect(dialogo).toHaveAccessibleDescription(
      'La tablet estuvo un rato sin uso. Para seguir, escriba su contraseña.',
    );
    expect(within(dialogo).getByLabelText(/^Contraseña/)).toHaveFocus();
    // La pantalla de fondo sigue montada (no se pierde lo que estaba escrito) pero no se puede usar.
    expect(titulo).toBeInTheDocument();
    expect(titulo.closest('[inert]')).not.toBeNull();
    expect(within(dialogo).getByRole('button', { name: 'No soy Ana Gómez' })).toBeInTheDocument();
  });

  it('Escape no desbloquea', async () => {
    const usuario = userEvent.setup();
    await abrirBloqueada();
    await usuario.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Confirme que es Ana Gómez' })).toBeInTheDocument();
    expect(sesion.estado().bloqueada).toBe(true);
  });

  it('contraseña vacía o equivocada: lo explica sin desbloquear; la correcta desbloquea', async () => {
    const usuario = userEvent.setup();
    const { dialogo, titulo, perfil } = await abrirBloqueada();
    const campo = within(dialogo).getByLabelText(/^Contraseña/);

    await usuario.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
    expect(await within(dialogo).findByText('Escriba su contraseña.')).toBeInTheDocument();

    await usuario.type(campo, 'no-es-la-clave');
    await usuario.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
    expect(
      await within(dialogo).findByText(MENSAJES_ERROR.CREDENCIALES_INVALIDAS),
    ).toBeInTheDocument();
    expect(campo).toHaveValue('');
    expect((await db.perfiles.get(perfil.id))!.intentos_offline).toBe(1);

    await usuario.type(campo, CLAVE);
    await usuario.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Confirme que es/ })).not.toBeInTheDocument(),
    );
    expect(sesion.estado()).toMatchObject({ modo: 'offline', bloqueada: false });
    expect(titulo.closest('[inert]')).toBeNull();
  });

  it('en espera por demasiados intentos lo dice con un texto claro', async () => {
    const usuario = userEvent.setup();
    const { dialogo, perfil } = await abrirBloqueada();
    await db.perfiles.update(perfil.id, {
      intentos_offline: 5,
      espera_hasta: new Date(Date.now() + 60_000).toISOString(),
    });
    await usuario.type(within(dialogo).getByLabelText(/^Contraseña/), CLAVE);
    await usuario.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
    expect(await within(dialogo).findByText(MENSAJE_ESPERA_INTENTOS)).toBeInTheDocument();
    expect(sesion.estado().bloqueada).toBe(true);
  });

  it('"No soy <nombre>" cierra la sesión, conserva los pendientes y vuelve al login', async () => {
    const usuario = userEvent.setup();
    const { dialogo, perfil, router } = await abrirBloqueada();
    await registrarConsumoLocal(perfil.id, {
      order_id: uuidv7(),
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L-1',
    });

    await usuario.click(within(dialogo).getByRole('button', { name: 'No soy Ana Gómez' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Control de Materia Prima' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(sesion.estado().modo).toBe('sin_sesion');
    expect(
      await screen.findByText(/Los registros sin sincronizar de Ana Gómez siguen guardados/),
    ).toBeInTheDocument();
    expect(await db.consumos.count()).toBe(1);
  });
});

// S-09: tras una revocación del servidor, la app queda tapada por la pantalla de bloqueo y la
// contraseña correcta SIN conexión no la desbloquea (el verificador local no vale para esto).

import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MENSAJE_SIN_CONEXION_CONFIRMAR, sesion } from '../../auth';
import {
  CLAVE,
  entrarSinConexion,
  fijarConexion,
  reiniciarApp,
  renderizarApp,
} from '../../test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

describe('S-09: bloqueo por revocación del servidor', () => {
  it('tapa la app, lo explica y no se desbloquea sin conexión', async () => {
    const usuario = userEvent.setup();
    await entrarSinConexion('jefe', 'Beto Ruiz');
    renderizarApp('/jefe');
    const titulo = await screen.findByRole('heading', { level: 1, name: 'Validación de consumos' });

    act(() => sesion.marcarSesionRevocada());
    const dialogo = await screen.findByRole('dialog', { name: 'Confirme que es Beto Ruiz' });
    expect(dialogo).toHaveAccessibleDescription(/^El servidor cerró su sesión/);
    expect(titulo.closest('[inert]')).not.toBeNull();

    fijarConexion(false);
    await usuario.type(within(dialogo).getByLabelText(/^Contraseña/), CLAVE);
    await usuario.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
    expect(await within(dialogo).findByText(MENSAJE_SIN_CONEXION_CONFIRMAR)).toBeInTheDocument();
    expect(sesion.estado()).toMatchObject({ bloqueada: true, revocada: true });
  });
});

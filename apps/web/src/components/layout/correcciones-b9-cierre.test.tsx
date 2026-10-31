// B9 (docs/correcciones-v1.1.md): al cerrar sesión con una foto `bloqueada` (el servidor no la
// aceptó), la UI lo advierte y no se borra nada (§5: cerrar sesión solo borra si no hay pendientes).

import { uuidv7 } from '@catmetal/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../datos/db';
import {
  aplicarResultados,
  bloquearEvidencia,
  marcarEnviando,
  registrarConsumoConNovedadLocal,
  siguienteLote,
} from '../../datos/outbox';
import { fotoDe, resultado } from '../../datos/pruebas/fabricas';
import { entrarSinConexion, reiniciarApp, renderizarApp } from '../../test/app';

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

async function fotoBloqueadaDe(userId: string): Promise<string> {
  await registrarConsumoConNovedadLocal(
    userId,
    { order_id: uuidv7(), material_id: uuidv7(), cantidad: 2, unidad: 'kg', lote: 'L-1' },
    { tipo: 'merma', descripcion: 'Arena húmeda' },
    [fotoDe('foto')],
  );
  const lote = await marcarEnviando(userId, await siguienteLote(userId, 25));
  await aplicarResultados(userId, lote, [
    resultado(lote, 0, { resultado: 'aplicada' }),
    resultado(lote, 1, { resultado: 'aplicada' }),
  ]);
  const [foto] = await db.evidencias.toArray();
  await bloquearEvidencia(userId, foto!.id, {
    code: 'EVIDENCIA_TIPO_INVALIDO',
    message: 'La foto debe ser una imagen JPG, PNG o WEBP.',
  });
  return foto!.id;
}

describe('B9: cerrar sesión con una foto bloqueada', () => {
  it('advierte que la foto no se pudo subir, la conserva y no borra los datos', async () => {
    const usuario = userEvent.setup();
    const perfil = await entrarSinConexion('supervisor', 'Ana Gómez');
    const id = await fotoBloqueadaDe(perfil.id);
    renderizarApp('/supervisor');
    await screen.findByRole('heading', { level: 1, name: 'Mis órdenes en proceso' });

    await usuario.click(screen.getByRole('button', { name: /^Cuenta de Ana Gómez/ }));
    await usuario.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    const dialogo = await screen.findByRole('alertdialog', { name: '¿Cerrar sesión?' });
    expect(dialogo).not.toHaveTextContent('Todo está sincronizado');
    expect(dialogo).toHaveTextContent('Tiene 1 foto que el servidor no aceptó.');
    expect(dialogo).toHaveTextContent('No se borran: se conservan en esta tablet');

    await usuario.click(within(dialogo).getByRole('button', { name: 'Cerrar sesión' }));
    expect(
      await screen.findByText(/no aceptó siguen guardadas en esta tablet/),
    ).toBeInTheDocument();
    const foto = await db.evidencias.get([perfil.id, id]);
    expect(foto).toMatchObject({ estado_subida: 'bloqueada' });
    expect(foto!.datos).not.toBeNull();
    expect(await db.novedades.where('user_id').equals(perfil.id).count()).toBe(1);
  });
});

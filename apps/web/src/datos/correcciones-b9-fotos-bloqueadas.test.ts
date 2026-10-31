// B9 (docs/correcciones-v1.1.md): una foto `bloqueada` (el servidor no la aceptó: 413/415/400 o
// `EVIDENCIA_YA_SUBIDA` con otro sha) nunca llegó al servidor y sus bytes son la única copia. Ni el
// cierre de sesión ni la retención automática pueden borrarla; `puedeBorrarDatosDeUsuario` la cuenta.

import { uuidv7 } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  aplicarResultados,
  bloquearEvidencia,
  borrarDatosDeUsuario,
  marcarEnviando,
  puedeBorrarDatosDeUsuario,
  purgarAplicadasAntiguas,
  registrarConsumoConNovedadLocal,
  siguienteLote,
} from './outbox';
import { fotoDe, guardarPerfil, limpiarDb, resultado } from './pruebas/fabricas';
import { aplicarRetencionDelDispositivo } from './retencion';

const A = uuidv7();
const DIA = 86_400_000;

/** Novedad con foto aplicada en el servidor; la subida de la foto falla con un error permanente. */
async function fotoBloqueada(ahora: Date): Promise<string> {
  await registrarConsumoConNovedadLocal(
    A,
    { order_id: uuidv7(), material_id: uuidv7(), cantidad: 3, unidad: 'kg', lote: 'L-9' },
    { tipo: 'merma', descripcion: 'Arena húmeda' },
    [fotoDe('foto-de-planta')],
  );
  const lote = await marcarEnviando(A, await siguienteLote(A, 25, ahora), ahora);
  await aplicarResultados(
    A,
    lote,
    [resultado(lote, 0, { resultado: 'aplicada' }), resultado(lote, 1, { resultado: 'aplicada' })],
    { ahora },
  );
  const [foto] = await db.evidencias.toArray();
  await bloquearEvidencia(
    A,
    foto!.id,
    { code: 'EVIDENCIA_DEMASIADO_GRANDE', message: 'La foto es demasiado grande.' },
    ahora,
  );
  return foto!.id;
}

beforeEach(async () => {
  await limpiarDb();
  await guardarPerfil(A, 'Ana Gómez');
});

describe('B9: fotos bloqueadas que nunca llegaron al servidor', () => {
  it('cuentan como pendientes: impiden borrar los datos al cerrar sesión', async () => {
    const id = await fotoBloqueada(new Date());
    expect(await puedeBorrarDatosDeUsuario(A)).toEqual({
      puede: false,
      mutaciones: 0,
      evidencias: 0,
      fotos_bloqueadas: 1,
    });
    await expect(borrarDatosDeUsuario(A, { conservarPerfil: true })).rejects.toMatchObject({
      code: 'PENDIENTES_LOCALES',
    });
    const foto = await db.evidencias.get([A, id]);
    expect(foto).toMatchObject({ estado_subida: 'bloqueada' });
    expect(foto!.datos).not.toBeNull();
  });

  it('sobreviven aunque su novedad ya salió de la retención del outbox', async () => {
    const hace40Dias = new Date(Date.now() - 40 * DIA);
    const id = await fotoBloqueada(hace40Dias);
    // La mutación de la novedad (aplicada hace 40 días) se purga: ya nada "conserva" la foto.
    expect((await purgarAplicadasAntiguas(A, new Date())).mutaciones).toBe(2);
    expect(await db.outbox.count()).toBe(0);

    await expect(borrarDatosDeUsuario(A, { conservarPerfil: true })).rejects.toMatchObject({
      code: 'PENDIENTES_LOCALES',
    });
    expect((await db.evidencias.get([A, id]))?.datos).not.toBeNull();
  });

  it('la retención automática no caduca el perfil ni borra la foto', async () => {
    const hace40Dias = new Date(Date.now() - 40 * DIA);
    const id = await fotoBloqueada(hace40Dias);
    await db.perfiles.update(A, { ultimo_acceso_at: hace40Dias.toISOString() });

    const r = await aplicarRetencionDelDispositivo({ ahora: new Date() });
    expect(r.perfiles_caducados).toEqual([]);
    expect(await db.perfiles.get(A)).toBeDefined();
    const foto = await db.evidencias.get([A, id]);
    expect(foto).toMatchObject({ estado_subida: 'bloqueada' });
    expect(foto!.datos).not.toBeNull();
  });
});

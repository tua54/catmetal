// B3 (cliente, docs/correcciones-v1.1.md): una colisión de clave primaria con una fila ajena llega
// como `{ resultado: 'conflicto', code: 'ID_DUPLICADO' }` SIN `servidor` (commit f8b5c1b). El
// cliente nunca adopta una copia del servidor inexistente, conserva la mutación (los conflictos no
// se borran), la muestra como conflicto con un mensaje claro y trata la creación como no aceptada:
// lo que dependía de ella se rechaza localmente y no se envía contra la fila de otra persona.

import { MENSAJES_ERROR, permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { aplicarEntidades } from '../datos/aplicar-cambios';
import { db } from '../datos/db';
import {
  aplicarResultados,
  aprobarLocal,
  editarConsumoLocal,
  marcarEnviando,
  registrarConsumoLocal,
  registrarNovedadLocal,
  siguienteLote,
} from '../datos/outbox';
import {
  consumoServidor,
  fotoDe,
  guardarPerfil,
  limpiarDb,
  resultado,
} from '../datos/pruebas/fabricas';
import type { MutacionOutbox } from '../datos/tipos';
import {
  accionesDeConsumo,
  explicacionEstado,
  mensajeErrorSync,
} from '../features/consumos/estado-consumo';
import { crearStoreEstadoSync } from './estado';
import { MotorSync } from './motor';
import { crearServidorSync } from './pruebas/servidor-sync';
import { sesionFalsa } from './pruebas/sesion-falsa';

const A = uuidv7();
const ORDEN = uuidv7();
const MATERIAL = uuidv7();

const COLISION = {
  resultado: 'conflicto',
  code: 'ID_DUPLICADO',
  message: MENSAJES_ERROR.ID_DUPLICADO,
} as const;

function entrada(base: Record<string, unknown> = {}) {
  return {
    order_id: ORDEN,
    material_id: MATERIAL,
    cantidad: 4,
    unidad: 'kg' as const,
    lote: 'L-1',
    ...base,
  };
}

async function enviar(userId: string): Promise<MutacionOutbox[]> {
  return marcarEnviando(userId, await siguienteLote(userId, 25));
}

beforeEach(async () => {
  await limpiarDb();
  await guardarPerfil(A, 'Ana Gómez');
});

describe('B3: colisión de PK en la creación de un consumo', () => {
  it('queda en conflicto (no se borra), sin copia del servidor, y la UI ofrece registrarlo de nuevo', async () => {
    const { id, mutation_id } = await registrarConsumoLocal(A, entrada());
    const lote = await enviar(A);
    const r = await aplicarResultados(A, lote, [resultado(lote, 0, COLISION)]);
    expect(r).toMatchObject({ conflictos: 1, rechazadas: 0, sin_resultado: 0 });

    // La mutación se conserva en conflicto, con su código.
    expect(await db.outbox.get(mutation_id)).toMatchObject({
      estado: 'conflicto',
      error: { code: 'ID_DUPLICADO', message: MENSAJES_ERROR.ID_DUPLICADO },
    });
    const c = await db.consumos.get([A, id]);
    expect(c).toMatchObject({
      estado_local: 'conflicto',
      servidor: null,
      conflicto_servidor: null,
      error_sync: { code: 'ID_DUPLICADO' },
      cantidad: 4,
    });

    // UI: conflicto con el mensaje del contrato; NO se edita (el id es de otra fila), se registra de nuevo.
    expect(mensajeErrorSync(c!.error_sync)).toBe('Ya existe un registro con este identificador.');
    expect(explicacionEstado(c!)).toMatch(/^Ya existe un registro con este identificador/);
    expect(accionesDeConsumo(c!, A)).toMatchObject({ editar: false, registrarDeNuevo: true });

    // Nada se puede colgar de una creación que el servidor no aceptó.
    await expect(editarConsumoLocal(A, { id, cantidad: 9 })).rejects.toMatchObject({
      code: 'DEPENDENCIA_RECHAZADA',
    });
    await expect(
      registrarNovedadLocal(A, { consumption_id: id, tipo: 'merma', descripcion: 'x' }),
    ).rejects.toMatchObject({ code: 'DEPENDENCIA_RECHAZADA' });
  });

  it('lo que dependía de la creación se rechaza localmente y sus fotos se bloquean con sus bytes', async () => {
    const { id } = await registrarConsumoLocal(A, entrada());
    const edicion = await editarConsumoLocal(A, { id, cantidad: 6 });
    const novedad = await registrarNovedadLocal(
      A,
      { consumption_id: id, tipo: 'merma', descripcion: 'Arena húmeda' },
      [fotoDe('abc')],
    );
    // Solo sale la creación (el servidor la responde sola, como si el resto esperara su turno).
    const lote = await marcarEnviando(A, (await siguienteLote(A, 25)).slice(0, 1));
    const r = await aplicarResultados(A, lote, [resultado(lote, 0, COLISION)]);
    expect(r).toMatchObject({ conflictos: 1, dependientes_rechazadas: 2 });

    expect(await db.outbox.get(edicion.mutation_id)).toMatchObject({
      estado: 'rechazada',
      error: { code: 'DEPENDENCIA_RECHAZADA' },
    });
    expect(await db.outbox.get(novedad.mutation_id)).toMatchObject({ estado: 'rechazada' });
    const [foto] = await db.evidencias.toArray();
    expect(foto).toMatchObject({ estado_subida: 'bloqueada' });
    expect(foto!.datos).not.toBeNull();
    expect(await siguienteLote(A, 25)).toHaveLength(0);
    expect(await db.consumos.get([A, id])).toMatchObject({ estado_local: 'conflicto' });
  });
});

describe('B3: colisiones sin `servidor` en mutaciones sobre entidades que ya existen', () => {
  it('aprobar con un id de validación ajeno: conflicto, sin tocar la copia del servidor del consumo', async () => {
    const JEFE = uuidv7();
    const s = consumoServidor({ version: 3 });
    await aplicarEntidades(JEFE, [{ entidad: 'consumptions', id: s.id, datos: { ...s } }]);
    const v = await aprobarLocal(JEFE, { consumption_id: s.id });
    const lote = await enviar(JEFE);
    await aplicarResultados(JEFE, lote, [resultado(lote, 0, COLISION)]);

    expect(await db.outbox.get(v.mutation_id)).toMatchObject({ estado: 'conflicto' });
    expect(await db.validaciones.get([JEFE, v.id])).toMatchObject({
      estado_local: 'conflicto',
      servidor: null,
      error_sync: { code: 'ID_DUPLICADO' },
    });
    const c = await db.consumos.get([JEFE, s.id]);
    expect(c?.servidor).toMatchObject({ id: s.id, version: 3, estado: 'pendiente' });
  });

  it('edición con un mutation_id ya usado por otro usuario: la copia del servidor se conserva', async () => {
    const { id } = await registrarConsumoLocal(A, entrada());
    let lote = await enviar(A);
    const creado = consumoServidor({ id, registrado_por: A, order_id: ORDEN, version: 1 });
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { ...creado } }),
    ]);
    await editarConsumoLocal(A, { id, cantidad: 8 });
    lote = await enviar(A);
    await aplicarResultados(A, lote, [resultado(lote, 0, COLISION)]);

    const c = await db.consumos.get([A, id]);
    expect(c).toMatchObject({
      estado_local: 'conflicto',
      conflicto_servidor: null,
      error_sync: { code: 'ID_DUPLICADO' },
    });
    expect(c?.servidor).toMatchObject({ id, version: 1 });
    expect(explicacionEstado(c!)).toMatch(/^Ya existe un registro con este identificador/);
  });
});

describe('B3: motor contra el servidor falso', () => {
  function supervisor(nombre: string): Perfil {
    const id = uuidv7();
    return {
      id,
      nombre,
      email: `${id}@catmetal.co`,
      rol: 'supervisor',
      permisos: permisosDeRol('supervisor'),
    };
  }

  it('un consumo con el id de un consumo ajeno queda en conflicto y la fila ajena no cambia', async () => {
    const servidor = crearServidorSync();
    const ana = supervisor('Ana');
    const beto = supervisor('Beto');
    await guardarPerfil(ana.id, ana.nombre);
    const ajeno = consumoServidor({ registrado_por: beto.id, cantidad: 77 });
    servidor.upsert('consumptions', ajeno.id, { ...ajeno });
    const { mutation_id } = await registrarConsumoLocal(ana.id, entrada({ id: ajeno.id }));

    const motor = new MotorSync({
      sesion: sesionFalsa(servidor, ana),
      estado: crearStoreEstadoSync(),
      locks: null,
      aleatorio: () => 0,
      candado: { intervaloMs: 2 },
    });
    const resumen = await motor.sincronizar('manual');
    expect(resumen).toMatchObject({ conflictos: 1, aplicadas: 0, error: null });
    expect(servidor.entidades('consumptions')).toEqual([
      expect.objectContaining({ id: ajeno.id, cantidad: 77, registrado_por: beto.id }),
    ]);
    expect(await db.outbox.get(mutation_id)).toMatchObject({
      estado: 'conflicto',
      error: { code: 'ID_DUPLICADO' },
    });
    // No se reenvía: un conflicto espera a que la persona actúe.
    const pushes = servidor.pushes().length;
    await motor.sincronizar('manual');
    expect(servidor.pushes()).toHaveLength(pushes);
  });

  it('un mutation_id usado por otro usuario responde conflicto ID_DUPLICADO sin `servidor`', async () => {
    const servidor = crearServidorSync();
    const ana = supervisor('Ana');
    const beto = supervisor('Beto');
    const mutationId = uuidv7();
    const cuerpo = (userId: string) => ({
      user_id: userId,
      mutaciones: [
        {
          mutation_id: mutationId,
          tipo: 'consumo.crear',
          client_created_at: new Date().toISOString(),
          payload: { id: uuidv7(), ...entrada(), client_created_at: new Date().toISOString() },
        },
      ],
    });
    const pedir = (userId: string) =>
      servidor.fetch('/api/v1/sync/push', {
        method: 'POST',
        headers: { Authorization: `Bearer tok-${userId}` },
        body: JSON.stringify(cuerpo(userId)),
      });
    await pedir(ana.id);
    const respuesta = (await (await pedir(beto.id)).json()) as { resultados: unknown[] };
    expect(respuesta.resultados).toEqual([
      {
        indice: 0,
        mutation_id: mutationId,
        resultado: 'conflicto',
        code: 'ID_DUPLICADO',
        message: MENSAJES_ERROR.ID_DUPLICADO,
      },
    ]);
  });
});

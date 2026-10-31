// A6 (cliente; docs/correcciones-v1.2.md y ADR 0029, punto 1): la purga de S-03
// (`purgarAjenosSinVisibilidad`) borraba los consumos ajenos sin visibilidad, pero dejaba el área
// temporal del snapshot. Una descarga a medias, guardada cuando el usuario aún veía esas órdenes, se
// reanudaba y `completarSnapshot` volvía a meter lo ajeno en el estado vivo. Ahora la purga descarta
// también el área temporal del usuario EN LA MISMA transacción, y la siguiente sync empieza el
// snapshot de cero. No se toca el área de otros usuarios ni el outbox.
//
// Determinismo: el área temporal se arma con `guardarPaginaSnapshot` (sin red) y el fallo de la
// atomicidad se fuerza con un espía; la sync usa el servidor falso con un token de página válido.

import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearServidorFalso, type ServidorFalso } from '../auth/pruebas/servidor-falso';
import { GestorSesion } from '../auth/sesion';
import { crearStoreEstadoSync } from '../sync/estado';
import { MotorSync } from '../sync/motor';
import { crearServidorSync } from '../sync/pruebas/servidor-sync';
import { sesionFalsa } from '../sync/pruebas/sesion-falsa';
import { aplicarEntidades } from './aplicar-cambios';
import { db } from './db';
import { registrarConsumoLocal } from './outbox';
import { consumoServidor, guardarPerfil, limpiarDb } from './pruebas/fabricas';
import { guardarPaginaSnapshot, leerProgresoSnapshot } from './snapshot-temporal';
import { purgarAjenosSinVisibilidad } from './visibilidad';

const CLAVE = 'clave-segura-beto';
const OTRO = uuidv7();
const AHORA = new Date().toISOString();

let auth: ServidorFalso;
let beto: Perfil;

/** Filas del área temporal de `userId` y su progreso. */
async function areaDe(userId: string) {
  const entidades = await db.snapshot_entidades
    .where(':id')
    .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
    .toArray();
  return { entidades, progreso: await leerProgresoSnapshot(userId) };
}

/**
 * Partición de un jefe con un consumo ajeno (sin pendientes) en el estado vivo, y una descarga del
 * snapshot a medias cuya primera página trae OTRO consumo ajeno de una orden que dejará de ver.
 */
async function jefeConDescargaAMedias(userId: string, epoca = 'epoca-1', cursor = 0) {
  const ajenoVivo = consumoServidor({ registrado_por: OTRO });
  const ajenoEnArea = consumoServidor({ registrado_por: OTRO });
  await aplicarEntidades(userId, [
    { entidad: 'consumptions', id: ajenoVivo.id, datos: { ...ajenoVivo } },
  ]);
  await guardarPaginaSnapshot(
    userId,
    {
      epoca,
      cursor,
      entidades: [{ entidad: 'consumptions', id: ajenoEnArea.id, datos: { ...ajenoEnArea } }],
      siguiente_pagina: `p1_${cursor}`,
    },
    AHORA,
  );
  return { ajenoVivo, ajenoEnArea };
}

beforeEach(async () => {
  await limpiarDb();
  auth = crearServidorFalso();
  beto = auth.agregarUsuario('Beto Ruiz', 'beto@catmetal.co', CLAVE, 'jefe');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A6: la purga de S-03 descarta el área temporal del snapshot', () => {
  it('tras la purga, el área temporal y el progreso del usuario quedan vacíos', async () => {
    const { ajenoVivo } = await jefeConDescargaAMedias(beto.id);
    expect((await areaDe(beto.id)).entidades).toHaveLength(1);

    const borrados = await purgarAjenosSinVisibilidad(beto.id);

    expect(borrados).toBe(1);
    expect(await db.consumos.get([beto.id, ajenoVivo.id])).toBeUndefined();
    expect(await areaDe(beto.id)).toEqual({ entidades: [], progreso: undefined });
  });

  it('el área temporal de OTRO usuario de la tablet y el outbox no se tocan', async () => {
    await jefeConDescargaAMedias(beto.id);
    const ana = uuidv7();
    await jefeConDescargaAMedias(ana);
    const pendiente = await registrarConsumoLocal(beto.id, {
      order_id: uuidv7(),
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });
    const areaAna = await areaDe(ana);
    const outboxAntes = await db.outbox.toArray();

    await purgarAjenosSinVisibilidad(beto.id);

    expect(await areaDe(ana)).toEqual(areaAna);
    expect(areaAna.entidades).toHaveLength(1);
    expect(await db.outbox.toArray()).toEqual(outboxAntes);
    expect(await db.consumos.get([beto.id, pendiente.id])).toBeDefined();
  });

  it('atomicidad: si la purga falla a mitad, ni los consumos ni el área temporal cambian', async () => {
    const { ajenoVivo } = await jefeConDescargaAMedias(beto.id);
    const areaAntes = await areaDe(beto.id);
    // Falla el último paso (borrar el progreso), después de borrar el consumo y las filas del área.
    vi.spyOn(db.snapshot_progreso, 'delete').mockImplementation(() =>
      Dexie.Promise.reject(new Error('fallo forzado en la purga')),
    );

    await expect(purgarAjenosSinVisibilidad(beto.id)).rejects.toThrow('fallo forzado en la purga');

    expect(await db.consumos.get([beto.id, ajenoVivo.id])).toBeDefined();
    expect(await areaDe(beto.id)).toEqual(areaAntes);
  });

  it('al iniciar sesión con el rol bajado (jefe → supervisor), la purga de la sesión también descarta el área', async () => {
    const s = new GestorSesion({
      fetch: auth.fetch,
      locks: null,
      iteraciones: 1_000,
      iteracionesMinimas: 1_000,
      enLinea: () => true,
    });
    await s.iniciarSesion('beto@catmetal.co', CLAVE);
    const { ajenoVivo } = await jefeConDescargaAMedias(beto.id);

    beto.rol = 'supervisor';
    beto.permisos = permisosDeRol('supervisor');
    await s.iniciarSesion('beto@catmetal.co', CLAVE);

    expect(await db.consumos.get([beto.id, ajenoVivo.id])).toBeUndefined();
    expect(await areaDe(beto.id)).toEqual({ entidades: [], progreso: undefined });
  });

  it('la siguiente sync no reanuda el token viejo (snapshot sin `pagina`) y lo ajeno no reaparece', async () => {
    const servidor = crearServidorSync();
    const m1 = uuidv7();
    const m2 = uuidv7();
    for (const [id, nombre] of [
      [m1, 'Arena'],
      [m2, 'Coque'],
    ] as const) {
      servidor.upsert('materials', id, {
        id,
        codigo: `MP-${nombre}`,
        nombre,
        unidad: 'kg',
        costo_unitario_cop: 1,
        activo: true,
      });
    }
    servidor.tamSnapshot = 1;
    // Beto ya es supervisor: el servidor no le manda el consumo ajeno. La descarga a medias (de
    // cuando era jefe) sí lo tiene en su página 1, con un token que el servidor falso acepta.
    const supervisor: Perfil = {
      ...beto,
      rol: 'supervisor',
      permisos: permisosDeRol('supervisor'),
    };
    await guardarPerfil(beto.id, beto.nombre);
    const { ajenoEnArea } = await jefeConDescargaAMedias(beto.id, servidor.epoca, servidor.seq());

    await purgarAjenosSinVisibilidad(beto.id);
    const resumen = await new MotorSync({
      sesion: sesionFalsa(servidor, supervisor),
      estado: crearStoreEstadoSync(),
      locks: null,
      aleatorio: () => 0,
      candado: { intervaloMs: 2 },
    }).sincronizar('manual');

    expect(resumen).toMatchObject({ error: null });
    const snapshots = servidor.peticiones.filter((p) => p.ruta === '/api/v1/sync/snapshot');
    expect(snapshots[0]?.query.get('pagina')).toBeNull();
    expect(await db.consumos.get([beto.id, ajenoEnArea.id])).toBeUndefined();
    expect(await db.materiales.count()).toBe(2);
    expect(await areaDe(beto.id)).toEqual({ entidades: [], progreso: undefined });
  });
});

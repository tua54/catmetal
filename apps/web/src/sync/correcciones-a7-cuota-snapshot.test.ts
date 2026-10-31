// A7 (docs/correcciones-v1.2.md; ADR 0022, Enmienda 1): cuota de almacenamiento agotada al guardar
// una página del snapshot o en el reemplazo (`completarSnapshot`).
//
// - Se descarta el área temporal del usuario; el estado vivo (catálogos, `meta`) no se toca.
// - La descarga se reintenta con la espera exponencial del motor (`calcularRetrasoMs`), nunca en un
//   bucle inmediato.
// - Aviso persistente mientras dure: "Almacenamiento lleno: sincroniza o libera espacio".
// - El push del outbox y la subida de fotos (que liberan espacio) siguen saliendo, salvo que haya un
//   cambio de época pendiente: entonces nada sale antes del reemplazo (ADR 0009 y 0022 punto 5).
//
// Determinismo: la cuota se simula con un espía que lanza el error con el nombre real
// (`QuotaExceededError`, como lo expone Dexie o envuelto en un `AbortError`); el reloj del motor es
// una variable que la prueba avanza y el `aleatorio` del backoff es 0 (espera = 1 s, 2 s, 4 s…).

import { uuidv7, type Perfil } from '@catmetal/shared';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leerMetaSync } from '../datos/aplicar-cambios';
import { db } from '../datos/db';
import { registrarConsumoConNovedadLocal, registrarConsumoLocal } from '../datos/outbox';
import { fotoDe, guardarPerfil, limpiarDb } from '../datos/pruebas/fabricas';
import {
  esCuotaAgotada,
  guardarPaginaSnapshot,
  leerProgresoSnapshot,
} from '../datos/snapshot-temporal';
import { AVISO_ALMACENAMIENTO_LLENO, crearStoreEstadoSync, type StoreEstadoSync } from './estado';
import { MotorSync } from './motor';
import { crearServidorSync, type ServidorSync } from './pruebas/servidor-sync';
import { perfilFalso, sesionFalsa } from './pruebas/sesion-falsa';

const ORDEN = uuidv7();
const M1 = uuidv7();
const M2 = uuidv7();
const AVISO = 'Almacenamiento lleno: sincroniza o libera espacio';

let servidor: ServidorSync;
let reloj: number;
let estado: StoreEstadoSync;
let ana: Perfil;

function motor(): MotorSync {
  return new MotorSync({
    sesion: sesionFalsa(servidor, ana),
    estado,
    locks: null,
    ahora: () => reloj,
    aleatorio: () => 0,
    candado: { intervaloMs: 2 },
  });
}

function material(id: string, nombre: string): Record<string, unknown> {
  return { id, codigo: `MP-${nombre}`, nombre, unidad: 'kg', costo_unitario_cop: 1, activo: true };
}

function catalogoInicial(): void {
  servidor.upsert('production_orders', ORDEN, {
    id: ORDEN,
    codigo: 'OP-1',
    linea: 'Fundición',
    estado: 'en_proceso',
    fecha_inicio: null,
    fecha_fin: null,
    creada_por: uuidv7(),
    created_at: '2026-10-29T12:00:00.000Z',
    updated_at: '2026-10-29T12:00:00.000Z',
  });
  servidor.upsert('materials', M1, material(M1, 'Arena'));
  servidor.upsert('materials', M2, material(M2, 'Coque'));
  servidor.upsert('order_supervisors', `${ORDEN}:${ana.id}`, {
    order_id: ORDEN,
    user_id: ana.id,
    activo: true,
  });
}

function consumo() {
  return { order_id: ORDEN, material_id: M1, cantidad: 4, unidad: 'kg' as const, lote: 'L-A7' };
}

/** Catálogos vivos de la partición (lo que el supervisor usa para registrar). */
async function catalogosVivos() {
  return {
    ordenes: await db.ordenes.toArray(),
    materiales: await db.materiales.toArray(),
    asignaciones: await db.asignaciones.toArray(),
  };
}

async function areaTemporal() {
  return {
    entidades: await db.snapshot_entidades.count(),
    progreso: await leerProgresoSnapshot(ana.id),
  };
}

function snapshotsInicial(): number {
  return servidor.peticiones.filter(
    (p) => p.ruta === '/api/v1/sync/snapshot' && p.query.get('alcance') === 'inicial',
  ).length;
}

/** Cuota agotada al guardar páginas del área temporal desde la llamada `desde` (1 = la primera). */
function cuotaEnPaginas(desde = 1) {
  const original = db.snapshot_entidades.bulkPut.bind(db.snapshot_entidades);
  let llamadas = 0;
  return vi
    .spyOn(db.snapshot_entidades, 'bulkPut')
    .mockImplementation((...args: Parameters<typeof original>) => {
      llamadas += 1;
      if (llamadas >= desde) {
        // Así lo lanza Dexie al traducir el `DOMException` de IndexedDB.
        return Dexie.Promise.reject(
          new Dexie.QuotaExceededError('Se agotó la cuota de IndexedDB.'),
        );
      }
      return original(...args);
    });
}

/**
 * Cuota agotada al confirmar el reemplazo: falla la escritura de `meta` DENTRO de la transacción de
 * `completarSnapshot` (la única que incluye el área temporal), después de haber borrado y escrito
 * catálogos. El error llega envuelto, como un `AbortError` con el `QuotaExceededError` en `inner`.
 */
function cuotaEnReemplazo() {
  const original = db.meta.put.bind(db.meta);
  return vi.spyOn(db.meta, 'put').mockImplementation((...args: Parameters<typeof original>) => {
    if (Dexie.currentTransaction?.storeNames.includes('snapshot_entidades') === true) {
      return Dexie.Promise.reject(
        new Dexie.AbortError(
          'La transacción se abortó.',
          new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
        ),
      );
    }
    return original(...args);
  });
}

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorSync();
  reloj = Date.parse('2026-10-30T12:00:00.000Z');
  estado = crearStoreEstadoSync();
  ana = perfilFalso('Ana Gómez');
  await guardarPerfil(ana.id, ana.nombre);
  catalogoInicial();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A7: cuota agotada en el snapshot', () => {
  it('en una página: descarta el área temporal, conserva el estado vivo, sigue enviando el outbox y las fotos, avisa y reintenta con espera', async () => {
    const m = motor();
    await m.sincronizar('apertura');
    const vivos = await catalogosVivos();
    expect(vivos.materiales).toHaveLength(2);
    const metaAntes = await leerMetaSync(ana.id);

    // El servidor pide un snapshot (misma época) y las páginas no caben desde la segunda.
    servidor.agregarCambio('reiniciar', 'users', ana.id);
    servidor.tamSnapshot = 1;
    const cuota = cuotaEnPaginas(2);
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('foto-a7'),
    ]);

    const resumen = await m.sincronizar('intervalo');

    // El outbox y la foto salieron (liberan espacio); la descarga quedó en espera con el aviso.
    expect(resumen).toMatchObject({
      ejecutada: true,
      aplicadas: 2,
      fotos_subidas: 1,
      almacenamiento_lleno: true,
      error: { message: AVISO },
    });
    expect(estado.getState()).toMatchObject({
      almacenamientoLleno: true,
      error: { message: AVISO },
    });
    // Área temporal descartada (la página 1 ya se había guardado) y estado vivo intacto.
    expect(await areaTemporal()).toEqual({ entidades: 0, progreso: undefined });
    expect(await catalogosVivos()).toEqual(vivos);
    expect(await leerMetaSync(ana.id)).toMatchObject({
      epoca: metaAntes.epoca,
      requiere_snapshot: true,
    });

    // Sin bucle inmediato: antes de la espera (1 s con aleatorio 0) no se vuelve a pedir el
    // snapshot, pero el push sigue saliendo.
    const pedidas = snapshotsInicial();
    await registrarConsumoLocal(ana.id, consumo());
    reloj += 999;
    const enEspera = await m.sincronizar('local');
    expect(enEspera).toMatchObject({
      aplicadas: 1,
      almacenamiento_lleno: true,
      error: { message: AVISO },
    });
    expect(snapshotsInicial()).toBe(pedidas);
    expect(estado.getState().almacenamientoLleno).toBe(true);

    // Vencida la espera se reintenta; vuelve a fallar y la espera crece (2 s).
    reloj += 1;
    await m.sincronizar('intervalo');
    expect(snapshotsInicial()).toBeGreaterThan(pedidas);
    const pedidas2 = snapshotsInicial();
    reloj += 1_999;
    await m.sincronizar('intervalo');
    expect(snapshotsInicial()).toBe(pedidas2);

    // Con espacio otra vez, el snapshot se completa y el aviso desaparece.
    cuota.mockRestore();
    reloj += 1;
    const final = await m.sincronizar('intervalo');
    expect(final).toMatchObject({ error: null, almacenamiento_lleno: false });
    expect(estado.getState()).toMatchObject({ almacenamientoLleno: false, error: null });
    expect(await leerMetaSync(ana.id)).toMatchObject({ requiere_snapshot: false, acciones: [] });
    expect(await areaTemporal()).toEqual({ entidades: 0, progreso: undefined });
  });

  it('en el reemplazo: descarta el área temporal sin tocar el estado vivo ni meta, y avisa', async () => {
    const m = motor();
    await m.sincronizar('apertura');
    const vivos = await catalogosVivos();
    const metaAntes = await leerMetaSync(ana.id);

    // Sin auditoría: el cambio solo llega con el snapshot (no por el pull).
    servidor.upsert('materials', M2, material(M2, 'Coque fino'), false);
    servidor.agregarCambio('reiniciar', 'users', ana.id);
    const cuota = cuotaEnReemplazo();
    const r = await registrarConsumoLocal(ana.id, consumo());

    const resumen = await m.sincronizar('intervalo');

    expect(resumen).toMatchObject({
      aplicadas: 1,
      almacenamiento_lleno: true,
      error: { message: AVISO },
    });
    expect(await db.outbox.get(r.mutation_id)).toMatchObject({ estado: 'aplicada' });
    expect(await areaTemporal()).toEqual({ entidades: 0, progreso: undefined });
    // La transacción del reemplazo se abortó entera: catálogos y meta como antes.
    expect(await catalogosVivos()).toEqual(vivos);
    expect(await db.materiales.get([ana.id, M2])).toMatchObject({ nombre: 'Coque' });
    expect(await leerMetaSync(ana.id)).toMatchObject({
      epoca: metaAntes.epoca,
      requiere_snapshot: true,
    });
    expect(estado.getState().almacenamientoLleno).toBe(true);

    cuota.mockRestore();
    reloj += 1_000;
    const final = await m.sincronizar('intervalo');
    expect(final).toMatchObject({ error: null, almacenamiento_lleno: false });
    expect(await db.materiales.get([ana.id, M2])).toMatchObject({ nombre: 'Coque fino' });
    expect(estado.getState().almacenamientoLleno).toBe(false);
  });

  it('con un cambio de época pendiente, el push NO se adelanta al reemplazo: nada sale con la época nueva hasta reencolar y reemplazar', async () => {
    const m = motor();
    await m.sincronizar('apertura');
    servidor.restaurar('epoca-2');
    const r = await registrarConsumoLocal(ana.id, consumo());
    const cuota = cuotaEnPaginas(1);

    const resumen = await m.sincronizar('intervalo');

    expect(resumen).toMatchObject({
      aplicadas: 0,
      sin_resultado: 0,
      almacenamiento_lleno: true,
      error: { message: AVISO },
    });
    // El servidor no aplicó nada: el único push llevó la época vieja y recibió EPOCA_CAMBIADA.
    expect(servidor.entidades('consumptions')).toHaveLength(0);
    expect(servidor.epocasRecibidas).toEqual(['epoca-1']);
    expect(await db.outbox.get(r.mutation_id)).toMatchObject({
      estado: 'pendiente',
      intentos: 0,
      siguiente_intento_at: null,
    });
    expect(await leerMetaSync(ana.id)).toMatchObject({
      epoca: 'epoca-1',
      requiere_snapshot: true,
      motivo_snapshot: 'epoca',
    });
    expect(await areaTemporal()).toEqual({ entidades: 0, progreso: undefined });

    // En espera, el push sigue sin poder aplicarse antes del reemplazo (EPOCA_CAMBIADA) y no se
    // pide el snapshot.
    const pedidas = snapshotsInicial();
    await m.sincronizar('local');
    expect(snapshotsInicial()).toBe(pedidas);
    expect(servidor.entidades('consumptions')).toHaveLength(0);
    expect(servidor.epocasRecibidas.every((e) => e === 'epoca-1')).toBe(true);

    // Con espacio: reemplazo con la época nueva y luego el reenvío.
    cuota.mockRestore();
    reloj += 1_000;
    const final = await m.sincronizar('intervalo');
    expect(final).toMatchObject({ error: null, epoca_cambiada: true, aplicadas: 1 });
    expect(servidor.entidades('consumptions').map((c) => c.id)).toEqual([r.id]);
    expect(servidor.epocasRecibidas.at(-1)).toBe('epoca-2');
    expect(await leerMetaSync(ana.id)).toMatchObject({
      epoca: 'epoca-2',
      requiere_snapshot: false,
    });
  });
});

describe('A7: capa de datos', () => {
  it('esCuotaAgotada reconoce el error de IndexedDB directo, el de Dexie y el envuelto', () => {
    const dom = new DOMException('quota', 'QuotaExceededError');
    expect(esCuotaAgotada(dom)).toBe(true);
    expect(esCuotaAgotada(new Dexie.QuotaExceededError('x'))).toBe(true);
    expect(esCuotaAgotada(new Dexie.AbortError('abortada', dom))).toBe(true);
    expect(esCuotaAgotada(new Dexie.BulkError('bulk', { 0: dom }))).toBe(true);
    expect(esCuotaAgotada(new Error('otra', { cause: dom }))).toBe(true);
    expect(esCuotaAgotada(new Dexie.AbortError('abortada'))).toBe(false);
    expect(esCuotaAgotada(new TypeError('Failed to fetch'))).toBe(false);
    expect(esCuotaAgotada(null)).toBe(false);
  });

  it('guardarPaginaSnapshot con cuota agotada descarta el área temporal del usuario y relanza', async () => {
    const pagina = {
      epoca: 'epoca-1',
      cursor: 5,
      entidades: [{ entidad: 'materials', id: M1, datos: material(M1, 'Arena') }],
    };
    await guardarPaginaSnapshot(ana.id, { ...pagina, siguiente_pagina: 'p2' });
    expect((await areaTemporal()).entidades).toBe(1);
    cuotaEnPaginas(1);
    await expect(
      guardarPaginaSnapshot(ana.id, { ...pagina, siguiente_pagina: 'p3' }),
    ).rejects.toSatisfy(esCuotaAgotada);
    expect(await areaTemporal()).toEqual({ entidades: 0, progreso: undefined });
  });

  it('el texto del aviso es el exigido', () => {
    expect(AVISO_ALMACENAMIENTO_LLENO).toBe(AVISO);
  });
});

// B10 (docs/correcciones-v1.1.md): sin Web Locks, el candado de IndexedDB vencía a los
// `duracionMs` aunque su titular siguiera trabajando: una sync más larga que la vida del candado lo
// perdía y otra pestaña podía entrar a la vez. Ahora se renueva (latido) mientras dura la tarea, y
// el motor trata como esperado que otra sincronización le gane un lote (`ErrorDatosLocales('CONFLICTO')`
// de `marcarEnviando`).

import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../datos/db';
import { registrarConsumoLocal } from '../datos/outbox';
import { guardarPerfil, limpiarDb } from '../datos/pruebas/fabricas';
import { crearStoreEstadoSync } from '../sync/estado';
import { MotorSync } from '../sync/motor';
import { crearServidorSync } from '../sync/pruebas/servidor-sync';
import { sesionFalsa } from '../sync/pruebas/sesion-falsa';
import { conCandado } from './candado';

const VIDA_MS = 1_000;

beforeEach(async () => {
  await limpiarDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Espera (con el reloj real de IndexedDB) a que se cumpla la condición. */
async function hasta(condicion: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await condicion()) {
      return;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('La condición no se cumplió.');
}

describe('B10: el candado alternativo se renueva mientras dura la tarea', () => {
  it('una tarea más larga que la vida del candado lo conserva y otra pestaña no puede tomarlo', async () => {
    // Solo se simulan los intervalos y la hora: IndexedDB (fake-indexeddb) sigue con su planificador.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let terminar!: () => void;
    const tarea = new Promise<void>((r) => {
      terminar = r;
    });
    const titular = conCandado('catmetal-sync', () => tarea.then(() => 'listo'), {
      locks: null,
      duracionMs: VIDA_MS,
      intervaloMs: 1,
    });
    await hasta(async () => (await db.candados.get('catmetal-sync')) !== undefined);
    const { titular: duenio } = (await db.candados.get('catmetal-sync'))!;

    // "Otra pestaña": otra instancia del módulo (su propia cola en memoria), contra la misma base.
    vi.resetModules();
    const otraPestana = await import('./candado');
    let otraEntro = false;
    const otra = otraPestana.conCandado(
      'catmetal-sync',
      () => {
        otraEntro = true;
        return Promise.resolve();
      },
      { locks: null, duracionMs: VIDA_MS, intervaloMs: 1 },
    );

    try {
      // La tarea dura 5 vidas del candado.
      for (let paso = 0; paso < 10; paso += 1) {
        await vi.advanceTimersByTimeAsync(VIDA_MS / 2);
        await new Promise((r) => setImmediate(r));
        const actual = await db.candados.get('catmetal-sync');
        expect(actual?.titular).toBe(duenio);
        expect(actual!.expira_at).toBeGreaterThan(Date.now());
        expect(otraEntro).toBe(false);
      }
    } finally {
      // Aunque falle una aserción, la tarea termina (si no, la cola en memoria queda tomada).
      terminar();
    }
    expect(await titular).toBe('listo');
    await otra;
    expect(otraEntro).toBe(true);
    expect(await db.candados.get('catmetal-sync')).toBeUndefined();
  });

  it('deja de renovar (y no pisa) si otro titular ya tiene el candado', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let terminar!: () => void;
    const tarea = new Promise<void>((r) => {
      terminar = r;
    });
    const titular = conCandado('c', () => tarea, { locks: null, duracionMs: VIDA_MS });
    await hasta(async () => (await db.candados.get('c')) !== undefined);
    // Se perdió (por ejemplo, la pestaña estuvo congelada) y otra pestaña lo tomó.
    await db.candados.put({ nombre: 'c', titular: 'otra', expira_at: Date.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(VIDA_MS);
    await new Promise((r) => setImmediate(r));
    expect(await db.candados.get('c')).toMatchObject({ titular: 'otra' });
    terminar();
    await titular;
    expect(await db.candados.get('c')).toMatchObject({ titular: 'otra' });
  });
});

describe('B10: otra sincronización ganó el lote', () => {
  it('el motor lo omite en silencio: sin error, sin enviar y sin tocar la mutación ajena', async () => {
    const servidor = crearServidorSync();
    const id = uuidv7();
    const ana: Perfil = {
      id,
      nombre: 'Ana',
      email: `${id}@catmetal.co`,
      rol: 'supervisor',
      permisos: permisosDeRol('supervisor'),
    };
    await guardarPerfil(ana.id, ana.nombre);
    const { mutation_id } = await registrarConsumoLocal(ana.id, {
      order_id: uuidv7(),
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L-1',
    });
    // Entre `siguienteLote` y `marcarEnviando`, otra sincronización marca la mutación `enviando`.
    const leerMeta = db.meta.get.bind(db.meta) as (clave: string) => Promise<unknown>;
    const otraSync = async (clave: string): Promise<unknown> => {
      await db.outbox.update(mutation_id, { estado: 'enviando', intentos: 1 });
      return leerMeta(clave);
    };
    // `Table.get` tiene sobrecargas de Dexie (PromiseExtended); aquí solo se usa con la clave.
    vi.spyOn(db.meta, 'get').mockImplementationOnce(otraSync as unknown as typeof db.meta.get);
    const estado = crearStoreEstadoSync();
    const motor = new MotorSync({
      sesion: sesionFalsa(servidor, ana),
      estado,
      locks: null,
      candado: { intervaloMs: 2 },
    });

    const resumen = await motor.sincronizar('manual');
    expect(resumen).toMatchObject({ ejecutada: true, error: null, enviadas: 0, lotes: 0 });
    expect(servidor.pushes()).toHaveLength(0);
    expect(await db.outbox.get(mutation_id)).toMatchObject({ estado: 'enviando', intentos: 1 });
    expect(estado.getState().error).toBeNull();
  });
});

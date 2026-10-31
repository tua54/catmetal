// Candado exclusivo entre pestañas (docs/spec.md §6; ADR 0008: refresh serializado).
//
// - Con Web Locks (`navigator.locks`), el navegador serializa entre pestañas y libera el candado si
//   la pestaña se cierra.
// - Sin Web Locks (navegadores viejos): cola en memoria (serializa dentro de la pestaña) + candado en
//   IndexedDB con expiración (entre pestañas). La expiración evita que una pestaña cerrada a mitad
//   del refresh bloquee a las demás para siempre. Mientras la tarea corre, su titular lo renueva
//   (latido, B10): solo vence si la pestaña que lo tiene deja de existir o queda congelada.

import { uuidv7 } from '@catmetal/shared';
import { db } from '../datos/db';

/** Subconjunto de `LockManager` que se usa (inyectable en pruebas). */
export interface GestorCandados {
  request<T>(nombre: string, callback: () => Promise<T>): Promise<T>;
}

export interface OpcionesCandado {
  /** `null` fuerza la alternativa; por defecto, `navigator.locks` si existe. */
  locks?: GestorCandados | null;
  /** Vida del candado en IndexedDB: si su titular no lo libera, vence. */
  duracionMs?: number;
  /** Cada cuánto se reintenta tomar el candado ocupado. */
  intervaloMs?: number;
  ahora?: () => number;
}

/**
 * Candado del motor de sync (nunca dos sincronizaciones a la vez entre pestañas). Vive aquí y no en
 * `sync/motor.ts` porque `cerrarSesion` también lo toma (F4-05) y `auth` no depende de `sync`.
 */
export const NOMBRE_CANDADO_SYNC = 'catmetal-sync';
/**
 * Vida del candado de sync en la alternativa de IndexedDB. Se renueva cada tercio mientras la sync
 * sigue (B10); solo vence si su pestaña se cierra o se congela.
 */
export const DURACION_CANDADO_SYNC_MS = 120_000;

const DURACION_MS = 30_000;
const INTERVALO_MS = 50;

const colasEnMemoria = new Map<string, Promise<unknown>>();

export function webLocksDisponibles(): GestorCandados | null {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks === undefined || typeof locks.request !== 'function') {
    return null;
  }
  return {
    request: <T>(nombre: string, callback: () => Promise<T>) =>
      locks.request(nombre, callback) as Promise<T>,
  };
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

async function tomarEnIndexedDb(
  nombre: string,
  titular: string,
  duracionMs: number,
  intervaloMs: number,
  ahora: () => number,
): Promise<void> {
  for (;;) {
    const tomado = await db.transaction('rw', db.candados, async () => {
      const actual = await db.candados.get(nombre);
      const t = ahora();
      if (actual !== undefined && actual.expira_at > t && actual.titular !== titular) {
        return false;
      }
      await db.candados.put({ nombre, titular, expira_at: t + duracionMs });
      return true;
    });
    if (tomado) {
      return;
    }
    await esperar(intervaloMs);
  }
}

async function soltarEnIndexedDb(nombre: string, titular: string): Promise<void> {
  await db.transaction('rw', db.candados, async () => {
    const actual = await db.candados.get(nombre);
    if (actual?.titular === titular) {
      await db.candados.delete(nombre);
    }
  });
}

/**
 * Extiende la vida del candado si `titular` todavía lo tiene. Devuelve `false` si ya es de otro
 * (venció y otra pestaña lo tomó): entonces no se pisa.
 */
async function renovarEnIndexedDb(
  nombre: string,
  titular: string,
  duracionMs: number,
  ahora: () => number,
): Promise<boolean> {
  return db.transaction('rw', db.candados, async () => {
    const actual = await db.candados.get(nombre);
    if (actual?.titular !== titular) {
      return false;
    }
    await db.candados.put({ nombre, titular, expira_at: ahora() + duracionMs });
    return true;
  });
}

async function conCandadoAlternativo<T>(
  nombre: string,
  tarea: () => Promise<T>,
  opciones: OpcionesCandado,
): Promise<T> {
  const titular = uuidv7();
  const duracionMs = opciones.duracionMs ?? DURACION_MS;
  const ahora = opciones.ahora ?? Date.now;
  await tomarEnIndexedDb(nombre, titular, duracionMs, opciones.intervaloMs ?? INTERVALO_MS, ahora);
  // B10: latido. Mientras la tarea sigue, el candado se renueva cada tercio de su vida: una sync
  // larga no lo pierde y otra pestaña no entra a la vez. Si la pestaña se cierra, el latido muere
  // con ella y el candado vence solo. Con los temporizadores frenados de una pestaña en segundo
  // plano (≥ 1 por minuto), el tercio de 120 s sigue dejando margen.
  let renovacion: Promise<unknown> = Promise.resolve();
  const latido = setInterval(
    () => {
      renovacion = renovacion
        .then(() => renovarEnIndexedDb(nombre, titular, duracionMs, ahora))
        .then((sigue) => {
          if (!sigue) {
            // Ya es de otro titular: no se renueva más (el motor tolera perder un lote, B10).
            clearInterval(latido);
          }
        })
        .catch(() => undefined);
    },
    Math.max(1, Math.floor(duracionMs / 3)),
  );
  try {
    return await tarea();
  } finally {
    clearInterval(latido);
    await renovacion;
    await soltarEnIndexedDb(nombre, titular);
  }
}

/** Ejecuta `tarea` con el candado exclusivo `nombre`. */
export function conCandado<T>(
  nombre: string,
  tarea: () => Promise<T>,
  opciones: OpcionesCandado = {},
): Promise<T> {
  const locks = opciones.locks === undefined ? webLocksDisponibles() : opciones.locks;
  if (locks !== null) {
    return locks.request(nombre, tarea);
  }
  const anterior = colasEnMemoria.get(nombre) ?? Promise.resolve();
  const actual = anterior
    .catch(() => undefined)
    .then(() => conCandadoAlternativo(nombre, tarea, opciones));
  const cola = actual.catch(() => undefined);
  colasEnMemoria.set(nombre, cola);
  void cola.then(() => {
    if (colasEnMemoria.get(nombre) === cola) {
      colasEnMemoria.delete(nombre);
    }
  });
  return actual;
}

// Candado exclusivo entre pestañas (docs/spec.md §6; ADR 0008: refresh serializado).
//
// - Con Web Locks (`navigator.locks`), el navegador serializa entre pestañas y libera el candado si
//   la pestaña se cierra.
// - Sin Web Locks (navegadores viejos): cola en memoria (serializa dentro de la pestaña) + candado en
//   IndexedDB con expiración (entre pestañas). La expiración evita que una pestaña cerrada a mitad
//   del refresh bloquee a las demás para siempre.

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

async function conCandadoAlternativo<T>(
  nombre: string,
  tarea: () => Promise<T>,
  opciones: OpcionesCandado,
): Promise<T> {
  const titular = uuidv7();
  await tomarEnIndexedDb(
    nombre,
    titular,
    opciones.duracionMs ?? DURACION_MS,
    opciones.intervaloMs ?? INTERVALO_MS,
    opciones.ahora ?? Date.now,
  );
  try {
    return await tarea();
  } finally {
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../datos/db';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { conCandado, webLocksDisponibles } from './candado';
import { locksFalsos } from './pruebas/servidor-falso';

function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(async () => {
  await limpiarDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conCandado con Web Locks', () => {
  it('delega en navigator.locks', async () => {
    const locks = locksFalsos();
    expect(await conCandado('x', () => Promise.resolve(42), { locks })).toBe(42);
    expect(locks.solicitudes).toEqual(['x']);
    expect(await db.candados.count()).toBe(0);
  });

  it('detecta navigator.locks', async () => {
    expect(webLocksDisponibles()).toBeNull();
    const request = vi.fn((_nombre: string, cb: () => Promise<unknown>) => cb());
    vi.stubGlobal('navigator', { locks: { request } });
    const detectado = webLocksDisponibles();
    expect(detectado).not.toBeNull();
    expect(await conCandado('y', () => Promise.resolve('ok'))).toBe('ok');
    expect(request).toHaveBeenCalledWith('y', expect.any(Function));
  });
});

describe('conCandado alternativo (memoria + IndexedDB)', () => {
  it('serializa las tareas de la pestaña y libera el candado', async () => {
    let activas = 0;
    let maximo = 0;
    const tarea = async (): Promise<number> => {
      activas += 1;
      maximo = Math.max(maximo, activas);
      await esperar(5);
      activas -= 1;
      return activas;
    };
    await Promise.all([1, 2, 3].map(() => conCandado('r', tarea, { locks: null, intervaloMs: 1 })));
    expect(maximo).toBe(1);
    expect(await db.candados.get('r')).toBeUndefined();
  });

  it('libera el candado aunque la tarea falle, y la siguiente sigue', async () => {
    await expect(
      conCandado('f', () => Promise.reject(new Error('fallo')), { locks: null }),
    ).rejects.toThrow('fallo');
    expect(await db.candados.get('f')).toBeUndefined();
    expect(await conCandado('f', () => Promise.resolve('sigue'), { locks: null })).toBe('sigue');
  });

  it('espera mientras otra pestaña tiene el candado y entra cuando lo suelta', async () => {
    // Otra pestaña (otro titular) tiene el candado vigente.
    await db.candados.put({ nombre: 'p', titular: 'otra-pestana', expira_at: Date.now() + 60_000 });
    let entro = false;
    const espera = conCandado(
      'p',
      () => {
        entro = true;
        return Promise.resolve();
      },
      { locks: null, intervaloMs: 2 },
    );
    await esperar(20);
    expect(entro).toBe(false);
    await db.candados.delete('p');
    await espera;
    expect(entro).toBe(true);
  });

  it('toma un candado vencido (pestaña cerrada a mitad del refresh)', async () => {
    let reloj = 1_000;
    await db.candados.put({ nombre: 'v', titular: 'pestana-cerrada', expira_at: 1_500 });
    const espera = conCandado('v', () => Promise.resolve('tomado'), {
      locks: null,
      intervaloMs: 2,
      duracionMs: 100,
      ahora: () => reloj,
    });
    await esperar(10);
    reloj = 1_500;
    expect(await espera).toBe('tomado');
  });

  it('no suelta un candado que ya tomó otro titular', async () => {
    await conCandado(
      'o',
      async () => {
        // Mientras tanto venció y otra pestaña lo tomó.
        await db.candados.put({ nombre: 'o', titular: 'otra', expira_at: Date.now() + 60_000 });
      },
      { locks: null },
    );
    expect(await db.candados.get('o')).toMatchObject({ titular: 'otra' });
  });
});

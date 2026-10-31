import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { solicitarPersistencia } from './almacenamiento';
import {
  iniciarDisparadores,
  MENSAJE_SYNC,
  registrarBackgroundSync,
  TAG_BACKGROUND_SYNC,
  type Disparadores,
} from './disparadores';
import {
  AVISO_PERSISTENCIA,
  crearStoreEstadoSync,
  estadoSyncInicial,
  requiereAvisoPersistencia,
  textoIndicador,
  type StoreEstadoSync,
} from './estado';
import type { MotivoSync, ResumenSync } from './motor';

class Emisor extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

let motivos: MotivoSync[];
let estado: StoreEstadoSync;
let ventana: Emisor;
let documento: Emisor;
let sw: Emisor;
let hay: boolean;
let d: Disparadores | null;

const motor = {
  sincronizar: (motivo: MotivoSync) => {
    motivos.push(motivo);
    return Promise.resolve({ motivo } as ResumenSync);
  },
};

function iniciar(extra: Partial<Parameters<typeof iniciarDisparadores>[0]> = {}): Disparadores {
  d = iniciarDisparadores({
    motor,
    estado,
    hayPendientes: () => Promise.resolve(hay),
    ventana,
    documento,
    serviceWorker: sw,
    intervaloMs: 60_000,
    esperaMs: 1_000,
    ...extra,
  });
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  motivos = [];
  estado = crearStoreEstadoSync();
  ventana = new Emisor();
  documento = new Emisor();
  sw = new Emisor();
  hay = false;
  d = null;
});

afterEach(() => {
  d?.detener();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('disparadores', () => {
  it('apertura de la app, agrupando disparos seguidos', async () => {
    iniciar();
    ventana.dispatchEvent(new Event('online'));
    documento.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(motivos).toEqual(['apertura']);
  });

  it('online, visible, mensaje del Service Worker y cambio local', async () => {
    const contar = vi.fn(() => Promise.resolve());
    const disparadores = iniciar({ actualizarContadores: contar });
    await vi.advanceTimersByTimeAsync(1_000);

    ventana.dispatchEvent(new Event('offline'));
    expect(estado.getState().conexion).toBe('sin_conexion');
    ventana.dispatchEvent(new Event('online'));
    expect(estado.getState().conexion).toBe('en_linea');
    await vi.advanceTimersByTimeAsync(1_000);

    documento.visibilityState = 'hidden';
    documento.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    documento.visibilityState = 'visible';
    documento.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);

    sw.dispatchEvent(new MessageEvent('message', { data: { tipo: 'otro' } }));
    sw.dispatchEvent(new MessageEvent('message', { data: 'texto' }));
    await vi.advanceTimersByTimeAsync(1_000);
    sw.dispatchEvent(new MessageEvent('message', { data: { tipo: MENSAJE_SYNC } }));
    await vi.advanceTimersByTimeAsync(1_000);

    disparadores.cambioLocal();
    expect(contar).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(motivos).toEqual(['apertura', 'online', 'visible', 'background', 'local']);
  });

  it('cada 60 s solo si hay pendientes', async () => {
    iniciar();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(motivos).toEqual(['apertura']);
    hay = true;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(motivos).toEqual(['apertura', 'intervalo']);
  });

  it('"Sincronizar ahora" es inmediato; detener limpia todo', async () => {
    const disparadores = iniciar();
    await disparadores.sincronizarAhora();
    expect(motivos).toEqual(['manual']);
    disparadores.detener();
    ventana.dispatchEvent(new Event('online'));
    disparadores.programar('local');
    hay = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(motivos).toEqual(['manual']);
  });

  it('un error del motor se informa y no rompe los disparadores', async () => {
    const alError = vi.fn();
    const fallido = { sincronizar: () => Promise.reject(new Error('defecto')) };
    const disparadores = iniciar({
      motor: fallido,
      alError,
      hayPendientes: () => Promise.reject(new Error('idb')),
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(alError).toHaveBeenCalledTimes(2);
    await expect(disparadores.sincronizarAhora()).rejects.toThrow('defecto');
  });

  it('usa window, document y navigator.serviceWorker por defecto', async () => {
    d = iniciarDisparadores({ motor, estado, hayPendientes: () => Promise.resolve(false) });
    await vi.advanceTimersByTimeAsync(1_500);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(motivos).toEqual(['apertura', 'online']);
  });
});

describe('Background Sync', () => {
  it('registra la etiqueta donde existe y devuelve false donde no', async () => {
    const register = vi.fn(() => Promise.resolve());
    expect(await registrarBackgroundSync({ sync: { register } })).toBe(true);
    expect(register).toHaveBeenCalledWith(TAG_BACKGROUND_SYNC);
    expect(await registrarBackgroundSync({})).toBe(false);
    expect(await registrarBackgroundSync(null)).toBe(false);
    expect(
      await registrarBackgroundSync({ sync: { register: () => Promise.reject(new Error('no')) } }),
    ).toBe(false);
    // jsdom no tiene Service Worker.
    expect(await registrarBackgroundSync()).toBe(false);
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({ sync: { register } }) },
    });
    expect(await registrarBackgroundSync()).toBe(true);
  });
});

describe('indicador global y persistencia', () => {
  it('textos del indicador en cada estado', () => {
    const base = estadoSyncInicial();
    expect(textoIndicador(base)).toBe('En línea · Todo sincronizado');
    expect(textoIndicador({ ...base, pendientes: 2, fotosPendientes: 1 })).toBe(
      'En línea · 3 por sincronizar',
    );
    expect(textoIndicador({ ...base, conexion: 'sin_conexion', pendientes: 4 })).toBe(
      'Sin conexión · 4 por sincronizar',
    );
    expect(textoIndicador({ ...base, conexion: 'sin_conexion' })).toBe(
      'Sin conexión · Todo sincronizado',
    );
    expect(textoIndicador({ ...base, sincronizando: true, pendientes: 4 })).toBe('Sincronizando…');
  });

  it('estado inicial según navigator.onLine', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(estadoSyncInicial().conexion).toBe('sin_conexion');
  });

  it('persist() concedido, ya persistido, denegado, inexistente o con error', async () => {
    expect(await solicitarPersistencia(estado, { persist: () => Promise.resolve(true) })).toBe(
      'concedida',
    );
    expect(requiereAvisoPersistencia(estado.getState())).toBe(false);
    expect(
      await solicitarPersistencia(estado, {
        persisted: () => Promise.resolve(true),
        persist: () => Promise.reject(new Error('no debe llamarse')),
      }),
    ).toBe('concedida');

    expect(await solicitarPersistencia(estado, { persist: () => Promise.resolve(false) })).toBe(
      'denegada',
    );
    expect(estado.getState().persistencia).toBe('denegada');
    expect(requiereAvisoPersistencia(estado.getState())).toBe(true);
    expect(AVISO_PERSISTENCIA).toBe('Sincroniza al menos una vez al día');

    expect(await solicitarPersistencia(estado, {})).toBe('no_disponible');
    expect(await solicitarPersistencia(estado, undefined)).toBe('no_disponible');
    expect(
      await solicitarPersistencia(estado, { persist: () => Promise.reject(new Error('x')) }),
    ).toBe('no_disponible');
    expect(requiereAvisoPersistencia(estado.getState())).toBe(true);
  });
});

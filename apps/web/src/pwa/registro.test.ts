import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearStoreEstadoPwa, registrarServiceWorker } from './registro';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function registrar(enLinea = true) {
  const store = crearStoreEstadoPwa();
  let opciones: RegisterSWOptions = {};
  const actualizarSW = vi.fn(() => Promise.resolve());
  const registerSW = vi.fn((o: RegisterSWOptions) => {
    opciones = o;
    return actualizarSW;
  });
  const alError = vi.fn();
  registrarServiceWorker(registerSW, {
    store,
    intervaloMs: 1_000,
    enLinea: () => enLinea,
    alError,
  });
  return { store, opciones: () => opciones, actualizarSW, registerSW, alError };
}

describe('registro del Service Worker', () => {
  it('registra de inmediato y avisa cuando hay versión nueva o queda listo sin conexión', () => {
    const { store, opciones, registerSW } = registrar();
    expect(registerSW).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
    expect(store.getState().actualizacionDisponible).toBe(false);

    opciones().onNeedRefresh?.();
    expect(store.getState().actualizacionDisponible).toBe(true);

    opciones().onOfflineReady?.();
    expect(store.getState().listaSinConexion).toBe(true);
  });

  it('"Actualizar" activa la versión nueva y recarga', async () => {
    const { store, actualizarSW } = registrar();
    await store.getState().actualizar?.();
    expect(actualizarSW).toHaveBeenCalledWith(true);
  });

  it('busca actualizaciones periódicamente solo con conexión', () => {
    const update = vi.fn(() => Promise.resolve());
    const conRed = registrar(true);
    conRed.opciones().onRegisteredSW?.('/sw.js', {
      update,
      installing: null,
    } as unknown as ServiceWorkerRegistration);
    vi.advanceTimersByTime(1_000);
    expect(update).toHaveBeenCalledTimes(1);

    const updateSinRed = vi.fn(() => Promise.resolve());
    const sinRed = registrar(false);
    sinRed.opciones().onRegisteredSW?.('/sw.js', {
      update: updateSinRed,
      installing: null,
    } as unknown as ServiceWorkerRegistration);
    vi.advanceTimersByTime(3_000);
    expect(updateSinRed).not.toHaveBeenCalled();
  });

  it('informa los errores de registro', () => {
    const { opciones, alError } = registrar();
    opciones().onRegisterError?.(new Error('sin https'));
    expect(alError).toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearStoreEstadoSync, type Sincronizacion } from '../sync';
import {
  arrancar,
  obtenerSincronizacion,
  reiniciarSincronizacionParaPruebas,
  vigilarBackgroundSync,
} from './arranque';
import { crearStoreArranque } from './estado-arranque';

function syncFalsa(): Sincronizacion {
  return {
    detener: vi.fn(),
    sincronizarAhora: vi.fn(),
    cambioLocal: vi.fn(),
    programar: vi.fn(),
  } as unknown as Sincronizacion;
}

afterEach(() => {
  reiniciarSincronizacionParaPruebas();
});

describe('arranque', () => {
  it('crea el motor de sync una sola vez', () => {
    const iniciar = vi.fn(syncFalsa);
    const primera = obtenerSincronizacion(iniciar);
    expect(obtenerSincronizacion(iniciar)).toBe(primera);
    expect(iniciar).toHaveBeenCalledTimes(1);
  });

  it('inicia la sync antes de restaurar la sesión, registra el SW y marca el arranque listo', async () => {
    const orden: string[] = [];
    const arranque = crearStoreArranque();
    const sync = await arrancar({
      iniciar: () => {
        orden.push('sync');
        return syncFalsa();
      },
      registrarServiceWorker: () => orden.push('sw'),
      sesion: {
        restaurar: () => {
          orden.push('restaurar');
          expect(arranque.getState().listo).toBe(false);
          return Promise.resolve();
        },
      },
      arranque,
      estadoSync: crearStoreEstadoSync(),
      registrarBackgroundSync: () => Promise.resolve(true),
    });
    expect(orden).toEqual(['sync', 'sw', 'restaurar']);
    expect(arranque.getState().listo).toBe(true);
    expect(obtenerSincronizacion()).toBe(sync);
  });

  it('si restaurar o el SW fallan, la app arranca igual (sin sesión)', async () => {
    const arranque = crearStoreArranque();
    const alError = vi.fn();
    await arrancar({
      iniciar: syncFalsa,
      registrarServiceWorker: () => {
        throw new Error('SW no soportado');
      },
      sesion: { restaurar: () => Promise.reject(new Error('red')) },
      arranque,
      estadoSync: crearStoreEstadoSync(),
      registrarBackgroundSync: () => Promise.resolve(false),
      alError,
    });
    expect(arranque.getState().listo).toBe(true);
    expect(alError).toHaveBeenCalledTimes(2);
  });
});

describe('Background Sync', () => {
  it('se pide al quedar sin conexión con pendientes (una vez por transición)', () => {
    const estado = crearStoreEstadoSync();
    estado.setState({ conexion: 'en_linea', pendientes: 0, fotosPendientes: 0 });
    const registrar = vi.fn(() => Promise.resolve(true));
    const dejar = vigilarBackgroundSync(estado, registrar);
    expect(registrar).not.toHaveBeenCalled();

    estado.setState({ pendientes: 2 });
    expect(registrar).not.toHaveBeenCalled();

    estado.setState({ conexion: 'sin_conexion' });
    expect(registrar).toHaveBeenCalledTimes(1);

    estado.setState({ pendientes: 3 });
    expect(registrar).toHaveBeenCalledTimes(1);

    estado.setState({ conexion: 'en_linea' });
    estado.setState({ conexion: 'sin_conexion' });
    expect(registrar).toHaveBeenCalledTimes(2);

    dejar();
    estado.setState({ conexion: 'en_linea' });
    estado.setState({ conexion: 'sin_conexion' });
    expect(registrar).toHaveBeenCalledTimes(2);
  });

  it('se pide al arrancar si ya está sin conexión con fotos pendientes', () => {
    const estado = crearStoreEstadoSync();
    estado.setState({ conexion: 'sin_conexion', pendientes: 0, fotosPendientes: 1 });
    const registrar = vi.fn(() => Promise.resolve(true));
    vigilarBackgroundSync(estado, registrar)();
    expect(registrar).toHaveBeenCalledTimes(1);
  });
});

import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_SIN_SESION, type EstadoSesion } from '../auth';
import { crearStoreEstadoSync, type Sincronizacion } from '../sync';
import {
  arrancar,
  obtenerSincronizacion,
  reiniciarSincronizacionParaPruebas,
  vigilarBackgroundSync,
} from './arranque';
import { crearStoreArranque } from './estado-arranque';
import { INTERVALO_RETENCION_MS } from './retencion-periodica';

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

  it('aplica la retención de la tablet ANTES de restaurar y vigila la inactividad después (ADR 0017)', async () => {
    const orden: string[] = [];
    const arranque = crearStoreArranque();
    await arrancar({
      iniciar: syncFalsa,
      aplicarRetencion: () => {
        orden.push('retencion');
        expect(arranque.getState().listo).toBe(false);
        return Promise.resolve();
      },
      sesion: {
        restaurar: () => {
          orden.push('restaurar');
          return Promise.resolve();
        },
      },
      vigilarInactividad: () => {
        orden.push('inactividad');
        return () => undefined;
      },
      arranque,
      estadoSync: crearStoreEstadoSync(),
      registrarBackgroundSync: () => Promise.resolve(true),
    });
    expect(orden).toEqual(['retencion', 'restaurar', 'inactividad']);
    expect(arranque.getState().listo).toBe(true);
  });

  it('si la retención o la vigilancia fallan, la app arranca igual', async () => {
    const arranque = crearStoreArranque();
    const alError = vi.fn();
    const restaurar = vi.fn(() => Promise.resolve());
    await arrancar({
      iniciar: syncFalsa,
      aplicarRetencion: () => Promise.reject(new Error('IndexedDB')),
      sesion: { restaurar },
      vigilarInactividad: () => {
        throw new Error('sin document');
      },
      arranque,
      estadoSync: crearStoreEstadoSync(),
      registrarBackgroundSync: () => Promise.resolve(false),
      alError,
    });
    expect(restaurar).toHaveBeenCalledTimes(1);
    expect(arranque.getState().listo).toBe(true);
    expect(alError).toHaveBeenCalledTimes(2);
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

describe('vigilancias de la sesión en el arranque (F6-04, F6-07)', () => {
  function sesionFalsa() {
    let usuario: Perfil | null = null;
    const oyentes = new Set<(estado: EstadoSesion) => void>();
    return {
      usuarioDeLaSesion: () => usuario,
      suscribir(oyente: (estado: EstadoSesion) => void) {
        oyentes.add(oyente);
        return () => oyentes.delete(oyente);
      },
      publicar(nuevo: Perfil | null) {
        usuario = nuevo;
        for (const oyente of oyentes) {
          oyente({ ...ESTADO_SIN_SESION, usuario, modo: nuevo === null ? 'sin_sesion' : 'online' });
        }
      },
    };
  }

  function perfil(): Perfil {
    const id = uuidv7();
    return {
      id,
      nombre: 'Beto Ruiz',
      email: `beto.${id.slice(-6)}@catmetal.test`,
      rol: 'jefe',
      permisos: permisosDeRol('jefe'),
    };
  }

  it('vacía la caché al cambiar de usuario y aplica la retención a diario y al cerrar sesión', async () => {
    let reloj = 0;
    let revisar: () => void = () => undefined;
    const sesion = sesionFalsa();
    const cache = { clear: vi.fn() };
    const aplicarRetencion = vi.fn<(opciones: { excluir: string | null }) => Promise<unknown>>(() =>
      Promise.resolve(),
    );
    await arrancar({
      iniciar: syncFalsa,
      sesion: { restaurar: () => Promise.resolve() },
      sesionObservada: sesion,
      cacheConsultas: cache,
      aplicarRetencion,
      temporizadoresRetencion: {
        setInterval: (callback) => {
          revisar = callback;
          return 1;
        },
        clearInterval: () => {
          revisar = () => undefined;
        },
      },
      ahora: () => reloj,
      vigilarInactividad: () => () => undefined,
      arranque: crearStoreArranque(),
      estadoSync: crearStoreEstadoSync(),
      registrarBackgroundSync: () => Promise.resolve(true),
    });
    expect(aplicarRetencion).toHaveBeenCalledExactlyOnceWith({ excluir: null });

    const beto = perfil();
    sesion.publicar(beto);
    expect(cache.clear).toHaveBeenCalledTimes(1);

    // Un día con la app abierta: se aplica sin tocar al usuario de la sesión.
    reloj += INTERVALO_RETENCION_MS;
    revisar();
    await vi.waitFor(() => expect(aplicarRetencion).toHaveBeenCalledTimes(2));
    expect(aplicarRetencion).toHaveBeenLastCalledWith({ excluir: beto.id });

    sesion.publicar(null);
    expect(cache.clear).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(aplicarRetencion).toHaveBeenCalledTimes(3));
    expect(aplicarRetencion).toHaveBeenLastCalledWith({ excluir: null });

    // Al reiniciar (pruebas) se detienen: ni caché ni retención reaccionan.
    reiniciarSincronizacionParaPruebas();
    sesion.publicar(perfil());
    reloj += INTERVALO_RETENCION_MS;
    revisar();
    sesion.publicar(null);
    await Promise.resolve();
    expect(cache.clear).toHaveBeenCalledTimes(2);
    expect(aplicarRetencion).toHaveBeenCalledTimes(3);
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

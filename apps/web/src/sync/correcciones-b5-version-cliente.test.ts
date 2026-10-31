// B5 (cliente; ADR 0026, servidor en 2a81cf2): toda petición a `/api/v1` lleva
// `X-Version-Cliente: <VERSION_CLIENTE>`. Ante 426 `CLIENTE_DESACTUALIZADO` (de la petición
// entera, no de una mutación) el motor se detiene sin tocar ninguna mutación ni foto, y la app pide
// la actualización forzada del Service Worker.

import {
  CABECERA_VERSION_CLIENTE,
  permisosDeRol,
  uuidv7,
  VERSION_CLIENTE,
  type Perfil,
} from '@catmetal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearClienteApi, ErrorApi } from '../auth/cliente-api';
import { crearServidorFalso } from '../auth/pruebas/servidor-falso';
import { GestorSesion } from '../auth/sesion';
import { db } from '../datos/db';
import { registrarConsumoConNovedadLocal, registrarConsumoLocal } from '../datos/outbox';
import { fotoDe, guardarPerfil, limpiarDb } from '../datos/pruebas/fabricas';
import { descargarAutenticado } from '../features/validacion/descarga';
import { useEstadoPwa } from '../pwa/registro';
import { crearStoreEstadoSync } from './estado';
import { MotorSync } from './motor';
import { crearServidorSync, type ServidorSync } from './pruebas/servidor-sync';
import { sesionFalsa } from './pruebas/sesion-falsa';

const VERSION = String(VERSION_CLIENTE);
let servidor: ServidorSync;
let ana: Perfil;
const estadoPwaInicial = useEstadoPwa.getState();

function motor(): MotorSync {
  return new MotorSync({
    sesion: sesionFalsa(servidor, ana),
    estado: crearStoreEstadoSync(),
    locks: null,
    aleatorio: () => 0,
    candado: { intervaloMs: 2 },
  });
}

function consumo() {
  return {
    order_id: uuidv7(),
    material_id: uuidv7(),
    cantidad: 2,
    unidad: 'kg' as const,
    lote: 'L',
  };
}

/** Lo que importa de cada mutación y foto para "no se tocó nada". */
async function fotoDelOutbox() {
  const mutaciones = (await db.outbox.orderBy('seq_local').toArray()).map((m) => ({
    mutation_id: m.mutation_id,
    estado: m.estado,
    intentos: m.intentos,
    siguiente_intento_at: m.siguiente_intento_at,
    error: m.error,
    payload: m.payload,
  }));
  const fotos = (await db.evidencias.toArray()).map((e) => ({
    id: e.id,
    estado_subida: e.estado_subida,
    intentos_subida: e.intentos_subida,
    siguiente_intento_at: e.siguiente_intento_at,
    error_subida: e.error_subida,
    bytes: e.datos?.byteLength ?? null,
  }));
  return { mutaciones, fotos };
}

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorSync();
  const id = uuidv7();
  ana = {
    id,
    nombre: 'Ana',
    email: `${id}@catmetal.co`,
    rol: 'supervisor',
    permisos: permisosDeRol('supervisor'),
  };
  await guardarPerfil(ana.id, ana.nombre);
  useEstadoPwa.setState(estadoPwaInicial, true);
});

afterEach(() => {
  useEstadoPwa.setState(estadoPwaInicial, true);
  vi.unstubAllGlobals();
});

describe('B5: X-Version-Cliente en toda petición', () => {
  it('push, pull, snapshot y subida de fotos del motor', async () => {
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('abc'),
    ]);
    const resumen = await motor().sincronizar('manual');
    expect(resumen).toMatchObject({ error: null, fotos_subidas: 1 });
    const rutas = new Set(servidor.peticiones.map((p) => p.ruta));
    expect(rutas).toEqual(
      new Set([
        '/api/v1/sync/push',
        '/api/v1/sync/snapshot',
        '/api/v1/sync/pull',
        expect.stringMatching(/^\/api\/v1\/evidences\//) as unknown as string,
      ]),
    );
    expect(servidor.peticiones.map((p) => p.version_cliente)).toEqual(
      servidor.peticiones.map(() => VERSION),
    );
  });

  it('REST: GET/POST con y sin autenticar, con bearer explícito y en el reintento tras un 401', async () => {
    const versiones: (string | null)[] = [];
    let n = 0;
    const api = crearClienteApi({
      fetch: (_entrada, init) => {
        versiones.push(new Headers(init?.headers).get(CABECERA_VERSION_CLIENTE));
        n += 1;
        return Promise.resolve(
          n === 3
            ? new Response(JSON.stringify({ code: 'NO_AUTENTICADO', message: 'x' }), {
                status: 401,
              })
            : new Response('{}', { status: 200 }),
        );
      },
      proveedor: {
        obtenerAccessToken: () => Promise.resolve('t1'),
        refrescar: () => Promise.resolve('t2'),
      },
    });
    await api.peticion('/orders');
    await api.peticion('/auth/login', { metodo: 'POST', autenticar: false, cuerpo: {} });
    await api.peticion('/consumptions', { metodo: 'POST', cuerpo: {} });
    await api.peticion('/auth/logout', { metodo: 'POST', bearer: 'b', credenciales: 'omit' });
    expect(versiones).toEqual([VERSION, VERSION, VERSION, VERSION, VERSION]);
  });

  it('login, refresh y logout de la sesión', async () => {
    const auth = crearServidorFalso();
    auth.agregarUsuario('Beto', 'beto@catmetal.co', 'clave-beto-1');
    const sesion = new GestorSesion({
      fetch: auth.fetch,
      locks: null,
      iteraciones: 1_000,
      iteracionesMinimas: 1_000,
      enLinea: () => true,
    });
    await sesion.iniciarSesion('beto@catmetal.co', 'clave-beto-1');
    await sesion.refrescar();
    await sesion.cerrarSesion();
    expect(auth.peticiones.map((p) => p.ruta)).toEqual(
      expect.arrayContaining(['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout']),
    );
    expect(auth.peticiones.every((p) => p.version_cliente === VERSION)).toBe(true);
  });

  it('descarga autenticada de evidencias y CSV', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('csv', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetch);
    await descargarAutenticado('/reports/x.csv', {
      obtenerAccessToken: () => Promise.resolve('t'),
      refrescar: () => Promise.resolve(null),
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get(CABECERA_VERSION_CLIENTE)).toBe(
      VERSION,
    );
  });
});

describe('B5: 426 CLIENTE_DESACTUALIZADO', () => {
  it('en el push: el outbox y las fotos quedan exactamente igual, nada se rechaza y se pide actualizar', async () => {
    const forzar = vi.fn(() => Promise.resolve());
    useEstadoPwa.setState({ forzarActualizacion: forzar });
    await registrarConsumoLocal(ana.id, consumo());
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('foto'),
    ]);
    const antes = await fotoDelOutbox();
    servidor.versionMinima = VERSION_CLIENTE + 1;

    const resumen = await motor().sincronizar('manual');
    expect(resumen).toMatchObject({
      ejecutada: true,
      enviadas: 0,
      aplicadas: 0,
      rechazadas: 0,
      conflictos: 0,
      sin_resultado: 0,
      siguiente_intento_at: null,
      fotos_con_error: 0,
      error: { code: 'CLIENTE_DESACTUALIZADO' },
    });
    expect(await fotoDelOutbox()).toEqual(antes);
    expect(antes.mutaciones.every((m) => m.estado === 'pendiente')).toBe(true);
    // Se detuvo: ni pull, ni snapshot, ni fotos después del 426.
    expect(servidor.peticiones.map((p) => p.ruta)).toEqual(['/api/v1/sync/push']);
    // Se pidió la actualización forzada.
    expect(useEstadoPwa.getState()).toMatchObject({ desactualizado: true, versionMinima: 3 });
    expect(forzar).toHaveBeenCalledTimes(1);

    // Con la app actualizada (o la mínima de vuelta), todo sale: no se perdió nada.
    servidor.versionMinima = 1;
    const despues = await motor().sincronizar('manual');
    expect(despues).toMatchObject({ error: null, aplicadas: 3, rechazadas: 0, fotos_subidas: 1 });
  });

  it('en la subida de fotos: la foto no cuenta un intento ni entra en espera', async () => {
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('foto'),
    ]);
    // Push, snapshot y pull pasan; la mínima sube justo cuando llega el PUT de la foto.
    servidor.alRecibir = (p) => {
      if (p.ruta.startsWith('/api/v1/evidences/')) {
        servidor.versionMinima = VERSION_CLIENTE + 1;
      }
    };
    const resumen = await motor().sincronizar('manual');
    expect(resumen).toMatchObject({
      error: { code: 'CLIENTE_DESACTUALIZADO' },
      fotos_subidas: 0,
      fotos_con_error: 0,
    });
    const [foto] = await db.evidencias.toArray();
    expect(foto).toMatchObject({
      estado_subida: 'pendiente',
      intentos_subida: 0,
      siguiente_intento_at: null,
      error_subida: null,
    });
    expect(useEstadoPwa.getState().desactualizado).toBe(true);
  });

  it('cualquier petición REST con 426 avisa a la app; el error sigue siendo de la petición', async () => {
    const forzar = vi.fn(() => Promise.resolve());
    useEstadoPwa.setState({ forzarActualizacion: forzar });
    const api = crearClienteApi({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: 'CLIENTE_DESACTUALIZADO',
              message: 'x',
              details: { version_minima: 5 },
            }),
            { status: 426 },
          ),
        ),
      proveedor: {
        obtenerAccessToken: () => Promise.resolve('t'),
        refrescar: () => Promise.resolve(null),
      },
    });
    await expect(api.peticion('/orders')).rejects.toSatisfy(
      (e) => e instanceof ErrorApi && e.code === 'CLIENTE_DESACTUALIZADO' && e.status === 426,
    );
    expect(useEstadoPwa.getState()).toMatchObject({ desactualizado: true, versionMinima: 5 });
    expect(forzar).toHaveBeenCalledTimes(1);
  });
});

// A4 (docs/correcciones-v1.2.md; ADR 0026, punto 5 y Enmienda 1): `POST /auth/refresh` sigue
// exigiendo la versión mínima. Si el refresh que el motor hace tras un 401 responde 426
// `CLIENTE_DESACTUALIZADO`, es el mismo caso que un 426 directo del push: la respuesta es de la
// petición entera, no de una mutación. El lote vuelve a `pendiente` SIN contar el intento ni aplicar
// espera, el motor se detiene y la app pide la actualización. La sesión NO se pierde: un 426 no es
// `TOKEN_INVALIDO` (la cookie sigue y la versión nueva hace su propio refresh).
//
// Determinismo: el 426 del refresh y el 401 del push los decide el `fetch` falso (no hay azar ni
// tiempos de red); el reloj de la sesión es fijo y el `aleatorio` del backoff es 0.

import {
  crearError,
  ESTADO_HTTP_POR_CODIGO,
  uuidv7,
  VERSION_CLIENTE,
  type Perfil,
} from '@catmetal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorApi, type OpcionesToken } from '../auth/cliente-api';
import { crearServidorFalso, urlDe, type ServidorFalso } from '../auth/pruebas/servidor-falso';
import { GestorSesion } from '../auth/sesion';
import { db } from '../datos/db';
import { registrarConsumoConNovedadLocal, registrarConsumoLocal } from '../datos/outbox';
import { fotoDe, guardarPerfil, limpiarDb } from '../datos/pruebas/fabricas';
import { useEstadoPwa } from '../pwa/registro';
import { crearStoreEstadoSync } from './estado';
import { MotorSync, type SesionParaSync } from './motor';
import { crearServidorSync, type ServidorSync } from './pruebas/servidor-sync';
import { perfilFalso, sesionFalsa } from './pruebas/sesion-falsa';

const CLAVE = 'clave-segura-ana';
const VERSION_MINIMA = VERSION_CLIENTE + 1;
const AHORA = Date.parse('2026-10-30T12:00:00.000Z');
const estadoPwaInicial = useEstadoPwa.getState();

let auth: ServidorFalso;
let sync: ServidorSync;
/** Desde que se activa, `POST /auth/refresh` responde 426 (la mínima del servidor subió). */
let refresh426: boolean;
/** Rutas pedidas, en orden (auth y sync). */
let rutas: string[];
let forzar: ReturnType<typeof vi.fn<() => Promise<void>>>;

function respuesta426(): Response {
  return new Response(
    JSON.stringify(crearError('CLIENTE_DESACTUALIZADO', { version_minima: VERSION_MINIMA })),
    {
      status: ESTADO_HTTP_POR_CODIGO.CLIENTE_DESACTUALIZADO,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

/**
 * Red de la tablet: `/auth/*` va al servidor de autenticación falso y lo demás al de sync. El token
 * de `auth` (`jwt.…`) no lo entiende el servidor de sync, que responde 401 `NO_AUTENTICADO`: así
 * el motor SIEMPRE refresca tras el primer envío, de forma determinista.
 */
const fetchTablet: typeof fetch = (entrada, init) => {
  const ruta = new URL(urlDe(entrada), 'http://localhost').pathname;
  rutas.push(ruta);
  if (ruta.startsWith('/api/v1/auth/')) {
    if (refresh426 && ruta === '/api/v1/auth/refresh') {
      return Promise.resolve(respuesta426());
    }
    return auth.fetch(entrada, init);
  }
  return sync.fetch(entrada, init);
};

function gestor(): GestorSesion {
  return new GestorSesion({
    fetch: fetchTablet,
    locks: null,
    iteraciones: 1_000,
    iteracionesMinimas: 1_000,
    enLinea: () => true,
    ahora: () => AHORA,
    candado: { intervaloMs: 2 },
  });
}

function motor(sesion: SesionParaSync): MotorSync {
  return new MotorSync({
    sesion,
    estado: crearStoreEstadoSync(),
    locks: null,
    ahora: () => AHORA,
    aleatorio: () => 0,
    candado: { intervaloMs: 2 },
  });
}

function consumo() {
  return {
    order_id: uuidv7(),
    material_id: uuidv7(),
    cantidad: 3,
    unidad: 'kg' as const,
    lote: 'L-A4',
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
  }));
  return { mutaciones, fotos };
}

/** Sesión iniciada con conexión (token vigente en memoria y cookie `mp_refresh` de Ana). */
async function sesionDeAna(): Promise<{ sesion: GestorSesion; ana: Perfil }> {
  const sesion = gestor();
  await sesion.iniciarSesion('ana@catmetal.co', CLAVE);
  const ana = sesion.usuarioDeLaSesion();
  if (ana === null) {
    throw new Error('La sesión de prueba no quedó iniciada.');
  }
  rutas = [];
  return { sesion, ana };
}

beforeEach(async () => {
  await limpiarDb();
  auth = crearServidorFalso();
  auth.agregarUsuario('Ana Gómez', 'ana@catmetal.co', CLAVE);
  sync = crearServidorSync();
  refresh426 = false;
  rutas = [];
  useEstadoPwa.setState(estadoPwaInicial, true);
  forzar = vi.fn(() => Promise.resolve());
  useEstadoPwa.setState({ forzarActualizacion: forzar });
});

afterEach(() => {
  useEstadoPwa.setState(estadoPwaInicial, true);
});

describe('A4: 426 del refresh dentro de una sincronización', () => {
  it('push → 401 → refresh → 426: el lote vuelve a pendiente sin contar el intento ni aplicar espera, se pide actualizar y la sesión sigue', async () => {
    const { sesion, ana } = await sesionDeAna();
    await registrarConsumoLocal(ana.id, consumo());
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('foto-a4'),
    ]);
    const antes = await fotoDelOutbox();
    expect(antes.mutaciones.length).toBeGreaterThan(0);
    expect(antes.mutaciones.every((m) => m.estado === 'pendiente' && m.intentos === 0)).toBe(true);
    refresh426 = true;

    const resumen = await motor(sesion).sincronizar('manual');

    // El mismo resultado que un 426 directo del push (B5).
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
    // Ni el intento ni la espera: el outbox y las fotos quedan exactamente igual.
    expect(await fotoDelOutbox()).toEqual(antes);
    // Se detuvo: ni reintento del push, ni pull, ni snapshot, ni fotos después del 426.
    expect(rutas).toEqual(['/api/v1/sync/push', '/api/v1/auth/refresh']);
    // El flujo de actualización del ADR 0026: aviso bloqueante y búsqueda del SW nuevo.
    expect(useEstadoPwa.getState()).toMatchObject({
      desactualizado: true,
      versionMinima: VERSION_MINIMA,
    });
    expect(forzar).toHaveBeenCalledTimes(1);
    // La sesión no se perdió: un 426 no es TOKEN_INVALIDO.
    expect(sesion.estado()).toMatchObject({
      modo: 'online',
      usuario: { id: ana.id },
      requiere_contrasena: false,
    });
    expect(auth.duenoCookie()).toBe(ana.id);
  });

  it('pull (sin outbox) → 401 → refresh → 426: la sync se detiene con CLIENTE_DESACTUALIZADO, no con NO_AUTENTICADO', async () => {
    const { sesion, ana } = await sesionDeAna();
    refresh426 = true;

    const resumen = await motor(sesion).sincronizar('manual');

    expect(resumen).toMatchObject({
      ejecutada: true,
      user_id: ana.id,
      paginas_snapshot: 0,
      error: { code: 'CLIENTE_DESACTUALIZADO' },
    });
    expect(rutas).toEqual(['/api/v1/sync/snapshot', '/api/v1/auth/refresh']);
    expect(useEstadoPwa.getState().desactualizado).toBe(true);
    expect(sesion.estado()).toMatchObject({ modo: 'online', requiere_contrasena: false });
  });

  it('subida de fotos → 401 → refresh → 426: la foto no cuenta el intento ni entra en espera', async () => {
    // Sesión falsa que cumple el contrato del `GestorSesion`: con `lanzarSiDesactualizado`, el 426
    // del refresh se lanza; sin la marca, `null`.
    const ana = perfilFalso('Ana');
    await guardarPerfil(ana.id, ana.nombre);
    const s = sesionFalsa(sync, ana);
    let token = `tok-${ana.id}`;
    s.obtenerAccessToken = () => Promise.resolve(token);
    const refrescar = vi.fn((ligado: OpcionesToken) =>
      ligado.lanzarSiDesactualizado === true
        ? Promise.reject(
            new ErrorApi('CLIENTE_DESACTUALIZADO', 426, undefined, {
              version_minima: VERSION_MINIMA,
            }),
          )
        : Promise.resolve(null),
    );
    s.refrescar = refrescar;
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('foto-a4'),
    ]);
    // Push, snapshot y pull pasan; el token deja de valer justo antes del PUT de la foto.
    sync.alRecibir = (p) => {
      if (p.ruta === '/api/v1/sync/pull') {
        token = 'tok-invalido';
      }
    };

    const resumen = await motor(s).sincronizar('manual');

    expect(resumen).toMatchObject({
      aplicadas: 2,
      fotos_subidas: 0,
      fotos_con_error: 0,
      error: { code: 'CLIENTE_DESACTUALIZADO' },
    });
    expect(refrescar).toHaveBeenCalledWith({ esperado: ana.id, lanzarSiDesactualizado: true });
    const [foto] = await db.evidencias.toArray();
    expect(foto).toMatchObject({
      estado_subida: 'pendiente',
      intentos_subida: 0,
      siguiente_intento_at: null,
      error_subida: null,
    });
  });
});

describe('A4: contrato de GestorSesion.refrescar ante 426', () => {
  it('sin la marca devuelve null; con la marca lanza CLIENTE_DESACTUALIZADO; un solo refresh y la sesión sigue', async () => {
    const { sesion, ana } = await sesionDeAna();
    refresh426 = true;

    const [sinMarca, conMarca] = await Promise.allSettled([
      sesion.refrescar({ esperado: ana.id }),
      sesion.refrescar({ esperado: ana.id, lanzarSiDesactualizado: true }),
    ]);

    expect(sinMarca).toEqual({ status: 'fulfilled', value: null });
    expect(conMarca.status).toBe('rejected');
    expect(conMarca.status === 'rejected' ? conMarca.reason : null).toSatisfy(
      (e) => e instanceof ErrorApi && e.code === 'CLIENTE_DESACTUALIZADO' && e.status === 426,
    );
    // Compartieron UNA petición de refresh.
    expect(rutas).toEqual(['/api/v1/auth/refresh']);
    expect(sesion.estado()).toMatchObject({
      modo: 'online',
      usuario: { id: ana.id },
      requiere_contrasena: false,
    });
    expect(auth.duenoCookie()).toBe(ana.id);
  });
});

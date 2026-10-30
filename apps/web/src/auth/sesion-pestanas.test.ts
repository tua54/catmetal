// Sesión entre pestañas (ADR 0023, ítem M7): dos `GestorSesion` del mismo origen (dos pestañas)
// comparten el canal de sesión y la cookie del servidor simulado.

import { uuidv7 } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../datos/db';
import { registrarConsumoLocal } from '../datos/outbox';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { crearCanalSesion, type CanalSesion } from './canal-sesion';
import { almacenCompartido, busDifusion } from './pruebas/canal-falso';
import { crearServidorFalso, type ServidorFalso } from './pruebas/servidor-falso';
import { GestorSesion } from './sesion';
import { crearStoreSesion } from './store';

const CLAVE_ANA = 'clave-segura-ana';
const CLAVE_BETO = 'clave-segura-beto';

let servidor: ServidorFalso;
let ana: ReturnType<ServidorFalso['agregarUsuario']>;
let beto: ReturnType<ServidorFalso['agregarUsuario']>;

function pestana(canal: CanalSesion): GestorSesion {
  return new GestorSesion({
    fetch: servidor.fetch,
    locks: null,
    iteraciones: 1_000,
    iteracionesMinimas: 1_000,
    enLinea: () => true,
    candado: { intervaloMs: 5 },
    canal,
  });
}

/** Dos pestañas unidas por el canal indicado, y el canal de una tercera (sin sesión). */
function dosPestanas(tipo: 'broadcast' | 'storage'): [GestorSesion, GestorSesion, CanalSesion] {
  if (tipo === 'broadcast') {
    const bus = busDifusion();
    return [
      pestana(crearCanalSesion({ crearCanal: bus.crearCanal })),
      pestana(crearCanalSesion({ crearCanal: bus.crearCanal })),
      crearCanalSesion({ crearCanal: bus.crearCanal }),
    ];
  }
  const compartido = almacenCompartido();
  return [
    pestana(crearCanalSesion({ crearCanal: null, ...compartido.pestana() })),
    pestana(crearCanalSesion({ crearCanal: null, ...compartido.pestana() })),
    crearCanalSesion({ crearCanal: null, ...compartido.pestana() }),
  ];
}

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorFalso();
  ana = servidor.agregarUsuario('Ana Gómez', 'ana@catmetal.co', CLAVE_ANA);
  beto = servidor.agregarUsuario('Beto Ruiz', 'beto@catmetal.co', CLAVE_BETO, 'jefe');
});

describe.each(['broadcast', 'storage'] as const)('sesión entre pestañas (%s)', (tipo) => {
  it('cerrar sesión en una pestaña saca a la otra al login en el mismo tick, sin borrar sus datos', async () => {
    const [a, b] = dosPestanas(tipo);
    await a.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await b.restaurar();
    expect(b.estado()).toMatchObject({ modo: 'online', usuario: { id: ana.id } });
    const storeB = crearStoreSesion(b);
    const senalB = b.senalDeSesion();
    const pendiente = await registrarConsumoLocal(ana.id, {
      order_id: uuidv7(),
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });

    const cierre = a.cerrarSesion();
    // Antes de que termine la revocación en el servidor, la otra pestaña ya no tiene sesión.
    expect(b.estado()).toMatchObject({ modo: 'sin_sesion', usuario: null });
    expect(storeB.getState()).toMatchObject({ modo: 'sin_sesion', usuario: null });
    expect(senalB.aborted).toBe(true);
    expect(await b.obtenerAccessToken()).toBeNull();
    await cierre;
    // La pestaña que recibe no borra nada: lo pendiente sigue (lo decide quien cerró sesión).
    expect(await db.outbox.get(pendiente.mutation_id)).toMatchObject({ estado: 'pendiente' });
  });

  it('el bloqueo por inactividad bloquea la otra pestaña del mismo usuario', async () => {
    const [a, b] = dosPestanas(tipo);
    await a.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await b.restaurar();
    const senalB = b.senalDeSesion();
    a.bloquear();
    expect(b.estado()).toMatchObject({ usuario: { id: ana.id }, bloqueada: true });
    expect(senalB.aborted).toBe(true);
  });

  it('el bloqueo de otro usuario no afecta a esta pestaña; un cambio al mismo usuario tampoco', async () => {
    const [, b, tercera] = dosPestanas(tipo);
    await b.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    tercera.emitir('bloqueo', beto.id);
    tercera.emitir('cambio-usuario', ana.id);
    expect(b.estado()).toMatchObject({ modo: 'online', usuario: { id: ana.id }, bloqueada: false });
    tercera.emitir('logout', null);
    expect(b.estado()).toMatchObject({ modo: 'sin_sesion', usuario: null });
  });

  it('entrar sin conexión con otro usuario también saca a la otra pestaña', async () => {
    const [a, b] = dosPestanas(tipo);
    await a.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    await b.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(a.estado().usuario).toBeNull();
    await a.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    expect(b.estado().usuario).toBeNull();
    servidor.modo = 'caido';
    await b.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(b.estado()).toMatchObject({ modo: 'offline', usuario: { id: ana.id } });
    expect(a.estado()).toMatchObject({ modo: 'sin_sesion', usuario: null });
  });

  it('si entra otro usuario en una pestaña, la otra vuelve al login; si es el mismo, sigue', async () => {
    const [a, b] = dosPestanas(tipo);
    await a.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await b.restaurar();
    // El mismo usuario vuelve a entrar en la pestaña A: B sigue igual.
    await a.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(b.estado()).toMatchObject({ modo: 'online', usuario: { id: ana.id } });

    await a.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    expect(b.estado()).toMatchObject({ modo: 'sin_sesion', usuario: null });
    expect(a.estado()).toMatchObject({ usuario: { id: beto.id } });
  });

  it('una pestaña sin sesión ignora los avisos', async () => {
    const [a, b] = dosPestanas(tipo);
    await a.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    a.bloquear();
    await a.cerrarSesion();
    expect(b.estado()).toMatchObject({ modo: 'sin_sesion', usuario: null, bloqueada: false });
  });
});

describe('sesión entre pestañas con el BroadcastChannel real', () => {
  it('la otra pestaña descarta la sesión en menos de 2 s', async () => {
    const a = pestana(crearCanalSesion());
    const b = pestana(crearCanalSesion());
    await a.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await b.restaurar();
    expect(b.estado().usuario?.id).toBe(ana.id);
    const inicio = Date.now();
    const descartada = new Promise<number>((resolver) => {
      const desuscribir = b.suscribir((estado) => {
        if (estado.usuario === null) {
          desuscribir();
          resolver(Date.now() - inicio);
        }
      });
    });
    void a.cerrarSesion();
    expect(await descartada).toBeLessThan(2_000);
  });
});

// Pruebas de la tarea 4.7 sobre el motor de sync (revisión de seguridad de la Fase 4, ADR 0017):
// - F4-05: token ligado al usuario del lote, sin auto-refresh ajeno; la sesión se revalida tras
//   cada respuesta y nada se escribe en la partición si cambió; la señal de la sesión corta la sync.
// - F4-12: con una sesión offline (login contra el verificador), al volver la red se intenta
//   recuperar la sesión del servidor del MISMO usuario y se sincroniza.

import { MENSAJES_ERROR, type Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenEsperado } from '../auth/cliente-api';
import { leerMetaSync } from '../datos/aplicar-cambios';
import { db } from '../datos/db';
import { contarPendientes, registrarConsumoLocal } from '../datos/outbox';
import { guardarPerfil, limpiarDb } from '../datos/pruebas/fabricas';
import { crearStoreEstadoSync, type StoreEstadoSync } from './estado';
import { MotorSync, type SesionParaSync } from './motor';
import { crearServidorSync, type ServidorSync } from './pruebas/servidor-sync';
import { perfilFalso, sesionFalsa, type SesionFalsa } from './pruebas/sesion-falsa';

let servidor: ServidorSync;
let estado: StoreEstadoSync;
let ana: Perfil;
let beto: Perfil;

function motor(sesion: SesionParaSync): MotorSync {
  return new MotorSync({
    sesion,
    estado,
    locks: null,
    aleatorio: () => 0,
    candado: { intervaloMs: 2 },
  });
}

function consumo() {
  return {
    order_id: '01900000-0000-7000-8000-000000000001',
    material_id: '01900000-0000-7000-8000-000000000002',
    cantidad: 5,
    unidad: 'kg' as const,
    lote: 'L-1',
  };
}

/** Sesión falsa que, como `GestorSesion`, solo entrega el token del usuario esperado. */
function sesionLigada(usuario: Perfil): SesionFalsa & {
  pedidos: (string | undefined)[];
  control: AbortController;
} {
  const base = sesionFalsa(servidor, usuario);
  const pedidos: (string | undefined)[] = [];
  const control = new AbortController();
  return Object.assign(base, {
    pedidos,
    control,
    senalDeSesion: () => control.signal,
    obtenerAccessToken: (ligado: TokenEsperado = {}) => {
      pedidos.push(ligado.esperado);
      const actual = base.usuario;
      if (
        actual === null ||
        base.modo !== 'online' ||
        base.requiere ||
        (ligado.esperado !== undefined && ligado.esperado !== actual.id)
      ) {
        return Promise.resolve(null);
      }
      return Promise.resolve(`tok-${actual.id}`);
    },
  });
}

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorSync();
  estado = crearStoreEstadoSync();
  ana = perfilFalso('Ana Gómez');
  beto = perfilFalso('Beto Ruiz');
  await guardarPerfil(ana.id, ana.nombre);
});

describe('token ligado al usuario del lote (F4-05)', () => {
  it('cada petición lleva el token de su autor y siempre lo pide ligado a él', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    const resumen = await motor(s).sincronizar('online');
    expect(resumen).toMatchObject({ ejecutada: true, aplicadas: 1, error: null });
    expect(servidor.peticiones.length).toBeGreaterThan(1);
    expect(servidor.peticiones.every((p) => p.user_id === ana.id)).toBe(true);
    expect(s.pedidos.length).toBeGreaterThan(0);
    expect(s.pedidos.every((id) => id === ana.id)).toBe(true);
  });

  it('si la sesión cambia mientras viaja el pull, no se escribe nada en la partición', async () => {
    const s = sesionLigada(ana);
    await motor(s).sincronizar('online'); // snapshot inicial
    const antes = await leerMetaSync(ana.id);
    servidor.upsert('materials', '01900000-0000-7000-8000-0000000000aa', {
      id: '01900000-0000-7000-8000-0000000000aa',
      nombre: 'Arena',
    });
    servidor.alRecibir = (p) => {
      if (p.ruta === '/api/v1/sync/pull') {
        s.usuario = beto; // otra persona inicia sesión en la tablet
      }
    };
    const resumen = await motor(s).sincronizar('manual');
    expect(resumen.error).toMatchObject({ code: 'AUTOR_NO_COINCIDE' });
    expect((await leerMetaSync(ana.id)).cursor).toBe(antes.cursor);
    expect(await db.materiales.count()).toBe(0);
    // Los contadores del indicador son los de la sesión actual (Beto), no los de Ana.
    expect(estado.getState().pendientes).toBe(0);
  });

  it('la señal de la sesión abortada a mitad del push detiene la sync sin aplicar resultados', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    servidor.alRecibir = (p) => {
      if (p.ruta === '/api/v1/sync/push') {
        s.control.abort(); // cerrarSesion empezó
      }
    };
    const resumen = await motor(s).sincronizar('online');
    expect(resumen.error).toMatchObject({ code: 'AUTOR_NO_COINCIDE' });
    expect(servidor.peticiones.map((p) => p.ruta)).toEqual(['/api/v1/sync/push']);
    expect(await db.outbox.where('estado').equals('enviando').count()).toBe(1);
    expect(await contarPendientes(ana.id)).toBe(1);
  });

  it('401: refresca UNA vez ligado al mismo usuario y reintenta con ese token', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    let vigente = 'tok-invalido';
    s.obtenerAccessToken = () => Promise.resolve(vigente);
    const refrescar = vi.fn((ligado: TokenEsperado) => {
      vigente = `tok-${ligado.esperado}`;
      return Promise.resolve(vigente);
    });
    s.refrescar = refrescar;
    const resumen = await motor(s).sincronizar('online');
    expect(resumen).toMatchObject({ aplicadas: 1, error: null });
    expect(refrescar).toHaveBeenCalledTimes(1);
    // A4: el motor pide además que un 426 del refresh se lance (no se confunda con "sin token").
    expect(refrescar).toHaveBeenCalledWith({ esperado: ana.id, lanzarSiDesactualizado: true });
    expect(servidor.pushes()).toHaveLength(2);
  });

  it('401 y el refresh no da token de ese usuario: se detiene sin reintentar', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    s.obtenerAccessToken = () => Promise.resolve('tok-invalido');
    s.refrescar = vi.fn(() => Promise.resolve(null));
    const resumen = await motor(s).sincronizar('online');
    expect(resumen.error).toMatchObject({ code: 'NO_AUTENTICADO' });
    expect(servidor.pushes()).toHaveLength(1);
    expect(await contarPendientes(ana.id)).toBe(1);
  });

  it('SESION_REVOCADA pide la contraseña (el cliente no lo hace con `bearer`)', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    servidor.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: 'SESION_REVOCADA', message: MENSAJES_ERROR.SESION_REVOCADA }),
          { status: 401 },
        ),
      );
    const resumen = await motor(s).sincronizar('online');
    expect(resumen.error).toMatchObject({ code: 'SESION_REVOCADA' });
    expect(s.requiere).toBe(true);
  });

  it('sin token del usuario del lote (la sesión ya es de otra persona) no toca la red', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    // `usuarioDeLaSesion` aún dice Ana, pero el token disponible no es suyo.
    s.obtenerAccessToken = (ligado: TokenEsperado = {}) =>
      Promise.resolve(ligado.esperado === beto.id ? `tok-${beto.id}` : null);
    const resumen = await motor(s).sincronizar('online');
    expect(resumen).toMatchObject({ ejecutada: false, omitida: 'sin_token' });
    expect(servidor.peticiones).toHaveLength(0);
  });
});

describe('revalidación de la identidad antes de cada envío (ADR 0023, M7)', () => {
  it('si la identidad cambia entre armar el lote y enviarlo, no sale nada y el lote queda pendiente', async () => {
    const r = await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    const original = s.obtenerAccessToken.bind(s);
    let llamadas = 0;
    s.obtenerAccessToken = async (ligado: TokenEsperado = {}) => {
      llamadas += 1;
      const token = await original(ligado);
      if (llamadas === 2) {
        // El token del lote ya se pidió; mientras tanto otra pestaña cambió de usuario.
        s.usuario = beto;
      }
      return token;
    };
    const resumen = await motor(s).sincronizar('online');
    expect(resumen.error).toMatchObject({ code: 'AUTOR_NO_COINCIDE' });
    expect(servidor.pushes()).toHaveLength(0);
    // No quedó "enviando": nada salió, así que vuelve a pendiente para cuando Ana regrese.
    expect(await db.outbox.get(r.mutation_id)).toMatchObject({ estado: 'pendiente' });
    expect(await contarPendientes(ana.id)).toBe(1);
  });

  it('si otra pestaña cerró la sesión (sin usuario), no se envía y el lote queda pendiente', async () => {
    const r = await registrarConsumoLocal(ana.id, consumo());
    const s = sesionLigada(ana);
    const original = s.obtenerAccessToken.bind(s);
    let llamadas = 0;
    s.obtenerAccessToken = async (ligado: TokenEsperado = {}) => {
      llamadas += 1;
      const token = await original(ligado);
      if (llamadas === 2) {
        s.usuario = null;
      }
      return token;
    };
    await motor(s).sincronizar('online');
    expect(servidor.pushes()).toHaveLength(0);
    expect(await db.outbox.get(r.mutation_id)).toMatchObject({ estado: 'pendiente' });
  });
});

describe('vuelta a online tras un login offline (F4-12)', () => {
  /** Sesión offline que, al pedir el token, "adopta" la cookie como lo hace `GestorSesion`. */
  function sesionOffline(adopcion: 'mismo' | 'otro' | 'sin_red') {
    const s = sesionLigada(ana);
    s.modo = 'offline';
    const intentos: (string | undefined)[] = [];
    s.obtenerAccessToken = (ligado: TokenEsperado = {}) => {
      intentos.push(ligado.esperado);
      if (s.modo === 'offline') {
        if (adopcion === 'mismo') {
          s.modo = 'online';
        } else if (adopcion === 'otro') {
          s.requiere = true;
        }
      }
      return Promise.resolve(s.modo === 'online' && !s.requiere ? `tok-${ana.id}` : null);
    };
    return Object.assign(s, { intentos });
  }

  it.each(['online', 'visible', 'intervalo'] as const)(
    'con la cookie del mismo usuario pasa a online y sincroniza (%s)',
    async (motivo) => {
      await registrarConsumoLocal(ana.id, consumo());
      const s = sesionOffline('mismo');
      const resumen = await motor(s).sincronizar(motivo);
      expect(resumen).toMatchObject({ ejecutada: true, aplicadas: 1, error: null });
      expect(s.intentos[0]).toBe(ana.id);
      expect(await contarPendientes(ana.id)).toBe(0);
    },
  );

  it('si la cookie es de otra persona queda requiere_contrasena y no envía nada', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionOffline('otro');
    const resumen = await motor(s).sincronizar('online');
    expect(resumen).toMatchObject({ ejecutada: false, omitida: 'requiere_contrasena' });
    expect(servidor.peticiones).toHaveLength(0);
  });

  it('sin red sigue offline; un cambio local no intenta reconectar', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionOffline('sin_red');
    expect(await motor(s).sincronizar('online')).toMatchObject({ omitida: 'offline' });
    expect(s.intentos).toHaveLength(1);
    const local = sesionOffline('mismo');
    expect(await motor(local).sincronizar('local')).toMatchObject({ omitida: 'offline' });
    expect(local.intentos).toHaveLength(0);
  });
});

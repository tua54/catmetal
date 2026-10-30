// A2 (docs/correcciones-v1.2.md; ADR 0023, enmienda 1): el bloqueo por inactividad es del USUARIO
// y no de la pestaña. Una pestaña olvidada en segundo plano nunca bloquea a quien trabaja en otra.
//
// Pruebas deterministas: un solo reloj manual compartido por todas las pestañas (cada una con su
// cola de temporizadores, que se puede congelar como hace el navegador en segundo plano), dos
// `GestorSesion` reales unidos por un canal en memoria y el vigilante real de cada pestaña.

import type { Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { CLAVE_ACTIVIDAD_SESION, crearCanalSesion, type CanalSesion } from './canal-sesion';
import {
  INTERVALO_AVISO_ACTIVIDAD_MS,
  vigilarInactividad,
  type DocumentoVigilado,
  type Temporizadores,
} from './inactividad';
import { almacenCompartido, busDifusion } from './pruebas/canal-falso';
import { crearServidorFalso, type ServidorFalso } from './pruebas/servidor-falso';
import { GestorSesion, LIMITE_INACTIVIDAD_MS } from './sesion';

const SEGUNDO = 1_000;
const MINUTO = 60 * SEGUNDO;
const CLAVE_ANA = 'clave-segura-ana';
const CLAVE_BETO = 'clave-segura-beto';
/** Hora fija de inicio (no depende del reloj real): 30-oct-2026 12:00 UTC. */
const INICIO = Date.UTC(2026, 9, 30, 12, 0, 0);

/** Reloj manual compartido; cada pestaña tiene su cola de temporizadores. */
function relojCompartido(inicio: number) {
  let ahora = inicio;
  let siguienteId = 1;
  const pendientes = new Map<number, { pestana: string; vence: number; callback: () => void }>();
  return {
    ahora: () => ahora,
    temporizadores(pestana: string): Temporizadores {
      return {
        setTimeout(callback, ms) {
          const id = siguienteId++;
          pendientes.set(id, { pestana, vence: ahora + ms, callback });
          return id;
        },
        clearTimeout(id) {
          if (pendientes.get(id as number)?.pestana === pestana) {
            pendientes.delete(id as number);
          }
        },
      };
    },
    /**
     * Avanza el reloj disparando, en orden de vencimiento, los temporizadores vencidos de las
     * pestañas que no están congeladas (las congeladas no disparan: segundo plano).
     */
    avanzar(ms: number, congeladas: readonly string[] = []) {
      const destino = ahora + ms;
      for (;;) {
        const vencido = [...pendientes.entries()]
          .filter(([, t]) => t.vence <= destino && !congeladas.includes(t.pestana))
          .sort((a, b) => a[1].vence - b[1].vence || a[0] - b[0])[0];
        if (vencido === undefined) {
          break;
        }
        pendientes.delete(vencido[0]);
        ahora = Math.max(ahora, vencido[1].vence);
        vencido[1].callback();
      }
      ahora = destino;
    },
    /** Lleva el reloj hasta `instante` (ms desde el inicio). */
    hasta(instante: number, congeladas: readonly string[] = []) {
      this.avanzar(inicio + instante - ahora, congeladas);
    },
  };
}

function documentoFalso() {
  const objetivo = new EventTarget();
  const documento = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (tipo: string, oyente: () => void, opciones?: AddEventListenerOptions) =>
      objetivo.addEventListener(tipo, oyente, opciones),
    removeEventListener: (tipo: string, oyente: () => void, opciones?: EventListenerOptions) =>
      objetivo.removeEventListener(tipo, oyente, opciones),
    emitir(tipo: string) {
      objetivo.dispatchEvent(new Event(tipo));
    },
    ocultar() {
      documento.visibilityState = 'hidden';
      documento.emitir('visibilitychange');
    },
    mostrar() {
      documento.visibilityState = 'visible';
      documento.emitir('visibilitychange');
    },
  };
  return documento satisfies DocumentoVigilado;
}

interface Pestana {
  nombre: string;
  gestor: GestorSesion;
  documento: ReturnType<typeof documentoFalso>;
  /** El usuario toca la pantalla de esta pestaña. */
  tocar(): void;
  dejar(): void;
}

type Modo = 'broadcast' | 'storage';

let servidor: ServidorFalso;
let ana: Perfil;
let reloj: ReturnType<typeof relojCompartido>;
let abiertas: Pestana[];

/** Espera a que terminen las escrituras en IndexedDB que no se esperan (último acceso). */
async function asentar(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function abrirPestana(nombre: string, canal: CanalSesion): Pestana {
  const gestor = new GestorSesion({
    fetch: servidor.fetch,
    locks: null,
    iteraciones: 1_000,
    iteracionesMinimas: 1_000,
    enLinea: () => true,
    candado: { intervaloMs: 5 },
    canal,
    ahora: reloj.ahora,
  });
  const documento = documentoFalso();
  const dejar = vigilarInactividad({
    sesion: gestor,
    documento,
    ahora: reloj.ahora,
    temporizadores: reloj.temporizadores(nombre),
  });
  const pestana: Pestana = {
    nombre,
    gestor,
    documento,
    tocar: () => documento.emitir('pointerdown'),
    dejar,
  };
  abiertas.push(pestana);
  return pestana;
}

/**
 * Canales de las pestañas A y B unidos (BroadcastChannel en memoria o `localStorage` compartido),
 * más una fábrica de canales sueltos que comparten SOLO la marca de `localStorage` (una pestaña
 * congelada que no recibe los avisos) y el bus para inspeccionar los mensajes.
 */
function canales(modo: Modo) {
  const compartido = almacenCompartido();
  if (modo === 'broadcast') {
    const bus = busDifusion();
    return {
      unido: () =>
        crearCanalSesion({ crearCanal: bus.crearCanal, almacen: compartido.pestana().almacen }),
      aislado: () =>
        crearCanalSesion({
          crearCanal: busDifusion().crearCanal,
          almacen: compartido.pestana().almacen,
        }),
      compartido,
      mensajes: () => bus.mensajes,
    };
  }
  const mensajes: unknown[] = [];
  return {
    unido: () => {
      const pestana = compartido.pestana();
      const setItem = pestana.almacen.setItem.bind(pestana.almacen);
      return crearCanalSesion({
        crearCanal: null,
        almacen: {
          getItem: (clave) => pestana.almacen.getItem(clave),
          setItem(clave, valor) {
            if (clave !== CLAVE_ACTIVIDAD_SESION) {
              mensajes.push(JSON.parse(valor));
            }
            setItem(clave, valor);
          },
        },
        ventana: pestana.ventana,
      });
    },
    // Sin `ventana`: no recibe el evento `storage`, pero lee la marca compartida.
    aislado: () =>
      crearCanalSesion({ crearCanal: null, almacen: compartido.pestana().almacen, ventana: null }),
    compartido,
    mensajes: () => mensajes,
  };
}

async function dosPestanasConAna(modo: Modo, aisladaA = false) {
  const c = canales(modo);
  const a = abrirPestana('A', aisladaA ? c.aislado() : c.unido());
  const b = abrirPestana('B', c.unido());
  await a.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
  await b.gestor.restaurar();
  expect(a.gestor.estado()).toMatchObject({ usuario: { id: ana.id }, bloqueada: false });
  expect(b.gestor.estado()).toMatchObject({ usuario: { id: ana.id }, bloqueada: false });
  return { a, b, c };
}

function bloqueos(mensajes: unknown[]): unknown[] {
  return mensajes.filter((m) => (m as { tipo?: unknown }).tipo === 'bloqueo');
}

beforeEach(async () => {
  await limpiarDb();
  abiertas = [];
  reloj = relojCompartido(INICIO);
  servidor = crearServidorFalso();
  ana = servidor.agregarUsuario('Ana Gómez', 'ana@catmetal.co', CLAVE_ANA);
  servidor.agregarUsuario('Beto Ruiz', 'beto@catmetal.co', CLAVE_BETO, 'jefe');
  return async () => {
    for (const pestana of abiertas) {
      pestana.dejar();
    }
    await asentar();
  };
});

describe.each(['broadcast', 'storage'] as const)('A2: inactividad compartida (%s)', (modo) => {
  it('con interacción en B a los 9 min, el temporizador de A al minuto 10 no bloquea ninguna', async () => {
    const { a, b, c } = await dosPestanasConAna(modo);
    reloj.hasta(9 * MINUTO);
    b.tocar();
    reloj.hasta(10 * MINUTO);
    expect(a.gestor.estado().bloqueada).toBe(false);
    expect(b.gestor.estado().bloqueada).toBe(false);
    expect(bloqueos(c.mensajes())).toEqual([]);

    // Sin más actividad, a los 10 min de la última interacción (min 19) se bloquean las dos.
    reloj.hasta(19 * MINUTO - 1);
    expect(a.gestor.estado().bloqueada).toBe(false);
    expect(b.gestor.estado().bloqueada).toBe(false);
    reloj.hasta(19 * MINUTO);
    expect(a.gestor.estado().bloqueada).toBe(true);
    expect(b.gestor.estado().bloqueada).toBe(true);
  });

  it('sin actividad en ninguna pestaña, al minuto 10 quedan bloqueadas las dos', async () => {
    const { a, b, c } = await dosPestanasConAna(modo);
    reloj.hasta(10 * MINUTO - 1);
    expect(a.gestor.estado().bloqueada).toBe(false);
    expect(b.gestor.estado().bloqueada).toBe(false);
    reloj.hasta(10 * MINUTO);
    expect(a.gestor.estado().bloqueada).toBe(true);
    expect(b.gestor.estado().bloqueada).toBe(true);
    // El aviso de bloqueo dice el motivo y no lleva nada más que lo previsto.
    expect(bloqueos(c.mensajes())[0]).toMatchObject({
      tipo: 'bloqueo',
      user_id: ana.id,
      motivo: 'inactividad',
    });
  });

  it('A vuelve a visible tras 15 min congelada; la marca compartida de B es de hace 2 min: no bloquea', async () => {
    // A está aislada: no recibe los avisos de B (congelada), solo puede leer la marca compartida.
    const { a, b, c } = await dosPestanasConAna(modo, true);
    a.documento.ocultar();
    for (const minuto of [3, 6, 9, 12, 13]) {
      reloj.hasta(minuto * MINUTO, ['A']);
      b.tocar();
    }
    // El aviso de B sale al final del intervalo y deja la marca.
    reloj.hasta(15 * MINUTO, ['A']);
    expect(JSON.parse(c.compartido.datos.get(CLAVE_ACTIVIDAD_SESION)!)).toEqual({
      user_id: ana.id,
      at: INICIO + 13 * MINUTO,
    });
    a.documento.mostrar();
    expect(a.gestor.estado().bloqueada).toBe(false);
    expect(b.gestor.estado().bloqueada).toBe(false);

    // Una interacción en A tras el congelamiento tampoco bloquea: cuenta como actividad.
    a.tocar();
    expect(a.gestor.estado().bloqueada).toBe(false);
  });

  it('A vuelve a visible tras 15 min sin actividad en ninguna (B también congelada): bloquea', async () => {
    const { a, b } = await dosPestanasConAna(modo);
    a.documento.ocultar();
    b.documento.ocultar();
    reloj.hasta(15 * MINUTO, ['A', 'B']);
    a.documento.mostrar();
    expect(a.gestor.estado().bloqueada).toBe(true);
    expect(b.gestor.estado().bloqueada).toBe(true);
  });

  it('el aviso de bloqueo llega a B, que tuvo interacción hace 2 s: B no se bloquea y responde actividad', async () => {
    const { a, b, c } = await dosPestanasConAna(modo);
    // B toca 2 s antes del vencimiento de A: su aviso (al final del intervalo de 5 s) aún no salió.
    reloj.hasta(10 * MINUTO - 2 * SEGUNDO);
    b.tocar();
    reloj.hasta(10 * MINUTO);
    expect(a.gestor.estado().bloqueada).toBe(true);
    expect(b.gestor.estado().bloqueada).toBe(false);
    const respuesta = c
      .mensajes()
      .find((m) => (m as { tipo?: unknown }).tipo === 'actividad') as Record<string, unknown>;
    expect(respuesta).toMatchObject({
      tipo: 'actividad',
      user_id: ana.id,
      at: INICIO + 10 * MINUTO - 2 * SEGUNDO,
    });
    expect(Object.keys(respuesta).sort()).toEqual(['at', 'origen', 'tipo', 'user_id', 'v']);
  });

  it('la revocación (S-09) bloquea siempre a la otra pestaña, aunque tenga interacción reciente', async () => {
    const { a, b, c } = await dosPestanasConAna(modo);
    reloj.hasta(MINUTO);
    b.tocar();
    a.gestor.marcarSesionRevocada();
    await asentar();
    expect(a.gestor.estado()).toMatchObject({ bloqueada: true, revocada: true });
    expect(b.gestor.estado()).toMatchObject({ bloqueada: true, revocada: true });
    expect(bloqueos(c.mensajes())[0]).toMatchObject({ motivo: 'revocacion' });
  });

  it('un aviso de bloqueo sin motivo (pestaña con el código anterior) bloquea siempre', async () => {
    const c = canales(modo);
    const b = abrirPestana('B', c.unido());
    const vieja = c.unido();
    await b.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    reloj.hasta(MINUTO);
    b.tocar();
    vieja.emitir('bloqueo', ana.id);
    expect(b.gestor.estado().bloqueada).toBe(true);
  });

  it('un aviso de bloqueo por inactividad bloquea a una pestaña sin interacción propia reciente', async () => {
    const c = canales(modo);
    const b = abrirPestana('B', c.unido());
    const otra = c.unido();
    await b.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    reloj.hasta(MINUTO);
    otra.emitir('bloqueo', ana.id, { motivo: 'inactividad' });
    expect(b.gestor.estado().bloqueada).toBe(true);
  });

  it('se ignoran la actividad del futuro y la de otro usuario', async () => {
    const c = canales(modo);
    const a = abrirPestana('A', c.unido());
    const otra = c.unido();
    await a.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    reloj.hasta(9 * MINUTO);
    // Marca en el futuro (reloj adelantado o valor manipulado) y marca de otro usuario.
    c.compartido.datos.set(
      CLAVE_ACTIVIDAD_SESION,
      JSON.stringify({ user_id: ana.id, at: INICIO + 60 * MINUTO }),
    );
    otra.emitir('actividad', ana.id, { at: INICIO + 60 * MINUTO });
    otra.emitir('actividad', 'id-de-otro-usuario', { at: INICIO + 9 * MINUTO });
    reloj.hasta(10 * MINUTO);
    expect(a.gestor.estado().bloqueada).toBe(true);
  });

  it('una marca de otro usuario no evita el bloqueo', async () => {
    const c = canales(modo);
    const a = abrirPestana('A', c.unido());
    await a.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    c.compartido.datos.set(
      CLAVE_ACTIVIDAD_SESION,
      JSON.stringify({ user_id: 'otro-usuario', at: INICIO + 9 * MINUTO }),
    );
    reloj.hasta(10 * MINUTO);
    expect(a.gestor.estado().bloqueada).toBe(true);
  });
});

describe('A2: aviso de actividad con límite de frecuencia', () => {
  it('como mucho un aviso cada 5 s, enviado al final del intervalo con la última interacción', async () => {
    const c = canales('broadcast');
    const a = abrirPestana('A', c.unido());
    await a.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const actividad = () =>
      c.mensajes().filter((m) => (m as { tipo?: unknown }).tipo === 'actividad') as {
        at: number;
      }[];

    expect(INTERVALO_AVISO_ACTIVIDAD_MS).toBe(5 * SEGUNDO);
    a.tocar(); // t = 0
    reloj.hasta(1 * SEGUNDO);
    a.tocar();
    reloj.hasta(3 * SEGUNDO);
    a.tocar();
    reloj.hasta(5 * SEGUNDO - 1);
    expect(actividad()).toEqual([]);
    reloj.hasta(5 * SEGUNDO);
    expect(actividad().map((m) => m.at)).toEqual([INICIO + 3 * SEGUNDO]);
    expect(JSON.parse(c.compartido.datos.get(CLAVE_ACTIVIDAD_SESION)!)).toEqual({
      user_id: ana.id,
      at: INICIO + 3 * SEGUNDO,
    });

    reloj.hasta(6 * SEGUNDO);
    a.tocar();
    reloj.hasta(10 * SEGUNDO);
    expect(actividad()).toHaveLength(1);
    reloj.hasta(11 * SEGUNDO);
    expect(actividad().map((m) => m.at)).toEqual([INICIO + 3 * SEGUNDO, INICIO + 6 * SEGUNDO]);

    // Sin interacción no hay avisos.
    reloj.hasta(5 * MINUTO);
    expect(actividad()).toHaveLength(2);
  });

  it('un aviso pendiente de otro usuario no sale tras un cambio de usuario', async () => {
    const c = canales('broadcast');
    const a = abrirPestana('A', c.unido());
    await a.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    a.tocar();
    await a.gestor.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    reloj.hasta(LIMITE_INACTIVIDAD_MS / 2);
    expect(c.mensajes().filter((m) => (m as { tipo?: unknown }).tipo === 'actividad')).toEqual([]);
    expect(c.compartido.datos.has(CLAVE_ACTIVIDAD_SESION)).toBe(false);
  });

  it('dejar de vigilar cancela el aviso pendiente', async () => {
    const c = canales('broadcast');
    const a = abrirPestana('A', c.unido());
    await a.gestor.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const registrar = vi.spyOn(a.gestor, 'registrarActividad');
    a.tocar();
    expect(registrar).toHaveBeenCalledTimes(1);
    a.dejar();
    reloj.hasta(MINUTO);
    expect(c.mensajes().filter((m) => (m as { tipo?: unknown }).tipo === 'actividad')).toEqual([]);
  });
});

import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vigilarInactividad, type DocumentoVigilado, type SesionVigilada } from './inactividad';
import { ESTADO_SIN_SESION, LIMITE_INACTIVIDAD_MS, type EstadoSesion } from './sesion';

const MINUTO = 60_000;

const ana: Perfil = {
  id: uuidv7(),
  nombre: 'Ana Gómez',
  email: 'ana@catmetal.co',
  rol: 'supervisor',
  permisos: permisosDeRol('supervisor'),
};

/** Reloj y temporizadores manuales (inyectados en el vigilante). */
function relojManual() {
  let ahora = 0;
  let siguienteId = 1;
  const pendientes = new Map<number, { vence: number; callback: () => void }>();
  return {
    ahora: () => ahora,
    temporizadores: {
      setTimeout(callback: () => void, ms: number) {
        const id = siguienteId++;
        pendientes.set(id, { vence: ahora + ms, callback });
        return id;
      },
      clearTimeout(id: unknown) {
        pendientes.delete(id as number);
      },
    },
    /** Avanza el reloj disparando los temporizadores vencidos (si `disparar`). */
    avanzar(ms: number, disparar = true) {
      const destino = ahora + ms;
      for (;;) {
        const vencido = [...pendientes.entries()]
          .filter(([, t]) => t.vence <= destino)
          .sort((a, b) => a[1].vence - b[1].vence)[0];
        if (!disparar || vencido === undefined) {
          break;
        }
        pendientes.delete(vencido[0]);
        ahora = vencido[1].vence;
        vencido[1].callback();
      }
      ahora = destino;
    },
    get armados() {
      return pendientes.size;
    },
  };
}

function documentoFalso() {
  const objetivo = new EventTarget();
  const documento = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: vi.fn(
      (tipo: string, oyente: () => void, opciones?: AddEventListenerOptions) =>
        objetivo.addEventListener(tipo, oyente, opciones),
    ),
    removeEventListener: vi.fn(
      (tipo: string, oyente: () => void, opciones?: EventListenerOptions) =>
        objetivo.removeEventListener(tipo, oyente, opciones),
    ),
    emitir(tipo: string) {
      objetivo.dispatchEvent(new Event(tipo));
    },
  };
  return documento satisfies DocumentoVigilado;
}

function sesionFalsa(inicial: EstadoSesion = ESTADO_SIN_SESION) {
  let estado = inicial;
  const oyentes = new Set<(e: EstadoSesion) => void>();
  const publicar = (nuevo: EstadoSesion) => {
    estado = nuevo;
    oyentes.forEach((o) => o(estado));
  };
  const sesion = {
    estado: () => estado,
    suscribir: (oyente: (e: EstadoSesion) => void) => {
      oyentes.add(oyente);
      return () => oyentes.delete(oyente);
    },
    bloquear: vi.fn(() => publicar({ ...estado, bloqueada: true })),
    registrarActividad: vi.fn(() => Promise.resolve()),
    ultimaActividadCompartida: vi.fn(() => Number.NEGATIVE_INFINITY),
    avisarActividad: vi.fn(),
    entrar: () =>
      publicar({
        modo: 'online',
        usuario: ana,
        permisos: ana.permisos,
        device_id: null,
        requiere_contrasena: false,
        bloqueada: false,
      }),
    desbloquear: () => publicar({ ...estado, bloqueada: false }),
    salir: () => publicar(ESTADO_SIN_SESION),
    get oyentes() {
      return oyentes.size;
    },
  };
  return sesion satisfies SesionVigilada;
}

let reloj: ReturnType<typeof relojManual>;
let documento: ReturnType<typeof documentoFalso>;
let sesion: ReturnType<typeof sesionFalsa>;

function vigilar() {
  return vigilarInactividad({
    sesion,
    documento,
    ahora: reloj.ahora,
    temporizadores: reloj.temporizadores,
  });
}

beforeEach(() => {
  reloj = relojManual();
  documento = documentoFalso();
  sesion = sesionFalsa();
});

describe('vigilarInactividad (F4-01, ADR 0017 §1)', () => {
  it('el límite es de 10 minutos', () => {
    expect(LIMITE_INACTIVIDAD_MS).toBe(10 * MINUTO);
  });

  it('sin sesión no arma nada; con sesión bloquea tras 10 minutos sin interacción', () => {
    vigilar();
    expect(reloj.armados).toBe(0);
    sesion.entrar();
    reloj.avanzar(10 * MINUTO - 1);
    expect(sesion.bloquear).not.toHaveBeenCalled();
    reloj.avanzar(1);
    expect(sesion.bloquear).toHaveBeenCalledTimes(1);
    expect(sesion.estado().bloqueada).toBe(true);
    expect(reloj.armados).toBe(0);
  });

  it('pointerdown y keydown posponen el bloqueo y registran la actividad', () => {
    vigilar();
    sesion.entrar();
    reloj.avanzar(9 * MINUTO);
    documento.emitir('pointerdown');
    reloj.avanzar(9 * MINUTO);
    documento.emitir('keydown');
    reloj.avanzar(9 * MINUTO);
    expect(sesion.bloquear).not.toHaveBeenCalled();
    expect(sesion.registrarActividad).toHaveBeenCalledTimes(2);
    reloj.avanzar(MINUTO);
    expect(sesion.bloquear).toHaveBeenCalledTimes(1);
    // Los eventos se escuchan en captura: un `stopPropagation` de un componente no los oculta.
    expect(documento.addEventListener).toHaveBeenCalledWith(
      'pointerdown',
      expect.any(Function),
      expect.objectContaining({ capture: true }),
    );
  });

  it('volver de segundo plano tras más de 10 minutos bloquea aunque el temporizador no disparara', () => {
    vigilar();
    sesion.entrar();
    documento.visibilityState = 'hidden';
    documento.emitir('visibilitychange');
    // En segundo plano el navegador congela los temporizadores: el reloj avanza sin dispararlos.
    reloj.avanzar(10 * MINUTO + 1, false);
    documento.visibilityState = 'visible';
    documento.emitir('visibilitychange');
    expect(sesion.bloquear).toHaveBeenCalledTimes(1);
  });

  it('volver de segundo plano antes de 10 minutos no bloquea', () => {
    vigilar();
    sesion.entrar();
    reloj.avanzar(4 * MINUTO, false);
    documento.emitir('visibilitychange');
    expect(sesion.bloquear).not.toHaveBeenCalled();
    reloj.avanzar(6 * MINUTO);
    expect(sesion.bloquear).toHaveBeenCalledTimes(1);
  });

  it('una interacción después de un congelamiento largo bloquea en lugar de reiniciar el plazo', () => {
    vigilar();
    sesion.entrar();
    reloj.avanzar(11 * MINUTO, false);
    documento.emitir('pointerdown');
    expect(sesion.bloquear).toHaveBeenCalledTimes(1);
    expect(sesion.registrarActividad).not.toHaveBeenCalled();
  });

  it('bloqueada no cuenta la actividad; al desbloquear el plazo empieza de nuevo', () => {
    vigilar();
    sesion.entrar();
    reloj.avanzar(10 * MINUTO);
    documento.emitir('keydown');
    expect(sesion.registrarActividad).not.toHaveBeenCalled();
    reloj.avanzar(30 * MINUTO);
    sesion.desbloquear();
    reloj.avanzar(9 * MINUTO);
    expect(sesion.bloquear).toHaveBeenCalledTimes(1);
    reloj.avanzar(MINUTO);
    expect(sesion.bloquear).toHaveBeenCalledTimes(2);
  });

  it('una sesión que ya llega bloqueada (restaurar) no arma el temporizador', () => {
    sesion = sesionFalsa({
      modo: 'online',
      usuario: ana,
      permisos: ana.permisos,
      device_id: null,
      requiere_contrasena: false,
      bloqueada: true,
    });
    vigilar();
    expect(reloj.armados).toBe(0);
  });

  it('al cerrar sesión se desarma y al dejar de vigilar se quitan los oyentes', () => {
    const dejar = vigilar();
    sesion.entrar();
    expect(reloj.armados).toBe(1);
    sesion.salir();
    expect(reloj.armados).toBe(0);
    sesion.entrar();
    dejar();
    expect(reloj.armados).toBe(0);
    expect(sesion.oyentes).toBe(0);
    expect(documento.removeEventListener).toHaveBeenCalledTimes(3);
    documento.emitir('keydown');
    expect(sesion.registrarActividad).not.toHaveBeenCalled();
  });

  it('un error al registrar la actividad se informa sin romper la vigilancia', async () => {
    const alError = vi.fn();
    sesion.registrarActividad.mockRejectedValueOnce(new Error('IndexedDB'));
    vigilarInactividad({
      sesion,
      documento,
      ahora: reloj.ahora,
      temporizadores: reloj.temporizadores,
      alError,
    });
    sesion.entrar();
    documento.emitir('pointerdown');
    await Promise.resolve();
    expect(alError).toHaveBeenCalledTimes(1);
    reloj.avanzar(10 * MINUTO);
    expect(sesion.bloquear).toHaveBeenCalledTimes(1);
  });
});

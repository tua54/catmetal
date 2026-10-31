// F6-07: retención de la tablet una vez al día con la app abierta y al cerrar sesión.

import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { describe, expect, it, vi } from 'vitest';
import { ESTADO_SIN_SESION, type EstadoSesion } from '../auth';
import {
  crearRetencionPeriodica,
  INTERVALO_RETENCION_MS,
  INTERVALO_REVISION_RETENCION_MS,
  type SesionObservada,
  type TemporizadoresPeriodicos,
} from './retencion-periodica';

function perfil(): Perfil {
  const id = uuidv7();
  return {
    id,
    nombre: 'Ana Gómez',
    email: `ana.${id.slice(-6)}@catmetal.test`,
    rol: 'supervisor',
    permisos: permisosDeRol('supervisor'),
  };
}

/** Sesión observable mínima: `publicar` hace lo que `GestorSesion` con sus oyentes. */
function sesionFalsa(inicial: Perfil | null = null) {
  let estado: EstadoSesion = { ...ESTADO_SIN_SESION, usuario: inicial };
  const oyentes = new Set<(estado: EstadoSesion) => void>();
  const sesion: SesionObservada & { publicar(usuario: Perfil | null): void; oyentes: number } = {
    usuarioDeLaSesion: () => estado.usuario,
    suscribir(oyente) {
      oyentes.add(oyente);
      return () => oyentes.delete(oyente);
    },
    publicar(usuario) {
      estado = { ...estado, usuario, modo: usuario === null ? 'sin_sesion' : 'online' };
      for (const oyente of oyentes) {
        oyente(estado);
      }
    },
    get oyentes() {
      return oyentes.size;
    },
  };
  return sesion;
}

/** Temporizador manual: `revisar()` ejecuta la revisión periódica programada. */
function temporizadoresFalsos() {
  const programados = new Map<number, { callback: () => void; ms: number }>();
  let siguiente = 0;
  const temporizadores: TemporizadoresPeriodicos & { revisar(): void; activos: number } = {
    setInterval(callback, ms) {
      siguiente += 1;
      programados.set(siguiente, { callback, ms });
      return siguiente;
    },
    clearInterval(id) {
      programados.delete(id as number);
    },
    revisar() {
      for (const { callback } of programados.values()) {
        callback();
      }
    },
    get activos() {
      return programados.size;
    },
  };
  return { temporizadores, programados };
}

async function vaciarMicrotareas() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('retención periódica (F6-07)', () => {
  it('no aplica nada al crearse; aplicarAhora excluye al usuario de la sesión', async () => {
    const usuario = perfil();
    const aplicar = vi.fn(() => Promise.resolve());
    const { temporizadores, programados } = temporizadoresFalsos();
    const retencion = crearRetencionPeriodica({
      aplicar,
      sesion: sesionFalsa(usuario),
      temporizadores,
      ahora: () => 0,
    });
    expect(aplicar).not.toHaveBeenCalled();
    expect([...programados.values()].map((p) => p.ms)).toEqual([INTERVALO_REVISION_RETENCION_MS]);

    await retencion.aplicarAhora();
    expect(aplicar).toHaveBeenCalledExactlyOnceWith({ excluir: usuario.id });
    retencion.detener();
  });

  it('con la app abierta se aplica una vez al día (no en cada revisión)', async () => {
    let reloj = 1_000_000;
    const aplicar = vi.fn(() => Promise.resolve());
    const { temporizadores } = temporizadoresFalsos();
    const retencion = crearRetencionPeriodica({
      aplicar,
      sesion: sesionFalsa(),
      temporizadores,
      ahora: () => reloj,
    });
    await retencion.aplicarAhora();
    expect(aplicar).toHaveBeenCalledTimes(1);

    // 23 revisiones horarias: todavía no pasó un día desde la última aplicación.
    for (let hora = 1; hora < 24; hora += 1) {
      reloj += INTERVALO_REVISION_RETENCION_MS;
      temporizadores.revisar();
      await vaciarMicrotareas();
    }
    expect(aplicar).toHaveBeenCalledTimes(1);

    reloj += INTERVALO_REVISION_RETENCION_MS;
    temporizadores.revisar();
    await vaciarMicrotareas();
    expect(aplicar).toHaveBeenCalledTimes(2);

    // Un temporizador retrasado (tablet suspendida dos días) aplica una sola vez al despertar.
    reloj += 2 * INTERVALO_RETENCION_MS;
    temporizadores.revisar();
    temporizadores.revisar();
    await vaciarMicrotareas();
    expect(aplicar).toHaveBeenCalledTimes(3);
    retencion.detener();
  });

  it('se aplica al cerrar sesión (paso a null), no al iniciarla ni al cambiar de estado', async () => {
    const usuario = perfil();
    const sesion = sesionFalsa();
    const aplicar = vi.fn(() => Promise.resolve());
    const retencion = crearRetencionPeriodica({
      aplicar,
      sesion,
      temporizadores: temporizadoresFalsos().temporizadores,
      ahora: () => 0,
    });

    sesion.publicar(usuario);
    sesion.publicar(usuario); // p. ej. bloqueo o refresh: mismo usuario
    await vaciarMicrotareas();
    expect(aplicar).not.toHaveBeenCalled();

    sesion.publicar(null);
    await vaciarMicrotareas();
    expect(aplicar).toHaveBeenCalledExactlyOnceWith({ excluir: null });
    retencion.detener();
  });

  it('no corre dos en paralelo: si se pide durante una, la repite al terminar', async () => {
    const usuario = perfil();
    const sesion = sesionFalsa(usuario);
    let terminar: () => void = () => undefined;
    const llamadas: (string | null)[] = [];
    const aplicar = vi.fn(({ excluir }: { excluir: string | null }) => {
      llamadas.push(excluir);
      return llamadas.length === 1
        ? new Promise<void>((resolver) => {
            terminar = resolver;
          })
        : Promise.resolve();
    });
    const retencion = crearRetencionPeriodica({
      aplicar,
      sesion,
      temporizadores: temporizadoresFalsos().temporizadores,
      ahora: () => 0,
    });

    const primera = retencion.aplicarAhora();
    await vaciarMicrotareas();
    expect(aplicar).toHaveBeenCalledTimes(1);
    sesion.publicar(null); // cierre de sesión mientras la primera sigue en curso
    const segunda = retencion.aplicarAhora();
    await vaciarMicrotareas();
    expect(aplicar).toHaveBeenCalledTimes(1);

    terminar();
    await Promise.all([primera, segunda]);
    // La primera excluyó al usuario que estaba en sesión; la repetición ya no excluye a nadie.
    expect(llamadas).toEqual([usuario.id, null]);
    retencion.detener();
  });

  it('una petición en cualquier microtick de una aplicación en curso siempre queda cubierta', async () => {
    // Cubierta = alguna aplicación EMPIEZA (lee la sesión) después de la petición. Una petición que
    // llega antes de que empiece la que está en curso la aprovecha; después, se repite.
    for (let ticks = 0; ticks < 12; ticks += 1) {
      let pedida = false;
      let cubierta = false;
      const aplicar = vi.fn(() => {
        cubierta ||= pedida;
        return Promise.resolve();
      });
      const retencion = crearRetencionPeriodica({
        aplicar,
        sesion: sesionFalsa(),
        temporizadores: temporizadoresFalsos().temporizadores,
        ahora: () => 0,
      });
      const primera = retencion.aplicarAhora();
      for (let i = 0; i < ticks; i += 1) {
        await Promise.resolve();
      }
      pedida = true;
      const segunda = retencion.aplicarAhora();
      await Promise.all([primera, segunda]);
      await vaciarMicrotareas();
      expect(cubierta, `petición tras ${ticks} microticks`).toBe(true);
      expect(aplicar.mock.calls.length).toBeLessThanOrEqual(2);
      retencion.detener();
    }
  });

  it('un error síncrono de aplicar no deja la retención trabada', async () => {
    const alError = vi.fn();
    const aplicar = vi.fn((): Promise<unknown> => {
      throw new Error('sin IndexedDB');
    });
    const retencion = crearRetencionPeriodica({
      aplicar,
      sesion: sesionFalsa(),
      temporizadores: temporizadoresFalsos().temporizadores,
      ahora: () => 0,
      alError,
    });
    await retencion.aplicarAhora();
    await retencion.aplicarAhora();
    expect(aplicar).toHaveBeenCalledTimes(2);
    expect(alError).toHaveBeenCalledTimes(2);
    retencion.detener();
  });

  it('un error va a alError y no detiene las siguientes', async () => {
    let reloj = 0;
    const alError = vi.fn();
    const aplicar = vi
      .fn<(opciones: { excluir: string | null }) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('IndexedDB'))
      .mockResolvedValue(undefined);
    const { temporizadores } = temporizadoresFalsos();
    const retencion = crearRetencionPeriodica({
      aplicar,
      sesion: sesionFalsa(),
      temporizadores,
      ahora: () => reloj,
      alError,
    });
    await expect(retencion.aplicarAhora()).resolves.toBeUndefined();
    expect(alError).toHaveBeenCalledTimes(1);

    reloj += INTERVALO_RETENCION_MS;
    temporizadores.revisar();
    await vaciarMicrotareas();
    expect(aplicar).toHaveBeenCalledTimes(2);
    expect(alError).toHaveBeenCalledTimes(1);
    retencion.detener();
  });

  it('detener cancela la revisión diaria y deja de observar la sesión', async () => {
    let reloj = 0;
    const usuario = perfil();
    const sesion = sesionFalsa(usuario);
    const aplicar = vi.fn(() => Promise.resolve());
    const { temporizadores } = temporizadoresFalsos();
    const retencion = crearRetencionPeriodica({
      aplicar,
      sesion,
      temporizadores,
      ahora: () => reloj,
    });
    expect(sesion.oyentes).toBe(1);

    retencion.detener();
    expect(temporizadores.activos).toBe(0);
    expect(sesion.oyentes).toBe(0);

    reloj += INTERVALO_RETENCION_MS;
    temporizadores.revisar();
    sesion.publicar(null);
    await vaciarMicrotareas();
    expect(aplicar).not.toHaveBeenCalled();
  });
});

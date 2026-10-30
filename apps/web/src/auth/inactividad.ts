// Vigilante de inactividad (ADR 0017 §1, F4-01): tras 10 minutos sin interacción (`pointerdown`,
// `keydown`), o al volver de segundo plano después de más de 10 minutos, bloquea la sesión. La
// actividad se registra en el perfil como mucho una vez por minuto (lo limita `GestorSesion`).
//
// Los temporizadores y el reloj son inyectables para probarlo sin esperar. En segundo plano los
// navegadores congelan o espacian los temporizadores: por eso, al volver a `visible`, se compara el
// reloj con la última actividad en lugar de confiar en que el temporizador haya disparado.

import { LIMITE_INACTIVIDAD_MS, type EstadoSesion } from './sesion';

/** Lo que el vigilante necesita de la sesión (lo cumple `GestorSesion`). */
export interface SesionVigilada {
  estado(): EstadoSesion;
  suscribir(oyente: (estado: EstadoSesion) => void): () => void;
  bloquear(): void;
  registrarActividad(): Promise<void>;
}

export interface Temporizadores {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Subconjunto de `Document` que se usa. */
export interface DocumentoVigilado {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(tipo: string, oyente: () => void, opciones?: AddEventListenerOptions): void;
  removeEventListener(tipo: string, oyente: () => void, opciones?: EventListenerOptions): void;
}

export interface OpcionesVigilante {
  sesion: SesionVigilada;
  documento?: DocumentoVigilado;
  ahora?: () => number;
  temporizadores?: Temporizadores;
  limiteMs?: number;
  /** Errores al registrar la actividad (por defecto, `console.error`). */
  alError?: (error: unknown) => void;
}

/** Eventos que cuentan como interacción del usuario. */
export const EVENTOS_ACTIVIDAD = ['pointerdown', 'keydown'] as const;

const TEMPORIZADORES_GLOBALES: Temporizadores = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Empieza a vigilar la inactividad de la sesión. Devuelve la función para dejar de vigilar. Se
 * llama una sola vez por pestaña (en el arranque).
 */
export function vigilarInactividad(opciones: OpcionesVigilante): () => void {
  const { sesion } = opciones;
  const documento = opciones.documento ?? globalThis.document;
  const ahora = opciones.ahora ?? Date.now;
  const temporizadores = opciones.temporizadores ?? TEMPORIZADORES_GLOBALES;
  const limiteMs = opciones.limiteMs ?? LIMITE_INACTIVIDAD_MS;
  const alError = opciones.alError ?? ((error: unknown) => console.error(error));
  const captura: AddEventListenerOptions = { capture: true, passive: true };

  let ultimaActividad = ahora();
  /** Temporizador armado (envuelto: el id puede ser 0 o un objeto según el entorno). */
  let temporizador: { id: unknown } | null = null;
  let usuarioVigilado: string | null = null;
  let estabaBloqueada = false;

  const activa = (): boolean => {
    const estado = sesion.estado();
    return estado.usuario !== null && !estado.bloqueada;
  };

  function desarmar(): void {
    if (temporizador !== null) {
      temporizadores.clearTimeout(temporizador.id);
      temporizador = null;
    }
  }

  /** Bloquea si ya pasó el límite; si no, programa la próxima comprobación para cuando venza. */
  function armar(): void {
    desarmar();
    if (!activa()) {
      return;
    }
    const restante = limiteMs - (ahora() - ultimaActividad);
    if (restante <= 0) {
      sesion.bloquear();
      return;
    }
    temporizador = {
      id: temporizadores.setTimeout(() => {
        temporizador = null;
        armar();
      }, restante),
    };
  }

  const alActividad = (): void => {
    if (!activa()) {
      return;
    }
    if (ahora() - ultimaActividad >= limiteMs) {
      // El temporizador no alcanzó a disparar (pestaña congelada): la interacción no desbloquea.
      sesion.bloquear();
      return;
    }
    ultimaActividad = ahora();
    sesion.registrarActividad().catch(alError);
  };

  const alCambiarVisibilidad = (): void => {
    if (documento?.visibilityState === 'visible') {
      // Vuelta de segundo plano: si pasó más del límite desde la última actividad, se bloquea.
      armar();
    }
  };

  const desuscribir = sesion.suscribir((estado) => {
    const usuario = estado.usuario?.id ?? null;
    const desbloqueo = estabaBloqueada && !estado.bloqueada;
    if (usuario !== usuarioVigilado || desbloqueo) {
      // Sesión nueva o identidad confirmada: el plazo empieza de nuevo.
      ultimaActividad = ahora();
    }
    usuarioVigilado = usuario;
    estabaBloqueada = estado.bloqueada;
    armar();
  });

  for (const tipo of EVENTOS_ACTIVIDAD) {
    documento?.addEventListener(tipo, alActividad, captura);
  }
  documento?.addEventListener('visibilitychange', alCambiarVisibilidad);

  const inicial = sesion.estado();
  usuarioVigilado = inicial.usuario?.id ?? null;
  estabaBloqueada = inicial.bloqueada;
  armar();

  return () => {
    desuscribir();
    desarmar();
    for (const tipo of EVENTOS_ACTIVIDAD) {
      documento?.removeEventListener(tipo, alActividad, captura);
    }
    documento?.removeEventListener('visibilitychange', alCambiarVisibilidad);
  };
}

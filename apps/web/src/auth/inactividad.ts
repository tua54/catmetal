// Vigilante de inactividad (ADR 0017 §1, F4-01): tras 10 minutos sin interacción (`pointerdown`,
// `keydown`), o al volver de segundo plano después de más de 10 minutos, bloquea la sesión. La
// actividad se registra en el perfil como mucho una vez por minuto (lo limita `GestorSesion`).
//
// Inactividad compartida (ADR 0023, enmienda 1; ítem A2): la inactividad es del USUARIO y no de la
// pestaña. La última actividad es el máximo entre la propia, la de los avisos `actividad` de las
// demás pestañas del mismo usuario y la marca compartida de `localStorage` (que se relee antes de
// decidir); los valores del futuro se ignoran. Solo se bloquea, y solo se avisa `bloqueo`, si ese
// máximo tiene 10 minutos o más. Cada interacción propia se avisa a las demás pestañas como mucho
// una vez cada 5 s, al final del intervalo (el último `at` de una ráfaga siempre sale).
//
// Los temporizadores y el reloj son inyectables para probarlo sin esperar. En segundo plano los
// navegadores congelan o espacian los temporizadores: por eso, al volver a `visible`, se compara el
// reloj con la última actividad en lugar de confiar en que el temporizador haya disparado.

import { LIMITE_INACTIVIDAD_MS, type EstadoSesion } from './sesion';

/** Como mucho un aviso `actividad` cada 5 s por pestaña (ADR 0023, enmienda 1). */
export const INTERVALO_AVISO_ACTIVIDAD_MS = 5_000;

/** Lo que el vigilante necesita de la sesión (lo cumple `GestorSesion`). */
export interface SesionVigilada {
  estado(): EstadoSesion;
  suscribir(oyente: (estado: EstadoSesion) => void): () => void;
  bloquear(): void;
  registrarActividad(): Promise<void>;
  /**
   * Última actividad del usuario en las demás pestañas (avisos recibidos y marca compartida, que
   * se relee en cada llamada), en ms; `-Infinity` si no hay.
   */
  ultimaActividadCompartida(): number;
  /** Avisa a las demás pestañas la última interacción de esta (aviso `actividad` + marca). */
  avisarActividad(at: number): void;
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

  /** Actividad propia: la última interacción o el inicio del plazo (sesión nueva o desbloqueo). */
  let ultimaActividad = ahora();
  /** Última interacción real de esta pestaña: lo que se avisa a las demás. */
  let ultimaInteraccion = Number.NEGATIVE_INFINITY;
  /** Temporizador armado (envuelto: el id puede ser 0 o un objeto según el entorno). */
  let temporizador: { id: unknown } | null = null;
  /** Aviso `actividad` pendiente de salir al final del intervalo. */
  let aviso: { id: unknown } | null = null;
  let usuarioVigilado: string | null = null;
  let estabaBloqueada = false;

  const activa = (): boolean => {
    const estado = sesion.estado();
    return estado.usuario !== null && !estado.bloqueada;
  };

  /**
   * Última actividad del usuario en cualquier pestaña: la propia o la compartida (avisos y marca
   * releída ahora), la mayor. La compartida del futuro se ignora.
   */
  function ultimaConocida(): number {
    const compartida = sesion.ultimaActividadCompartida();
    return compartida <= ahora() && compartida > ultimaActividad ? compartida : ultimaActividad;
  }

  function desarmar(): void {
    if (temporizador !== null) {
      temporizadores.clearTimeout(temporizador.id);
      temporizador = null;
    }
  }

  function cancelarAviso(): void {
    if (aviso !== null) {
      temporizadores.clearTimeout(aviso.id);
      aviso = null;
    }
  }

  /**
   * Bloquea si NINGUNA pestaña tuvo actividad dentro del límite; si no, programa la próxima
   * comprobación para cuando venza (desde la última actividad conocida).
   */
  function armar(): void {
    desarmar();
    if (!activa()) {
      return;
    }
    const restante = limiteMs - (ahora() - ultimaConocida());
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

  /** Programa el aviso `actividad` al final del intervalo si no hay uno pendiente. */
  function programarAviso(): void {
    if (aviso !== null) {
      return;
    }
    aviso = {
      id: temporizadores.setTimeout(() => {
        aviso = null;
        if (activa()) {
          sesion.avisarActividad(ultimaInteraccion);
        }
      }, INTERVALO_AVISO_ACTIVIDAD_MS),
    };
  }

  const alActividad = (): void => {
    if (!activa()) {
      return;
    }
    if (ahora() - ultimaConocida() >= limiteMs) {
      // El temporizador no alcanzó a disparar (pestaña congelada) y ninguna otra pestaña tuvo
      // actividad: la interacción no desbloquea.
      sesion.bloquear();
      return;
    }
    ultimaActividad = ahora();
    ultimaInteraccion = ultimaActividad;
    programarAviso();
    sesion.registrarActividad().catch(alError);
  };

  const alCambiarVisibilidad = (): void => {
    if (documento?.visibilityState === 'visible') {
      // Vuelta de segundo plano: se relee la marca compartida y solo se bloquea si ninguna pestaña
      // tuvo actividad dentro del límite.
      armar();
    }
  };

  const desuscribir = sesion.suscribir((estado) => {
    const usuario = estado.usuario?.id ?? null;
    const desbloqueo = estabaBloqueada && !estado.bloqueada;
    if (usuario !== usuarioVigilado) {
      // El aviso pendiente es del usuario anterior: no sale.
      cancelarAviso();
      ultimaInteraccion = Number.NEGATIVE_INFINITY;
    }
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
    cancelarAviso();
    for (const tipo of EVENTOS_ACTIVIDAD) {
      documento?.removeEventListener(tipo, alActividad, captura);
    }
    documento?.removeEventListener('visibilitychange', alCambiarVisibilidad);
  };
}

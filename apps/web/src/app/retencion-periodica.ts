// Retención de la tablet mientras la app sigue abierta (ADR 0017 §5; F6-07). Además de al arrancar,
// la retención se aplica:
//
// - Una vez al día: una tablet de planta puede quedar días con la pestaña abierta, y sin esto los
//   perfiles caducados y las fotos ya subidas solo se purgarían al recargar.
// - Al cerrar sesión (el usuario pasa a `null`): la tablet queda en el login con las particiones de
//   los demás usuarios ya revisadas.
//
// No se usa un `setInterval` de 24 h: los navegadores congelan o retrasan los temporizadores de las
// pestañas en segundo plano y de las tablets suspendidas. Se revisa cada hora si pasó un día desde
// la última aplicación (con el reloj real), así un temporizador retrasado no salta un día.

import type { Perfil } from '@catmetal/shared';
import type { EstadoSesion } from '../auth';

/** Cada cuánto se aplica la retención con la app abierta. */
export const INTERVALO_RETENCION_MS = 24 * 60 * 60_000;
/** Cada cuánto se revisa si ya toca aplicarla. */
export const INTERVALO_REVISION_RETENCION_MS = 60 * 60_000;

/** Subconjunto del `GestorSesion` que se observa. */
export interface SesionObservada {
  usuarioDeLaSesion(): Perfil | null;
  suscribir(oyente: (estado: EstadoSesion) => void): () => void;
}

export interface TemporizadoresPeriodicos {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const TEMPORIZADORES_GLOBALES: TemporizadoresPeriodicos = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

export interface OpcionesRetencionPeriodica {
  /** Aplica la retención; `excluir` es el usuario de la sesión activa (nunca caduca). */
  aplicar: (opciones: { excluir: string | null }) => Promise<unknown>;
  sesion: SesionObservada;
  temporizadores?: TemporizadoresPeriodicos;
  ahora?: () => number;
  /** Errores de la retención (por defecto, `console.error`): nunca detienen la app. */
  alError?: (error: unknown) => void;
}

export interface RetencionPeriodica {
  /**
   * Aplica la retención ya. Si hay una en curso, no lanza otra en paralelo: la repite al terminar
   * (la que está en curso pudo empezar antes del cambio de sesión) y resuelve cuando acaba.
   */
  aplicarAhora(): Promise<void>;
  /** Detiene la revisión diaria y deja de observar la sesión. */
  detener(): void;
}

/**
 * Programa la retención diaria y al cerrar sesión. No aplica nada al crearse: el arranque llama a
 * `aplicarAhora()` antes de restaurar la sesión.
 */
export function crearRetencionPeriodica(opciones: OpcionesRetencionPeriodica): RetencionPeriodica {
  const temporizadores = opciones.temporizadores ?? TEMPORIZADORES_GLOBALES;
  const ahora = opciones.ahora ?? Date.now;
  const alError = opciones.alError ?? ((error: unknown) => console.error(error));

  let ultimaAplicacion = ahora();
  let enCurso: Promise<void> | null = null;
  let repetir = false;
  let detenida = false;

  async function ejecutar(): Promise<void> {
    try {
      do {
        repetir = false;
        ultimaAplicacion = ahora();
        try {
          await opciones.aplicar({ excluir: opciones.sesion.usuarioDeLaSesion()?.id ?? null });
        } catch (error) {
          alError(error);
        }
      } while (repetir && !detenida);
    } finally {
      // En el mismo tramo síncrono que la última comprobación de `repetir`: una petición que llegue
      // después ya no ve `enCurso` y lanza su propia aplicación (no se pierde).
      enCurso = null;
    }
  }

  function aplicarAhora(): Promise<void> {
    if (enCurso !== null) {
      repetir = true;
      return enCurso;
    }
    // `then`: `ejecutar` empieza en otro microtick, así `enCurso` ya está asignado cuando su
    // `finally` lo limpia (aunque `aplicar` falle de forma síncrona).
    const actual = Promise.resolve().then(ejecutar);
    enCurso = actual;
    return actual;
  }

  const intervalo = temporizadores.setInterval(() => {
    // `Math.abs`: si el reloj de la tablet retrocede un día o más, también se aplica.
    if (!detenida && Math.abs(ahora() - ultimaAplicacion) >= INTERVALO_RETENCION_MS) {
      void aplicarAhora();
    }
  }, INTERVALO_REVISION_RETENCION_MS);

  let usuarioPrevio = opciones.sesion.usuarioDeLaSesion()?.id ?? null;
  const dejarDeObservar = opciones.sesion.suscribir((estado) => {
    const usuarioActual = estado.usuario?.id ?? null;
    const cerro = usuarioPrevio !== null && usuarioActual === null;
    usuarioPrevio = usuarioActual;
    if (cerro && !detenida) {
      void aplicarAhora();
    }
  });

  return {
    aplicarAhora,
    detener() {
      detenida = true;
      temporizadores.clearInterval(intervalo);
      dejarDeObservar();
    },
  };
}

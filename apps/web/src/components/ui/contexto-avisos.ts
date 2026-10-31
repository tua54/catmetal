import { createContext } from 'react';

export type TonoAviso = 'info' | 'exito' | 'advertencia' | 'error';

/** Duración mínima visible de un toast (WCAG 2.2.1: tiempo suficiente para leerlo). */
export const DURACION_MINIMA_AVISO_MS = 5_000;
/** Duración por defecto de los toasts que se cierran solos. */
export const DURACION_AVISO_MS = 7_000;

export interface DatosAviso {
  tono?: TonoAviso;
  titulo: string;
  mensaje?: string;
  /**
   * Milisegundos antes de cerrarse solo (mínimo 5 000). `null` = no se cierra solo.
   * Por defecto: 7 000 ms; los de tono `error` no se cierran solos.
   */
  duracionMs?: number | null;
}

export interface ApiAvisos {
  /** Muestra un toast y devuelve su id. */
  mostrar: (aviso: DatosAviso) => string;
  cerrar: (id: string) => void;
}

export const ContextoAvisos = createContext<ApiAvisos | null>(null);

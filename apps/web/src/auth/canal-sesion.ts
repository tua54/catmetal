// Propagación de la sesión entre pestañas y ventanas del mismo origen (ADR 0023, ítem M7).
//
// - `BroadcastChannel('catmetal-sesion')`; si no existe (WebKit viejo), la clave
//   `catmetal-sesion-evento` de `localStorage` y el evento `storage` de las demás pestañas.
// - Los mensajes NUNCA llevan tokens, contraseñas ni datos del perfil: solo el tipo de evento, el
//   `user_id` afectado, el id aleatorio de la pestaña que lo emitió y la hora.
// - Una pestaña ignora sus propios mensajes (compara `origen`).
// - Todo mensaje recibido se valida: lo que no tiene la forma exacta se ignora.

import { uuidv7 } from '@catmetal/shared';

export const NOMBRE_CANAL_SESION = 'catmetal-sesion';
export const CLAVE_EVENTO_SESION = 'catmetal-sesion-evento';

export const TIPOS_EVENTO_SESION = ['logout', 'bloqueo', 'cambio-usuario'] as const;
export type TipoEventoSesion = (typeof TIPOS_EVENTO_SESION)[number];

export interface EventoSesion {
  v: 1;
  tipo: TipoEventoSesion;
  /** Usuario afectado: el que cerró sesión o se bloqueó, o el NUEVO en `cambio-usuario`. */
  user_id: string | null;
  /** Id aleatorio de la pestaña que lo emitió. */
  origen: string;
  /** Milisegundos Unix. */
  at: number;
}

export interface CanalSesion {
  /** Avisa a las demás pestañas. Nunca lanza: si el canal falla, queda la revalidación del motor. */
  emitir(tipo: TipoEventoSesion, userId: string | null): void;
  /** Se llama con cada evento de OTRA pestaña. Devuelve la función para dejar de escuchar. */
  escuchar(oyente: (evento: EventoSesion) => void): () => void;
  cerrar(): void;
}

/** Subconjunto de `BroadcastChannel` que se usa (inyectable en pruebas). */
export interface CanalDifusion {
  postMessage(mensaje: unknown): void;
  addEventListener(tipo: 'message', oyente: (evento: { data: unknown }) => void): void;
  removeEventListener(tipo: 'message', oyente: (evento: { data: unknown }) => void): void;
  close(): void;
}

/** Subconjunto de `window` para el evento `storage`. */
export interface VentanaAlmacen {
  addEventListener(
    tipo: 'storage',
    oyente: (evento: { key: string | null; newValue: string | null }) => void,
  ): void;
  removeEventListener(
    tipo: 'storage',
    oyente: (evento: { key: string | null; newValue: string | null }) => void,
  ): void;
}

export interface OpcionesCanalSesion {
  /** Fábrica del canal; `null` fuerza la alternativa con `storage`. Por defecto, `BroadcastChannel`. */
  crearCanal?: ((nombre: string) => CanalDifusion) | null;
  /** `localStorage` para la alternativa. */
  almacen?: Pick<Storage, 'setItem'> | null;
  ventana?: VentanaAlmacen | null;
  /** Id de esta pestaña (por defecto, un UUID v7 nuevo). */
  origen?: string;
  ahora?: () => number;
}

/** Valida un mensaje recibido: devuelve el evento o `null` si no tiene la forma exacta. */
export function leerEventoSesion(valor: unknown): EventoSesion | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return null;
  }
  const { v, tipo, user_id: userId, origen, at } = valor as Record<string, unknown>;
  if (
    v !== 1 ||
    typeof tipo !== 'string' ||
    !(TIPOS_EVENTO_SESION as readonly string[]).includes(tipo) ||
    (userId !== null && typeof userId !== 'string') ||
    typeof origen !== 'string' ||
    origen === '' ||
    typeof at !== 'number' ||
    !Number.isFinite(at)
  ) {
    return null;
  }
  return { v: 1, tipo: tipo as TipoEventoSesion, user_id: userId, origen, at };
}

function canalPorDefecto(): ((nombre: string) => CanalDifusion) | null {
  const Constructor = globalThis.BroadcastChannel;
  if (typeof Constructor !== 'function') {
    return null;
  }
  return (nombre) => {
    const canal = new Constructor(nombre);
    // En Node (pruebas), un canal abierto no debe mantener vivo el proceso.
    (canal as unknown as { unref?: () => void }).unref?.();
    return canal;
  };
}

function almacenPorDefecto(): Pick<Storage, 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Acceso a `localStorage` bloqueado (modo privado estricto): queda la revalidación del motor.
    return null;
  }
}

/** Crea el canal de sesión de esta pestaña. */
export function crearCanalSesion(opciones: OpcionesCanalSesion = {}): CanalSesion {
  const origen = opciones.origen ?? uuidv7();
  const ahora = opciones.ahora ?? Date.now;
  const fabrica = opciones.crearCanal === undefined ? canalPorDefecto() : opciones.crearCanal;
  const oyentes = new Set<(evento: EventoSesion) => void>();

  const entregar = (valor: unknown): void => {
    const evento = leerEventoSesion(valor);
    if (evento === null || evento.origen === origen) {
      return;
    }
    for (const oyente of oyentes) {
      oyente(evento);
    }
  };

  if (fabrica !== null) {
    const canal = fabrica(NOMBRE_CANAL_SESION);
    const alMensaje = (evento: { data: unknown }): void => entregar(evento.data);
    canal.addEventListener('message', alMensaje);
    return {
      emitir(tipo, userId) {
        const mensaje: EventoSesion = { v: 1, tipo, user_id: userId, origen, at: ahora() };
        try {
          canal.postMessage(mensaje);
        } catch {
          // Canal cerrado: no se puede avisar; el motor revalida antes de cada envío.
        }
      },
      escuchar(oyente) {
        oyentes.add(oyente);
        return () => oyentes.delete(oyente);
      },
      cerrar() {
        oyentes.clear();
        canal.removeEventListener('message', alMensaje);
        canal.close();
      },
    };
  }

  // Alternativa: `localStorage` + evento `storage` (solo lo reciben las DEMÁS pestañas).
  const almacen = opciones.almacen === undefined ? almacenPorDefecto() : opciones.almacen;
  const ventana =
    opciones.ventana === undefined
      ? ((globalThis as { window?: VentanaAlmacen }).window ?? null)
      : opciones.ventana;
  const alStorage = (evento: { key: string | null; newValue: string | null }): void => {
    if (evento.key !== CLAVE_EVENTO_SESION || evento.newValue === null) {
      return;
    }
    try {
      entregar(JSON.parse(evento.newValue));
    } catch {
      // Valor que no es JSON: se ignora.
    }
  };
  ventana?.addEventListener('storage', alStorage);
  return {
    emitir(tipo, userId) {
      const mensaje: EventoSesion = { v: 1, tipo, user_id: userId, origen, at: ahora() };
      try {
        // Se sobrescribe en cada evento; `at` cambia siempre, así que el evento `storage` se dispara
        // aunque se repita el mismo tipo.
        almacen?.setItem(CLAVE_EVENTO_SESION, JSON.stringify(mensaje));
      } catch {
        // Cuota agotada o almacenamiento bloqueado: queda la revalidación del motor.
      }
    },
    escuchar(oyente) {
      oyentes.add(oyente);
      return () => oyentes.delete(oyente);
    },
    cerrar() {
      oyentes.clear();
      ventana?.removeEventListener('storage', alStorage);
    },
  };
}

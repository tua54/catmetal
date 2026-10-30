// Propagación de la sesión entre pestañas y ventanas del mismo origen (ADR 0023, ítem M7).
//
// - `BroadcastChannel('catmetal-sesion')`; si no existe (WebKit viejo), la clave
//   `catmetal-sesion-evento` de `localStorage` y el evento `storage` de las demás pestañas.
// - Los mensajes NUNCA llevan tokens, contraseñas ni datos del perfil: solo el tipo de evento, el
//   `user_id` afectado, el id aleatorio de la pestaña que lo emitió, la hora y, en `bloqueo`, el
//   motivo.
// - Una pestaña ignora sus propios mensajes (compara `origen`).
// - Todo mensaje recibido se valida: lo que no tiene la forma exacta se ignora.
// - Inactividad compartida (ADR 0023, enmienda 1; ítem A2): el aviso `actividad` lleva la hora de
//   la última interacción de la pestaña que lo emite y, con cada uno, se escribe la marca
//   `catmetal-sesion-actividad` de `localStorage` (`{ user_id, at }`), que lee una pestaña que
//   estuvo congelada, una recién abierta o un navegador sin `BroadcastChannel`.

import { uuidv7 } from '@catmetal/shared';

export const NOMBRE_CANAL_SESION = 'catmetal-sesion';
export const CLAVE_EVENTO_SESION = 'catmetal-sesion-evento';
/** Marca compartida de la última actividad del usuario (ADR 0023, enmienda 1). */
export const CLAVE_ACTIVIDAD_SESION = 'catmetal-sesion-actividad';

export const TIPOS_EVENTO_SESION = ['logout', 'bloqueo', 'cambio-usuario', 'actividad'] as const;
export type TipoEventoSesion = (typeof TIPOS_EVENTO_SESION)[number];

/** Por qué se bloqueó la pestaña que avisa `bloqueo`. */
export const MOTIVOS_BLOQUEO = ['inactividad', 'revocacion'] as const;
export type MotivoBloqueo = (typeof MOTIVOS_BLOQUEO)[number];

export interface EventoSesion {
  v: 1;
  tipo: TipoEventoSesion;
  /**
   * Usuario afectado: el que cerró sesión, se bloqueó o tuvo actividad, o el NUEVO en
   * `cambio-usuario`. En `actividad` nunca es `null`.
   */
  user_id: string | null;
  /** Id aleatorio de la pestaña que lo emitió. */
  origen: string;
  /** Milisegundos Unix. En `actividad`, la hora de la última interacción de quien lo emite. */
  at: number;
  /**
   * Solo en `bloqueo`. Ausente si lo emitió una pestaña con el código anterior a la enmienda 1 (o
   * con un motivo desconocido): quien lo recibe se bloquea siempre, que es el lado conservador.
   */
  motivo?: MotivoBloqueo;
}

/** Contenido de la marca compartida: sin secretos ni datos del perfil. */
export interface MarcaActividad {
  user_id: string;
  at: number;
}

export interface OpcionesEmision {
  /** Hora del evento (por defecto, ahora). En `actividad`, la de la última interacción. */
  at?: number;
  /** Solo para `bloqueo`. */
  motivo?: MotivoBloqueo;
}

export interface CanalSesion {
  /**
   * Avisa a las demás pestañas. Con `actividad` también escribe la marca compartida. Nunca lanza:
   * si el canal falla, queda la revalidación del motor.
   */
  emitir(tipo: TipoEventoSesion, userId: string | null, opciones?: OpcionesEmision): void;
  /** Relee la marca compartida de actividad; `null` si no hay o no tiene la forma exacta. */
  leerMarcaActividad(): MarcaActividad | null;
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
  /** `localStorage`: la marca de actividad (siempre) y los eventos (en la alternativa). */
  almacen?: Pick<Storage, 'getItem' | 'setItem'> | null;
  ventana?: VentanaAlmacen | null;
  /** Id de esta pestaña (por defecto, un UUID v7 nuevo). */
  origen?: string;
  ahora?: () => number;
}

function esMotivoBloqueo(valor: unknown): valor is MotivoBloqueo {
  return typeof valor === 'string' && (MOTIVOS_BLOQUEO as readonly string[]).includes(valor);
}

/** Valida un mensaje recibido: devuelve el evento o `null` si no tiene la forma exacta. */
export function leerEventoSesion(valor: unknown): EventoSesion | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return null;
  }
  const { v, tipo, user_id: userId, origen, at, motivo } = valor as Record<string, unknown>;
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
  if (tipo === 'actividad' && (typeof userId !== 'string' || userId === '')) {
    // Una actividad siempre es de un usuario concreto.
    return null;
  }
  const evento: EventoSesion = {
    v: 1,
    tipo: tipo as TipoEventoSesion,
    user_id: userId,
    origen,
    at,
  };
  // Un motivo desconocido o mal formado se descarta: el `bloqueo` queda "sin motivo" y bloquea
  // siempre (lado conservador). En los demás tipos el motivo no aplica.
  if (tipo === 'bloqueo' && esMotivoBloqueo(motivo)) {
    evento.motivo = motivo;
  }
  return evento;
}

/** Valida el contenido de la marca compartida: devuelve la marca o `null`. */
export function leerMarcaActividad(texto: string | null): MarcaActividad | null {
  if (texto === null) {
    return null;
  }
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    return null;
  }
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return null;
  }
  const { user_id: userId, at } = valor as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    userId === '' ||
    typeof at !== 'number' ||
    !Number.isFinite(at)
  ) {
    return null;
  }
  return { user_id: userId, at };
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

function almacenPorDefecto(): Pick<Storage, 'getItem' | 'setItem'> | null {
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
  const almacen = opciones.almacen === undefined ? almacenPorDefecto() : opciones.almacen;
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

  const crearMensaje = (
    tipo: TipoEventoSesion,
    userId: string | null,
    extra: OpcionesEmision,
  ): EventoSesion => {
    const mensaje: EventoSesion = { v: 1, tipo, user_id: userId, origen, at: extra.at ?? ahora() };
    if (tipo === 'bloqueo' && extra.motivo !== undefined) {
      mensaje.motivo = extra.motivo;
    }
    return mensaje;
  };

  const leerMarca = (): MarcaActividad | null => {
    try {
      return leerMarcaActividad(almacen?.getItem(CLAVE_ACTIVIDAD_SESION) ?? null);
    } catch {
      // Almacenamiento bloqueado: sin marca (cuentan solo los avisos y la actividad propia).
      return null;
    }
  };

  /**
   * Escribe la marca compartida. No retrocede: si ya hay una del mismo usuario más reciente (y no
   * del futuro), se conserva. Nunca lanza.
   */
  const escribirMarca = (mensaje: EventoSesion): void => {
    if (mensaje.tipo !== 'actividad' || mensaje.user_id === null) {
      return;
    }
    const previa = leerMarca();
    if (
      previa !== null &&
      previa.user_id === mensaje.user_id &&
      previa.at >= mensaje.at &&
      previa.at <= ahora()
    ) {
      return;
    }
    const marca: MarcaActividad = { user_id: mensaje.user_id, at: mensaje.at };
    try {
      almacen?.setItem(CLAVE_ACTIVIDAD_SESION, JSON.stringify(marca));
    } catch {
      // Cuota agotada o almacenamiento bloqueado: quedan los avisos por el canal.
    }
  };

  if (fabrica !== null) {
    const canal = fabrica(NOMBRE_CANAL_SESION);
    const alMensaje = (evento: { data: unknown }): void => entregar(evento.data);
    canal.addEventListener('message', alMensaje);
    return {
      emitir(tipo, userId, extra = {}) {
        const mensaje = crearMensaje(tipo, userId, extra);
        escribirMarca(mensaje);
        try {
          canal.postMessage(mensaje);
        } catch {
          // Canal cerrado: no se puede avisar; el motor revalida antes de cada envío.
        }
      },
      leerMarcaActividad: leerMarca,
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
    emitir(tipo, userId, extra = {}) {
      const mensaje = crearMensaje(tipo, userId, extra);
      escribirMarca(mensaje);
      try {
        // Se sobrescribe en cada evento; el evento `storage` se dispara siempre que el valor cambie
        // (`at` u `origen`/`tipo` distintos).
        almacen?.setItem(CLAVE_EVENTO_SESION, JSON.stringify(mensaje));
      } catch {
        // Cuota agotada o almacenamiento bloqueado: queda la revalidación del motor.
      }
    },
    leerMarcaActividad: leerMarca,
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

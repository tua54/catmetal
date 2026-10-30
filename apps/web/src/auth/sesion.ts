// Sesión de la PWA (docs/spec.md §5; ADR 0008 puntos 1–8; ADR 0012 punto 4; ADR 0017).
//
// - El access token vive SOLO en un campo privado de esta clase: nunca en el estado publicado, ni en
//   localStorage, ni en IndexedDB. El refresh token es una cookie HttpOnly que el JS no ve.
// - Modo `online`: hay sesión del servidor (access token). Modo `offline`: el usuario se autenticó
//   contra el verificador local; puede registrar, pero la sync no corre hasta tener sesión del
//   servidor (`obtenerAccessToken()` devuelve `null`).
// - Tablet compartida: hay UNA cookie por origen. Una sesión del servidor solo se adopta si es del
//   mismo usuario de la sesión local (ADR 0008 punto 8); si no, se pide la contraseña. El token
//   queda ligado a su usuario: nunca se entrega a quien pide el de otra persona (F4-05).
// - Bloqueo por inactividad (ADR 0017 §1): `bloqueada` oculta la app tras la pantalla "Confirme que
//   es <nombre>"; la sync puede seguir enviando lo ya encolado (la sesión es legítima).
// - Límite del login offline (ADR 0017 §2–3): contador persistido por perfil, espera creciente desde
//   el 5.º fallo, borrado del verificador al 10.º y ningún verificador para el admin.
// - Entre pestañas (ADR 0023, M7): cerrar sesión, bloquear por inactividad o entrar con otro usuario
//   se avisa por el canal de sesión (sin secretos); las demás pestañas descartan su sesión en memoria
//   en el mismo tick (y vuelven al login o al bloqueo). No borran datos locales.
// - Revocación del servidor (S-09): `SESION_REVOCADA` en una petición autenticada (cambio de rol,
//   desactivación, revocación del admin) BLOQUEA la sesión (`revocada`): solo se desbloquea con la
//   contraseña contra el servidor, que trae el perfil fresco, nunca con el verificador local. El
//   perfil queda `requiere_login_online` (tampoco hay login offline hasta un login con conexión) y
//   las demás pestañas se bloquean (`bloqueo` por el canal).
// - Bajada de rol (S-03): si el perfil nuevo del servidor ya no ve lo de todos, los consumos ajenos
//   sin pendientes se borran de la partición al guardarlo (`purgarAjenosSinVisibilidad`).

import {
  loginSchema,
  MENSAJES_ERROR,
  uuidv7,
  type Perfil,
  type Permiso,
  type RespuestaSesion,
} from '@catmetal/shared';
import { db, obtenerInstalacionId, tablasDeDatos } from '../datos/db';
import {
  borrarDatosDeUsuario,
  pendientesPorUsuario,
  puedeBorrarDatosDeUsuario,
} from '../datos/outbox';
import type { PerfilLocal, VerificadorLocal } from '../datos/tipos';
import { purgarAjenosSinVisibilidad, tieneVisibilidadAmplia } from '../datos/visibilidad';
import { crearCanalSesion, type CanalSesion, type EventoSesion } from './canal-sesion';
import {
  conCandado,
  DURACION_CANDADO_SYNC_MS,
  NOMBRE_CANDADO_SYNC,
  type GestorCandados,
} from './candado';
import {
  crearClienteApi,
  ErrorApi,
  ErrorRed,
  type ClienteApi,
  type TokenEsperado,
} from './cliente-api';
import {
  comprobarVerificador,
  crearVerificador,
  ITERACIONES_VERIFICADOR,
  type OpcionesComprobacion,
} from './verificador';

export type ModoSesion = 'sin_sesion' | 'online' | 'offline';

export interface EstadoSesion {
  modo: ModoSesion;
  usuario: Perfil | null;
  permisos: readonly Permiso[];
  device_id: string | null;
  /**
   * La sesión del servidor no existe, fue revocada o la cookie es de otra persona: la sync espera a
   * que el usuario vuelva a escribir su contraseña con conexión.
   */
  requiere_contrasena: boolean;
  /**
   * Bloqueo por inactividad (ADR 0017 §1): la UI solo muestra "Confirme que es <nombre>" hasta que
   * el usuario confirme su contraseña o elija "No soy <nombre>". La sync no se detiene.
   */
  bloqueada: boolean;
  /**
   * S-09: el servidor revocó la sesión (`SESION_REVOCADA` en una petición autenticada). Va con
   * `bloqueada`: la app queda oculta y solo se desbloquea con la contraseña CON conexión. Opcional en
   * el tipo (estados simulados de pruebas); el gestor siempre lo publica.
   */
  revocada?: boolean;
}

export const ESTADO_SIN_SESION: EstadoSesion = Object.freeze({
  modo: 'sin_sesion',
  usuario: null,
  permisos: [],
  device_id: null,
  requiere_contrasena: false,
  bloqueada: false,
  revocada: false,
});

export type CodigoErrorSesion =
  'CREDENCIALES_INVALIDAS' | 'SIN_LOGIN_PREVIO' | 'VALIDACION' | 'ESPERA_INTENTOS' | 'SIN_CONEXION';

export const MENSAJE_ESPERA_INTENTOS =
  'Demasiados intentos en esta tablet. Intente más tarde o con conexión.';
export const MENSAJE_SIN_CONEXION_CONFIRMAR =
  'No hay conexión con el servidor para confirmar su contraseña. Intente cuando vuelva la señal.';

const MENSAJES_SESION: Readonly<Record<CodigoErrorSesion, string>> = {
  // El mismo mensaje genérico del servidor: no revela si falló el correo o la contraseña.
  CREDENCIALES_INVALIDAS: MENSAJES_ERROR.CREDENCIALES_INVALIDAS,
  SIN_LOGIN_PREVIO:
    'No hay conexión. Para entrar sin conexión, primero inicie sesión con conexión en este dispositivo.',
  VALIDACION: MENSAJES_ERROR.VALIDACION,
  ESPERA_INTENTOS: MENSAJE_ESPERA_INTENTOS,
  SIN_CONEXION: MENSAJE_SIN_CONEXION_CONFIRMAR,
};

/** Error local de la sesión (login offline o datos de entrada). Los del servidor son `ErrorApi`. */
export class ErrorSesion extends Error {
  override readonly name = 'ErrorSesion';
  readonly code: CodigoErrorSesion;

  constructor(code: CodigoErrorSesion) {
    super(MENSAJES_SESION[code]);
    this.code = code;
  }
}

export interface ResultadoCierre {
  /** Se revocó la sesión en el servidor. Si no (sin conexión), queda marcada para revocarla luego. */
  servidor_notificado: boolean;
  /** Se borraron los datos locales del usuario (solo si no tenía pendientes). */
  datos_borrados: boolean;
  /**
   * Pendientes que impidieron borrar: la UI debe advertir al usuario. `fotos_bloqueadas` son
   * fotos que el servidor no aceptó y nunca llegaron allí (B9): se conservan aunque no se reenvíen solas.
   */
  pendientes: { mutaciones: number; evidencias: number; fotos_bloqueadas: number };
}

export interface AvisoPendientes {
  user_id: string;
  nombre: string | null;
  mutaciones: number;
  evidencias: number;
  total: number;
  /** "Hay N registros pendientes de <nombre>". */
  mensaje: string;
}

/** Perfil guardado en el dispositivo, sin el verificador. */
export interface PerfilDelDispositivo {
  user_id: string;
  nombre: string;
  /** Correo completo: solo para iniciar sesión, nunca se muestra sin autenticar (F4-04). */
  email: string;
  /** "j***@catmetal.test": lo que muestra el login. */
  email_enmascarado: string;
  ultimo_acceso_at: string | null;
  /** Puede entrar sin conexión (inició sesión con conexión en este dispositivo). */
  offline_disponible: boolean;
}

export interface OpcionesSesion {
  base?: string;
  fetch?: typeof fetch;
  /** `null` fuerza la alternativa a Web Locks; por defecto, `navigator.locks` si existe. */
  locks?: GestorCandados | null;
  /** Solo para pruebas: iteraciones del verificador nuevo. */
  iteraciones?: number;
  /** Solo para pruebas: mínimo de iteraciones aceptadas (por defecto, 100.000; ADR 0017 §6). */
  iteracionesMinimas?: number;
  enLinea?: () => boolean;
  ahora?: () => number;
  agenteUsuario?: string;
  candado?: { duracionMs?: number; intervaloMs?: number };
  /**
   * Canal entre pestañas (ADR 0023). Por defecto ninguno: la sesión única de la PWA (`sesion`) usa
   * `crearCanalSesion()`; las pruebas pasan el suyo.
   */
  canal?: CanalSesion | null;
}

export const NOMBRE_CANDADO_REFRESH = 'catmetal-refresh';
/** Se refresca el access token si le quedan menos de 30 s. */
const MARGEN_EXPIRACION_MS = 30_000;

// Constantes de la ADR 0017 (para revertir o ajustar, cambie estos valores).
/** Minutos sin interacción tras los que se bloquea la sesión (§1). */
export const MINUTOS_INACTIVIDAD = 10;
export const LIMITE_INACTIVIDAD_MS = MINUTOS_INACTIVIDAD * 60_000;
/** Como mucho una escritura de `ultimo_acceso_at` por minuto por la actividad del usuario. */
export const INTERVALO_REGISTRO_ACTIVIDAD_MS = 60_000;
/** Desde este fallo consecutivo hay espera entre intentos offline (§2). */
export const FALLOS_ANTES_DE_ESPERA = 5;
/** En este fallo consecutivo se borra el verificador: solo se podrá entrar con conexión (§2). */
export const FALLOS_PARA_BORRAR_VERIFICADOR = 10;
export const ESPERA_BASE_MS = 30_000;
export const ESPERA_MAXIMA_MS = 15 * 60_000;

/** Espera tras `fallos` fallos consecutivos: 30 s × 2^(n−5) desde el 5.º, con tope de 15 min. */
export function esperaTrasFallos(fallos: number): number {
  if (fallos < FALLOS_ANTES_DE_ESPERA) {
    return 0;
  }
  return Math.min(ESPERA_BASE_MS * 2 ** (fallos - FALLOS_ANTES_DE_ESPERA), ESPERA_MAXIMA_MS);
}

/** "juan@catmetal.test" → "j***@catmetal.test" (el login no muestra correos completos, F4-04). */
export function enmascararCorreo(email: string): string {
  const arroba = email.lastIndexOf('@');
  if (arroba <= 0) {
    return '***';
  }
  return `${email.charAt(0)}***${email.slice(arroba)}`;
}

/** "Tablet · Chrome" a partir del user agent (se guarda en `devices.nombre`). */
export function nombreDispositivo(agente: string): string {
  const navegadores: [RegExp, string][] = [
    [/Edg\//, 'Edge'],
    [/SamsungBrowser\//, 'Samsung Internet'],
    [/CriOS\/|Chrome\//, 'Chrome'],
    [/FxiOS\/|Firefox\//, 'Firefox'],
    [/Safari\//, 'Safari'],
  ];
  const navegador = navegadores.find(([patron]) => patron.test(agente))?.[1] ?? 'Navegador';
  return `Tablet · ${navegador}`;
}

function mensajePendientes(total: number, nombre: string | null): string {
  const registros = total === 1 ? 'registro pendiente' : 'registros pendientes';
  return `Hay ${total} ${registros} de ${nombre ?? 'otro usuario'}`;
}

type Oyente = (estado: EstadoSesion) => void;

/** Resultado de un refresh: el token y el usuario al que pertenece. */
interface ResultadoRefresco {
  token: string;
  user_id: string;
}

/** Resultado de un intento contra el verificador local. */
type IntentoLocal = 'ok' | 'fallo' | 'espera' | 'sin_verificador';

interface CambiosPerfil {
  /** `undefined` conserva el verificador anterior. El admin nunca tiene verificador. */
  verificador?: VerificadorLocal | null;
  /** Es un acceso del usuario (login o confirmación): actualiza `ultimo_acceso_at`. */
  acceso: boolean;
  /** Un login correcto reinicia el contador de intentos offline. */
  reiniciarIntentos?: boolean;
}

function esCaidaDelServidor(error: unknown): boolean {
  return error instanceof ErrorRed || (error instanceof ErrorApi && error.status >= 500);
}

export class GestorSesion {
  readonly api: ClienteApi;
  readonly #opciones: OpcionesSesion;
  #estado: EstadoSesion = ESTADO_SIN_SESION;
  #token: string | null = null;
  /** Usuario al que pertenece `#token` (F4-05). */
  #tokenUsuario: string | null = null;
  #expiraEn = 0;
  #refrescoEnCurso: Promise<ResultadoRefresco | null> | null = null;
  /** Se aborta cada vez que cambia el usuario de la sesión o se cierra (la sync en vuelo se corta). */
  #control = new AbortController();
  /** `cerrarSesion` en curso: no se entregan más tokens. */
  #cerrando = false;
  #actividadGuardadaEn = Number.NEGATIVE_INFINITY;
  readonly #oyentes = new Set<Oyente>();
  readonly #canal: CanalSesion | null;

  constructor(opciones: OpcionesSesion = {}) {
    this.#opciones = opciones;
    this.#canal = opciones.canal ?? null;
    this.#canal?.escuchar((evento) => this.#alEventoDeOtraPestana(evento));
    this.api = crearClienteApi({
      base: opciones.base,
      fetch: opciones.fetch,
      proveedor: {
        obtenerAccessToken: (ligado) => this.obtenerAccessToken(ligado),
        refrescar: (ligado) => this.refrescar(ligado),
        usuarioActual: () => this.#estado.usuario?.id ?? null,
        // S-09: la revocación de una petición autenticada bloquea la sesión.
        sesionRevocada: () => this.marcarSesionRevocada(),
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Estado y eventos
  // -------------------------------------------------------------------------------------------

  estado(): EstadoSesion {
    return this.#estado;
  }

  usuarioDeLaSesion(): Perfil | null {
    return this.#estado.usuario;
  }

  /**
   * Señal que se aborta cuando cambia el usuario de la sesión o se cierra. El motor de sync la pasa
   * a sus peticiones: una sync en vuelo nunca sobrevive al cambio de sesión (F4-05).
   */
  senalDeSesion(): AbortSignal {
    return this.#control.signal;
  }

  /**
   * El servidor dijo que la sesión no corresponde al autor (`AUTOR_NO_COINCIDE`) u otra señal de
   * que la sesión del servidor no es confiable: se descarta el token y se pide la contraseña.
   */
  marcarRequiereContrasena(): void {
    this.#perderSesionDelServidor();
  }

  /**
   * S-09: el servidor respondió `SESION_REVOCADA` a una petición autenticada de esta sesión (cambio
   * de rol, desactivación o revocación del admin). En el mismo tick: se descarta el token, se cortan
   * las peticiones en vuelo y la sesión queda bloqueada (`revocada`), sin mostrar más datos. Luego se
   * marca el perfil (`requiere_login_online`) y se avisa a las demás pestañas (`bloqueo`). No borra
   * datos locales: los pendientes salen cuando la persona vuelva a entrar con conexión.
   */
  marcarSesionRevocada(): void {
    const usuario = this.#estado.usuario;
    this.#olvidarToken();
    if (usuario === null) {
      return;
    }
    this.#renovarSenal();
    this.#publicar({
      ...this.#estado,
      modo: 'offline',
      requiere_contrasena: true,
      bloqueada: true,
      revocada: true,
    });
    // Primero la marca persistida y después el aviso: la otra pestaña, al bloquearse, ya la lee.
    void this.#marcarLoginOnline(usuario.id).finally(() =>
      this.#avisarOtrasPestanas('bloqueo', usuario.id),
    );
  }

  /** El perfil solo vuelve a entrar con un login contra el servidor (S-09). Nunca lanza. */
  async #marcarLoginOnline(userId: string): Promise<void> {
    try {
      await db.perfiles.update(userId, { requiere_login_online: true });
    } catch {
      // Sin IndexedDB disponible queda el bloqueo en memoria de esta pestaña.
    }
  }

  /** Se llama con cada cambio de estado. Devuelve la función para desuscribirse. */
  suscribir(oyente: Oyente): () => void {
    this.#oyentes.add(oyente);
    return () => this.#oyentes.delete(oyente);
  }

  #publicar(estado: EstadoSesion): void {
    const previo = this.#estado.usuario?.id ?? null;
    // `revocada` siempre presente: el store de React mezcla estados y no debe quedarse con uno viejo.
    this.#estado = Object.freeze({
      ...estado,
      revocada: estado.revocada ?? false,
      permisos: Object.freeze([...estado.permisos]),
    });
    if ((estado.usuario?.id ?? null) !== previo) {
      this.#renovarSenal();
      this.#actividadGuardadaEn = Number.NEGATIVE_INFINITY;
    }
    for (const oyente of this.#oyentes) {
      oyente(this.#estado);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Otras pestañas (ADR 0023)
  // -------------------------------------------------------------------------------------------

  /**
   * Otra pestaña cerró sesión, se bloqueó o entró con otro usuario. En el mismo tick: se descarta el
   * access token, se corta la sync en vuelo (señal de sesión) y se publica el estado nuevo, con lo
   * que la UI vuelve al login o al bloqueo. No se borran datos locales: lo decide la pestaña que
   * cerró sesión, con la regla de pendientes (§5). Esta pestaña no reenvía el aviso.
   */
  #alEventoDeOtraPestana(evento: EventoSesion): void {
    const actual = this.#estado.usuario;
    if (actual === null) {
      return;
    }
    const descartar = (): void => {
      this.#olvidarToken();
      this.#publicar(ESTADO_SIN_SESION);
    };
    switch (evento.tipo) {
      case 'logout':
        // Tablet compartida: tras un cierre de sesión en otra pestaña, ninguna sigue abierta.
        descartar();
        return;
      case 'cambio-usuario':
        // Otra persona entró (y la cookie de refresco ya es suya): esta pestaña vuelve al login.
        if (evento.user_id !== actual.id) {
          descartar();
        }
        return;
      case 'bloqueo':
        // Bloqueo del mismo usuario: esta pestaña también pide "Confirme que es <nombre>".
        if (evento.user_id === actual.id && !this.#estado.bloqueada) {
          this.#olvidarToken();
          this.#renovarSenal();
          this.#publicar({ ...this.#estado, bloqueada: true });
          // S-09: si el bloqueo vino de una revocación, el perfil ya está marcado: esta pestaña
          // también exige la contraseña contra el servidor (y lo muestra).
          void this.#adoptarRevocacion(actual.id);
        }
        return;
    }
  }

  async #adoptarRevocacion(userId: string): Promise<void> {
    let marcado: boolean;
    try {
      marcado = (await db.perfiles.get(userId))?.requiere_login_online === true;
    } catch {
      return;
    }
    if (marcado && this.#estado.usuario?.id === userId && this.#estado.bloqueada) {
      this.#publicar({
        ...this.#estado,
        modo: 'offline',
        requiere_contrasena: true,
        revocada: true,
      });
    }
  }

  #avisarOtrasPestanas(tipo: EventoSesion['tipo'], userId: string | null): void {
    this.#canal?.emitir(tipo, userId);
  }

  #renovarSenal(): void {
    this.#control.abort(new DOMException('La sesión cambió.', 'AbortError'));
    this.#control = new AbortController();
  }

  #ahora(): number {
    return (this.#opciones.ahora ?? Date.now)();
  }

  #ahoraIso(): string {
    return new Date(this.#ahora()).toISOString();
  }

  #enLinea(): boolean {
    return this.#opciones.enLinea?.() ?? globalThis.navigator?.onLine ?? true;
  }

  #comprobacion(): OpcionesComprobacion {
    return this.#opciones.iteracionesMinimas === undefined
      ? {}
      : { minimoIteraciones: this.#opciones.iteracionesMinimas };
  }

  #guardarToken(respuesta: RespuestaSesion): void {
    this.#token = respuesta.access_token;
    this.#tokenUsuario = respuesta.usuario.id;
    this.#expiraEn = this.#ahora() + respuesta.expira_en * 1000;
  }

  #olvidarToken(): void {
    this.#token = null;
    this.#tokenUsuario = null;
    this.#expiraEn = 0;
  }

  /** La sesión del servidor ya no sirve: se sigue offline (si hay usuario) y se pide contraseña. */
  #perderSesionDelServidor(): void {
    this.#olvidarToken();
    if (this.#estado.usuario !== null) {
      this.#publicar({ ...this.#estado, modo: 'offline', requiere_contrasena: true });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Perfiles locales
  // -------------------------------------------------------------------------------------------

  async #perfilPorEmail(email: string): Promise<PerfilLocal | undefined> {
    const perfiles = await db.perfiles.toArray();
    return perfiles
      .filter((p) => p.perfil.email === email)
      .sort((a, b) => (b.ultimo_acceso_at ?? '').localeCompare(a.ultimo_acceso_at ?? ''))[0];
  }

  async #guardarPerfil(respuesta: RespuestaSesion, cambios: CambiosPerfil): Promise<void> {
    const ahora = this.#ahoraIso();
    // S-03: el perfil guardado veía lo de todos y el nuevo del servidor ya no (bajada de rol). Lo
    // ajeno sin pendientes se borra en la MISMA transacción que guarda el perfil nuevo: si falla, el
    // perfil viejo queda y el próximo login lo vuelve a intentar.
    const anterior = await db.perfiles.get(respuesta.usuario.id);
    const perdioVisibilidad =
      anterior !== undefined &&
      tieneVisibilidadAmplia(anterior.perfil.permisos) &&
      !tieneVisibilidadAmplia(respuesta.usuario.permisos);
    await db.transaction('rw', perdioVisibilidad ? tablasDeDatos() : [db.perfiles], async () => {
      const previo = await db.perfiles.get(respuesta.usuario.id);
      // ADR 0017 §3: el admin no trabaja offline; nunca tiene verificador (y se borra uno anterior).
      const verificador =
        respuesta.usuario.rol === 'admin'
          ? null
          : cambios.verificador !== undefined
            ? cambios.verificador
            : (previo?.verificador ?? null);
      await db.perfiles.put({
        user_id: respuesta.usuario.id,
        perfil: respuesta.usuario,
        device_id: respuesta.device_id,
        verificador,
        actualizado_at: ahora,
        ultimo_acceso_at: cambios.acceso ? ahora : (previo?.ultimo_acceso_at ?? null),
        cierre_pendiente: false,
        intentos_offline: cambios.reiniciarIntentos === true ? 0 : (previo?.intentos_offline ?? 0),
        espera_hasta: cambios.reiniciarIntentos === true ? null : (previo?.espera_hasta ?? null),
        // S-09: el servidor acaba de aceptar esta sesión con el perfil vigente.
        requiere_login_online: false,
      });
      if (perdioVisibilidad) {
        await purgarAjenosSinVisibilidad(respuesta.usuario.id);
      }
    });
  }

  /** El último acceso del perfil fue hace menos de `LIMITE_INACTIVIDAD_MS` (no hace falta bloquear). */
  #accesoReciente(perfil: PerfilLocal | undefined): boolean {
    if (perfil?.ultimo_acceso_at === null || perfil?.ultimo_acceso_at === undefined) {
      return false;
    }
    const ultimo = Date.parse(perfil.ultimo_acceso_at);
    return Number.isFinite(ultimo) && Math.abs(this.#ahora() - ultimo) <= LIMITE_INACTIVIDAD_MS;
  }

  /** Perfiles guardados en este dispositivo, el más reciente primero (sin verificadores). */
  async perfilesDelDispositivo(): Promise<PerfilDelDispositivo[]> {
    const perfiles = await db.perfiles.toArray();
    return perfiles
      .sort((a, b) => (b.ultimo_acceso_at ?? '').localeCompare(a.ultimo_acceso_at ?? ''))
      .map((p) => ({
        user_id: p.user_id,
        nombre: p.perfil.nombre,
        email: p.perfil.email,
        email_enmascarado: enmascararCorreo(p.perfil.email),
        ultimo_acceso_at: p.ultimo_acceso_at,
        // S-09: tras una revocación, solo con conexión.
        offline_disponible: p.verificador !== null && p.requiere_login_online !== true,
      }));
  }

  /**
   * Un intento contra el verificador local, con el contador persistido del perfil (ADR 0017 §2):
   * durante la espera no se deriva nada; desde el 5.º fallo consecutivo hay espera creciente; al
   * 10.º se borra el verificador. Un acierto reinicia el contador y registra el acceso.
   */
  async #intentoLocal(userId: string, password: string): Promise<IntentoLocal> {
    const perfil = await db.perfiles.get(userId);
    if (
      perfil?.verificador === null ||
      perfil?.verificador === undefined ||
      perfil.requiere_login_online === true
    ) {
      // S-09: tras una revocación del servidor el verificador no sirve hasta un login con conexión.
      return 'sin_verificador';
    }
    const espera = perfil.espera_hasta ?? null;
    if (espera !== null && Date.parse(espera) > this.#ahora()) {
      return 'espera';
    }
    // La derivación (≈ 1 s) va fuera de la transacción: esperar WebCrypto dentro la cerraría.
    const correcta = await comprobarVerificador(password, perfil.verificador, this.#comprobacion());
    const revocadoMientras = await db.transaction('rw', db.perfiles, async () => {
      const actual = await db.perfiles.get(userId);
      if (actual === undefined) {
        return false;
      }
      if (actual.requiere_login_online === true) {
        // La revocación llegó mientras se derivaba (S-09): ni se acepta ni cuenta como fallo.
        return true;
      }
      if (correcta) {
        await db.perfiles.put({
          ...actual,
          intentos_offline: 0,
          espera_hasta: null,
          ultimo_acceso_at: this.#ahoraIso(),
          cierre_pendiente: false,
        });
        return false;
      }
      const fallos = (actual.intentos_offline ?? 0) + 1;
      if (fallos >= FALLOS_PARA_BORRAR_VERIFICADOR) {
        await db.perfiles.put({
          ...actual,
          verificador: null,
          intentos_offline: 0,
          espera_hasta: null,
        });
        return false;
      }
      const ms = esperaTrasFallos(fallos);
      await db.perfiles.put({
        ...actual,
        intentos_offline: fallos,
        espera_hasta: ms > 0 ? new Date(this.#ahora() + ms).toISOString() : null,
      });
      return false;
    });
    if (revocadoMientras) {
      return 'sin_verificador';
    }
    return correcta ? 'ok' : 'fallo';
  }

  /**
   * F4-03: el servidor rechazó la contraseña. Si el verificador local la acepta, ya no es válida
   * (cambio de contraseña, usuario desactivado o bloqueado): se borra el verificador.
   */
  async #invalidarVerificadorSiCoincide(
    perfil: PerfilLocal | undefined,
    password: string,
  ): Promise<void> {
    if (perfil?.verificador === null || perfil?.verificador === undefined) {
      return;
    }
    if (await comprobarVerificador(password, perfil.verificador, this.#comprobacion())) {
      await db.perfiles.update(perfil.user_id, {
        verificador: null,
        intentos_offline: 0,
        espera_hasta: null,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------------------------

  /**
   * Inicia sesión. Con red: `POST /auth/login` y se guarda el verificador local. Sin red (o si el
   * servidor no responde / responde 5xx): login offline contra el verificador. Un rechazo del
   * servidor (credenciales, bloqueo, origen) NUNCA cae al login offline.
   */
  async iniciarSesion(email: string, password: string): Promise<EstadoSesion> {
    const datos = loginSchema.pick({ email: true, password: true }).safeParse({ email, password });
    if (!datos.success) {
      throw new ErrorSesion('VALIDACION');
    }
    if (this.#enLinea()) {
      try {
        return await this.#loginOnline(datos.data.email, datos.data.password);
      } catch (error) {
        if (!esCaidaDelServidor(error)) {
          throw error;
        }
      }
    }
    return this.#loginOffline(datos.data.email, datos.data.password);
  }

  async #loginOnline(email: string, password: string): Promise<EstadoSesion> {
    const existente = await this.#perfilPorEmail(email);
    let respuesta: RespuestaSesion;
    try {
      respuesta = await this.api.peticion<RespuestaSesion>('/auth/login', {
        metodo: 'POST',
        autenticar: false,
        cuerpo: {
          email,
          password,
          device_id: existente?.device_id ?? uuidv7(),
          instalacion_id: await obtenerInstalacionId(),
          device_nombre: nombreDispositivo(
            this.#opciones.agenteUsuario ?? globalThis.navigator?.userAgent ?? '',
          ),
        },
      });
    } catch (error) {
      if (error instanceof ErrorApi && error.code === 'CREDENCIALES_INVALIDAS') {
        await this.#invalidarVerificadorSiCoincide(existente, password);
      }
      throw error;
    }
    // El verificador se deriva de la contraseña ya aceptada por el servidor y se queda en el
    // dispositivo. Nunca forma parte de ningún cuerpo enviado. El admin no tiene (ADR 0017 §3).
    const verificador =
      respuesta.usuario.rol === 'admin'
        ? null
        : await crearVerificador(password, this.#opciones.iteraciones ?? ITERACIONES_VERIFICADOR);
    await this.#guardarPerfil(respuesta, { verificador, acceso: true, reiniciarIntentos: true });
    this.#guardarToken(respuesta);
    this.#publicar({
      modo: 'online',
      usuario: respuesta.usuario,
      permisos: respuesta.usuario.permisos,
      device_id: respuesta.device_id,
      requiere_contrasena: false,
      bloqueada: false,
    });
    // La cookie de refresco ya es de este usuario: las pestañas de otro usuario vuelven al login.
    this.#avisarOtrasPestanas('cambio-usuario', respuesta.usuario.id);
    return this.#estado;
  }

  async #loginOffline(email: string, password: string): Promise<EstadoSesion> {
    const perfil = await this.#perfilPorEmail(email);
    if (perfil?.verificador === null || perfil?.verificador === undefined) {
      throw new ErrorSesion('SIN_LOGIN_PREVIO');
    }
    const intento = await this.#intentoLocal(perfil.user_id, password);
    if (intento === 'espera') {
      throw new ErrorSesion('ESPERA_INTENTOS');
    }
    if (intento === 'sin_verificador') {
      throw new ErrorSesion('SIN_LOGIN_PREVIO');
    }
    if (intento === 'fallo') {
      throw new ErrorSesion('CREDENCIALES_INVALIDAS');
    }
    this.#olvidarToken();
    this.#publicar({
      modo: 'offline',
      usuario: perfil.perfil,
      permisos: perfil.perfil.permisos,
      device_id: perfil.device_id,
      requiere_contrasena: false,
      bloqueada: false,
    });
    this.#avisarOtrasPestanas('cambio-usuario', perfil.user_id);
    return this.#estado;
  }

  // -------------------------------------------------------------------------------------------
  // Bloqueo por inactividad (ADR 0017 §1)
  // -------------------------------------------------------------------------------------------

  /**
   * Bloquea la sesión (inactividad o vuelta de segundo plano). La sync de esta pestaña sigue. Las
   * demás pestañas del mismo usuario también se bloquean (ADR 0023).
   */
  bloquear(): void {
    const usuario = this.#estado.usuario;
    if (usuario !== null && !this.#estado.bloqueada) {
      this.#publicar({ ...this.#estado, bloqueada: true });
      this.#avisarOtrasPestanas('bloqueo', usuario.id);
    }
  }

  /**
   * El usuario interactuó: actualiza `ultimo_acceso_at` como mucho una vez por minuto (decide el
   * bloqueo al recargar y la caducidad del perfil). Bloqueada, la actividad no cuenta.
   */
  async registrarActividad(): Promise<void> {
    const usuario = this.#estado.usuario;
    if (usuario === null || this.#estado.bloqueada) {
      return;
    }
    const ahora = this.#ahora();
    if (ahora - this.#actividadGuardadaEn < INTERVALO_REGISTRO_ACTIVIDAD_MS) {
      return;
    }
    this.#actividadGuardadaEn = ahora;
    await db.perfiles.update(usuario.id, { ultimo_acceso_at: new Date(ahora).toISOString() });
  }

  /**
   * "Confirme que es <nombre>": primero contra el verificador local (sin red, con el contador de
   * intentos); si no hay verificador o no coincide y hay red, con un login online (que también sirve
   * si la contraseña cambió en el servidor). "No soy <nombre>" es `cerrarSesion()`.
   */
  async confirmarIdentidad(password: string): Promise<EstadoSesion> {
    const usuario = this.#estado.usuario;
    if (usuario === null || !this.#estado.bloqueada) {
      return this.#estado;
    }
    if (password === '') {
      throw new ErrorSesion('VALIDACION');
    }
    if (this.#estado.revocada === true) {
      // S-09: solo contra el servidor (perfil fresco). Sin red, sigue bloqueada.
      if (!this.#enLinea()) {
        throw new ErrorSesion('SIN_CONEXION');
      }
      try {
        return await this.#loginOnline(usuario.email, password);
      } catch (error) {
        throw esCaidaDelServidor(error) ? new ErrorSesion('SIN_CONEXION') : error;
      }
    }
    const intento = await this.#intentoLocal(usuario.id, password);
    if (this.#estado.usuario?.id !== usuario.id) {
      // Mientras se verificaba, alguien eligió "No soy <nombre>": no se desbloquea nada.
      return this.#estado;
    }
    if (intento === 'ok') {
      this.#publicar({ ...this.#estado, bloqueada: false });
      return this.#estado;
    }
    if (this.#enLinea()) {
      try {
        return await this.#loginOnline(usuario.email, password);
      } catch (error) {
        if (!esCaidaDelServidor(error)) {
          throw error;
        }
      }
    }
    if (intento === 'espera') {
      throw new ErrorSesion('ESPERA_INTENTOS');
    }
    throw new ErrorSesion(intento === 'fallo' ? 'CREDENCIALES_INVALIDAS' : 'SIN_CONEXION');
  }

  // -------------------------------------------------------------------------------------------
  // Refresh y token
  // -------------------------------------------------------------------------------------------

  /**
   * `POST /auth/refresh`, serializado entre pestañas (Web Locks o alternativa) y compartido dentro
   * de la pestaña: N llamadas simultáneas hacen UNA petición. Devuelve el access token o `null`.
   * Con `esperado`, solo devuelve un token de ESE usuario (F4-05): si la sesión ya es de otra
   * persona, ni siquiera llama al servidor.
   */
  refrescar(ligado: TokenEsperado = {}): Promise<string | null> {
    const { esperado } = ligado;
    if (esperado !== undefined && this.#estado.usuario?.id !== esperado) {
      return Promise.resolve(null);
    }
    if (this.#refrescoEnCurso === null) {
      const enCurso = conCandado(NOMBRE_CANDADO_REFRESH, () => this.#refrescarConCandado(), {
        locks: this.#opciones.locks,
        duracionMs: this.#opciones.candado?.duracionMs,
        intervaloMs: this.#opciones.candado?.intervaloMs,
      }).finally(() => {
        this.#refrescoEnCurso = null;
      });
      this.#refrescoEnCurso = enCurso;
    }
    return this.#refrescoEnCurso.then((r) =>
      r !== null && (esperado === undefined || r.user_id === esperado) ? r.token : null,
    );
  }

  async #refrescarConCandado(): Promise<ResultadoRefresco | null> {
    let respuesta: RespuestaSesion;
    try {
      respuesta = await this.api.peticion<RespuestaSesion>('/auth/refresh', {
        metodo: 'POST',
        autenticar: false,
      });
    } catch (error) {
      if (error instanceof ErrorApi && error.status === 401) {
        // TOKEN_INVALIDO o SESION_REVOCADA: no hay sesión del servidor para este navegador.
        this.#perderSesionDelServidor();
        return null;
      }
      if (error instanceof ErrorApi || error instanceof ErrorRed) {
        return null;
      }
      throw error;
    }
    return this.#adoptar(respuesta);
  }

  async #adoptar(respuesta: RespuestaSesion): Promise<ResultadoRefresco | null> {
    const local = this.#estado.usuario;
    if (local !== null && local.id !== respuesta.usuario.id) {
      // La cookie es de otra persona que inició sesión en esta tablet: nunca se adopta su sesión
      // para el usuario local (ADR 0008 punto 8). Se pide la contraseña.
      this.#perderSesionDelServidor();
      return null;
    }
    const cambio = (): boolean => (this.#estado.usuario?.id ?? null) !== (local?.id ?? null);
    if (local === null) {
      const perfil = await db.perfiles.get(respuesta.usuario.id);
      if (perfil?.cierre_pendiente === true) {
        // Ese usuario cerró sesión sin conexión: se revoca ahora y no se adopta.
        await this.#revocarEnServidor(respuesta.access_token);
        await db.perfiles.put({ ...perfil, cierre_pendiente: false });
        return null;
      }
      // ADR 0017 §1: una sesión de la cookie con el último acceso viejo (o desconocido) se publica
      // BLOQUEADA: la UI solo ofrece "Confirme que es <nombre>" o "No soy <nombre>".
      const reciente = this.#accesoReciente(perfil);
      await this.#guardarPerfil(respuesta, { acceso: reciente });
      if (cambio()) {
        // Mientras tanto alguien inició sesión en esta pestaña: no se pisa su sesión.
        return null;
      }
      this.#guardarToken(respuesta);
      this.#publicar({
        modo: 'online',
        usuario: respuesta.usuario,
        permisos: respuesta.usuario.permisos,
        device_id: respuesta.device_id,
        requiere_contrasena: false,
        bloqueada: !reciente,
      });
      return { token: respuesta.access_token, user_id: respuesta.usuario.id };
    }
    await this.#guardarPerfil(respuesta, { acceso: false });
    if (cambio()) {
      return null;
    }
    this.#guardarToken(respuesta);
    this.#publicar({
      modo: 'online',
      usuario: respuesta.usuario,
      permisos: respuesta.usuario.permisos,
      device_id: respuesta.device_id,
      requiere_contrasena: false,
      bloqueada: this.#estado.bloqueada,
    });
    return { token: respuesta.access_token, user_id: respuesta.usuario.id };
  }

  /**
   * Access token vigente del usuario de la sesión: refresca si le quedan menos de 30 s. `null` si no
   * hay usuario, si es de otro usuario que `esperado`, si la sesión es offline sin sesión del
   * servidor recuperable, si se requiere contraseña o si la sesión se está cerrando.
   */
  async obtenerAccessToken(ligado: TokenEsperado = {}): Promise<string | null> {
    const usuario = this.#estado.usuario;
    if (usuario === null || this.#cerrando) {
      return null;
    }
    if (ligado.esperado !== undefined && usuario.id !== ligado.esperado) {
      return null;
    }
    if (
      this.#token !== null &&
      this.#tokenUsuario === usuario.id &&
      this.#ahora() < this.#expiraEn - MARGEN_EXPIRACION_MS
    ) {
      return this.#token;
    }
    if (this.#estado.requiere_contrasena) {
      return null;
    }
    return this.refrescar({ esperado: usuario.id });
  }

  /**
   * Al cargar la app: intenta recuperar la sesión del servidor con la cookie. Sin red queda
   * `sin_sesion` y la UI ofrece los perfiles del dispositivo (con contraseña, login offline). Si el
   * último acceso del perfil es de hace más de 10 minutos, la sesión queda bloqueada.
   */
  async restaurar(): Promise<{ estado: EstadoSesion; perfiles: PerfilDelDispositivo[] }> {
    if (this.#enLinea()) {
      await this.refrescar();
    }
    return { estado: this.#estado, perfiles: await this.perfilesDelDispositivo() };
  }

  // -------------------------------------------------------------------------------------------
  // Cierre de sesión
  // -------------------------------------------------------------------------------------------

  /** Revoca la familia del token (`credentials: 'omit'`: nunca la de una cookie ajena). */
  async #revocarEnServidor(token: string): Promise<boolean> {
    try {
      await this.api.peticion('/auth/logout', {
        metodo: 'POST',
        bearer: token,
        credenciales: 'omit',
      });
      return true;
    } catch (error) {
      if (error instanceof ErrorApi || error instanceof ErrorRed) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Cierra la sesión. Revoca la sesión del servidor si hay conexión (si no, la marca para revocarla
   * cuando la haya). Borra los datos locales del usuario SOLO si no tiene pendientes; si los tiene,
   * los conserva y devuelve cuántos son para que la UI advierta.
   *
   * F4-05: corta la sync en vuelo de esta pestaña (señal de sesión) y toma el candado de sync antes
   * de borrar: ninguna sync escribe en la partición mientras se borra.
   *
   * Decisión: se conservan el perfil y el verificador, para que el usuario pueda volver a entrar sin
   * conexión en esta tablet (sus pendientes solo salen con su sesión). El riesgo de fuerza bruta
   * offline del verificador lo mitigan los límites de la ADR 0017.
   */
  async cerrarSesion(): Promise<ResultadoCierre> {
    const usuario = this.#estado.usuario;
    if (usuario === null) {
      return {
        servidor_notificado: false,
        datos_borrados: false,
        pendientes: { mutaciones: 0, evidencias: 0, fotos_bloqueadas: 0 },
      };
    }
    // Las demás pestañas descartan su sesión YA (no esperan la revocación ni el candado de sync).
    this.#avisarOtrasPestanas('logout', usuario.id);
    const token = this.#enLinea() ? await this.obtenerAccessToken({ esperado: usuario.id }) : null;
    this.#cerrando = true;
    this.#renovarSenal();
    try {
      return await conCandado(NOMBRE_CANDADO_SYNC, () => this.#cerrarConCandado(usuario, token), {
        locks: this.#opciones.locks,
        duracionMs: DURACION_CANDADO_SYNC_MS,
        intervaloMs: this.#opciones.candado?.intervaloMs,
      });
    } finally {
      this.#cerrando = false;
    }
  }

  async #cerrarConCandado(usuario: Perfil, token: string | null): Promise<ResultadoCierre> {
    const notificado = token !== null && (await this.#revocarEnServidor(token));
    this.#olvidarToken();

    const perfil = await db.perfiles.get(usuario.id);
    if (perfil !== undefined) {
      await db.perfiles.put({ ...perfil, cierre_pendiente: !notificado });
    }

    const pendientes = await puedeBorrarDatosDeUsuario(usuario.id);
    let borrados = false;
    if (pendientes.puede) {
      try {
        await borrarDatosDeUsuario(usuario.id, { conservarPerfil: true });
        borrados = true;
      } catch {
        // Llegó un pendiente entre la comprobación y el borrado: no se borra nada.
      }
    }
    if (this.#estado.usuario?.id === usuario.id) {
      this.#publicar(ESTADO_SIN_SESION);
    }
    return {
      servidor_notificado: notificado,
      datos_borrados: borrados,
      pendientes: {
        mutaciones: pendientes.mutaciones,
        evidencias: pendientes.evidencias,
        fotos_bloqueadas: pendientes.fotos_bloqueadas,
      },
    };
  }

  /** Pendientes de otros usuarios de la tablet: "Hay N registros pendientes de <nombre>" (§5). */
  async pendientesDeOtrosUsuarios(userIdActual: string | null): Promise<AvisoPendientes[]> {
    return (await pendientesPorUsuario())
      .filter((p) => p.user_id !== userIdActual && p.mutaciones + p.evidencias > 0)
      .map((p) => {
        const total = p.mutaciones + p.evidencias;
        return { ...p, total, mensaje: mensajePendientes(total, p.nombre) };
      });
  }
}

/** Sesión única de la PWA, con el canal entre pestañas (ADR 0023). */
export const sesion = new GestorSesion({ canal: crearCanalSesion() });

/** Cliente de la API con la sesión de la PWA (refresh automático ante 401, ligado al usuario). */
export const clienteApi: ClienteApi = sesion.api;

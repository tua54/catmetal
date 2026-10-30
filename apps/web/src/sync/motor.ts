// Motor de sincronización del cliente (docs/spec.md §6; ADR 0005, 0008 puntos 7–8, 0009, 0012).
//
// Una sincronización, con el candado `catmetal-sync` (nunca dos a la vez entre pestañas):
//   1. Precondiciones: sesión `online`, sin `requiere_contrasena`, access token, y la partición que se
//      envía es la del usuario de la sesión. Tras un login offline, al volver la red se intenta
//      recuperar la sesión del servidor del MISMO usuario (F4-12). Cada petición lleva un token
//      ligado al usuario del lote (`bearer`, sin auto-refresh ajeno) y la señal de la sesión; la
//      sesión se revalida antes de CADA petición y después de cada respuesta, antes de escribir en
//      la partición: si cambió a mitad de camino, se detiene sin escribir (F4-05).
//   2. `recuperarEnviando`: lo que quedó en vuelo vuelve a la cola (el servidor es idempotente).
//   3. Push en orden, lotes ≤ 25, hasta vaciar lo listo. Error de red/5xx/timeout → sin resultado →
//      backoff. 403 `AUTOR_NO_COINCIDE` → se detiene y se pide la contraseña.
//   4. Pull en bucle mientras `hay_mas` (o tras un snapshot), atendiendo `hidratar`, `reiniciar` y el
//      cambio de época (snapshot + reenvío de las reencoladas). Primer arranque → snapshot inicial.
//      El snapshot `inicial` baja a un área temporal y se reanuda entre syncs; el estado local solo
//      se reemplaza cuando está completo (ADR 0022, M5).
//   5. Subida de fotos de novedades ya aplicadas. Nunca bloquea los registros.
//   6. Purga de aplicadas > 7 días y evento de trazabilidad.
//
// 426 `CLIENTE_DESACTUALIZADO` (B5, ADR 0026) en CUALQUIER petición: la respuesta es de la petición
// entera, no de una mutación. El motor se detiene sin rechazar ni reprogramar nada: el lote en vuelo
// vuelve a `pendiente` tal cual y las fotos no cuentan el intento. El cliente HTTP ya avisó a la app,
// que se actualiza sola; la próxima sync (con la versión nueva) lo envía todo. Lo mismo si el 426
// llega en el refresh que el motor hace tras un 401 (A4, ADR 0026 Enmienda 1): la sesión lo lanza
// (`lanzarSiDesactualizado`) en lugar de devolver "sin token", que contaría un intento y espera.

import {
  MAX_MUTACIONES_POR_LOTE,
  MENSAJES_ERROR,
  snapshotResponseSchema,
  syncPullResponseSchema,
  syncPushResponseSchema,
  type CodigoError,
  type Perfil,
} from '@catmetal/shared';
import { ZodError } from 'zod';
import {
  conCandado,
  DURACION_CANDADO_SYNC_MS,
  NOMBRE_CANDADO_SYNC,
  type GestorCandados,
} from '../auth/candado';
import {
  ErrorApi,
  ErrorRed,
  type ClienteApi,
  type OpcionesPeticion,
  type OpcionesToken,
} from '../auth/cliente-api';
import type { EstadoSesion } from '../auth/sesion';
import {
  aplicarCambios,
  aplicarEntidades,
  completarHidratacion,
  leerMetaSync,
  type AccionMotor,
} from '../datos/aplicar-cambios';
import {
  completarSnapshot,
  descartarSnapshot,
  guardarPaginaSnapshot,
  leerProgresoSnapshot,
  progresoVigente,
} from '../datos/snapshot-temporal';
import {
  aMutacion,
  aplicarResultados,
  bloquearEvidencia,
  devolverAPendiente,
  evidenciasListasParaSubir,
  marcarEnviando,
  marcarEvidenciaSubida,
  programarReintentoEvidencia,
  purgarAplicadasAntiguas,
  recuperarEnviando,
  siguienteLote,
} from '../datos/outbox';
import { ErrorDatosLocales } from '../datos/errores';
import type { ErrorSync } from '../datos/tipos';
import { registrarEvento } from '../datos/trazabilidad';
import { actualizarContadores, useEstadoSync, type StoreEstadoSync } from './estado';

export { NOMBRE_CANDADO_SYNC };

export type MotivoSync =
  'apertura' | 'online' | 'intervalo' | 'manual' | 'visible' | 'background' | 'local' | 'sesion';

export type MotivoOmision = 'sin_sesion' | 'offline' | 'requiere_contrasena' | 'sin_token';

export interface ResumenSync {
  motivo: MotivoSync;
  /** `false` si no se cumplieron las precondiciones (ver `omitida`). */
  ejecutada: boolean;
  omitida: MotivoOmision | null;
  user_id: string | null;
  lotes: number;
  enviadas: number;
  aplicadas: number;
  rechazadas: number;
  conflictos: number;
  sin_resultado: number;
  /** Cambios recibidos por el pull. */
  cambios: number;
  /** Páginas de snapshot aplicadas. */
  paginas_snapshot: number;
  epoca_cambiada: boolean;
  fotos_subidas: number;
  fotos_con_error: number;
  /** Siguiente intento programado por backoff, si quedó algo sin resultado. */
  siguiente_intento_at: string | null;
  error: ErrorSync | null;
}

/** Lo que el motor necesita de la sesión (lo cumple `GestorSesion`). */
export interface SesionParaSync {
  estado(): EstadoSesion;
  usuarioDeLaSesion(): Perfil | null;
  /**
   * Con `esperado`, nunca devuelve el token de otro usuario (F4-05). Con `lanzarSiDesactualizado`,
   * un 426 `CLIENTE_DESACTUALIZADO` del refresh se lanza como `ErrorApi` (A4).
   */
  obtenerAccessToken(ligado?: OpcionesToken): Promise<string | null>;
  /**
   * Refresh ligado al usuario del lote, para reintentar UNA vez tras un 401. Con
   * `lanzarSiDesactualizado`, un 426 `CLIENTE_DESACTUALIZADO` se lanza como `ErrorApi` (A4).
   */
  refrescar?(ligado: OpcionesToken): Promise<string | null>;
  /** Se aborta cuando cambia o se cierra la sesión: corta las peticiones en vuelo. */
  senalDeSesion?(): AbortSignal;
  marcarRequiereContrasena(): void;
  /**
   * S-09: el servidor revocó la sesión (`SESION_REVOCADA`): se bloquea y solo se desbloquea con
   * conexión. Si la sesión no lo implementa, se usa `marcarRequiereContrasena`.
   */
  marcarSesionRevocada?(): void;
  readonly api: ClienteApi;
}

export interface OpcionesMotor {
  sesion: SesionParaSync;
  estado?: StoreEstadoSync;
  locks?: GestorCandados | null;
  ahora?: () => number;
  aleatorio?: () => number;
  candado?: { duracionMs?: number; intervaloMs?: number };
  /** Tope de páginas por snapshot (por defecto 2000; se cambia en pruebas). */
  maxPaginasSnapshot?: number;
}

/**
 * Opciones de una petición del motor. `cuerpoAlEnviar` se evalúa justo antes de cada `fetch` (por
 * ejemplo, para `enviado_at` del push, ADR 0019).
 */
type OpcionesEnvio = Omit<OpcionesPeticion, 'bearer' | 'signal' | 'autenticar'> & {
  cuerpoAlEnviar?: () => unknown;
};

/** Topes por sincronización (evitan bucles si el servidor se comporta mal). */
const MAX_LOTES = 40;
const MAX_RONDAS_PULL = 50;
const MAX_PAGINAS_SNAPSHOT = 2_000;

/** Errores que detienen la sincronización: la sesión ya no sirve o no es del autor. */
const CODIGOS_DE_SESION: readonly CodigoError[] = [
  'NO_AUTENTICADO',
  'SESION_REVOCADA',
  'TOKEN_INVALIDO',
  'AUTOR_NO_COINCIDE',
];

/** La sesión cambió durante la sincronización: se detiene sin enviar nada más. */
class SesionCambiada extends Error {
  override readonly name = 'SesionCambiada';
  /**
   * Se detectó ANTES de enviar la petición (ADR 0023, M7): el servidor no recibió nada, así que el
   * lote puede volver a `pendiente` en lugar de quedar `enviando`.
   */
  readonly sinEnviar: boolean;

  constructor(sinEnviar = false) {
    super('La sesión cambió durante la sincronización.');
    this.sinEnviar = sinEnviar;
  }
}

/**
 * Motivos que, con una sesión offline (login contra el verificador), intentan recuperar la sesión
 * del servidor (F4-12). Un cambio local no: se registra muchas veces y sin red solo gastaría
 * intentos; lo cubren `online`, `visible` y el intervalo.
 */
const MOTIVOS_RECONEXION: readonly MotivoSync[] = [
  'apertura',
  'online',
  'intervalo',
  'manual',
  'visible',
  'background',
  'sesion',
];

/** Señal que nunca se aborta (sesiones sin `senalDeSesion`, por ejemplo en pruebas). */
const SIN_SENAL = new AbortController().signal;

/**
 * El snapshot no terminó (tope de páginas o la época cambió dos veces a mitad de camino): error
 * reintentable (M4). Lo ya descargado queda en el área temporal y la próxima sync reanuda.
 */
class SnapshotIncompleto extends Error {
  override readonly name = 'SnapshotIncompleto';

  constructor() {
    super('La descarga de datos del servidor no terminó. Se reintentará.');
  }
}

function errorSyncDe(error: unknown): ErrorSync {
  if (error instanceof ErrorApi) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ErrorRed) {
    return { code: null, message: error.message };
  }
  if (error instanceof SnapshotIncompleto) {
    return { code: 'ERROR_INTERNO', message: error.message };
  }
  if (error instanceof SesionCambiada) {
    return { code: 'AUTOR_NO_COINCIDE', message: error.message };
  }
  return {
    code: 'ERROR_INTERNO',
    message: 'La respuesta del servidor no tiene el formato esperado.',
  };
}

/** Errores de red, de la API, de sesión o de formato de respuesta; cualquier otro es un defecto. */
function esErrorEsperado(error: unknown): boolean {
  return (
    error instanceof ErrorApi ||
    error instanceof ErrorRed ||
    error instanceof SesionCambiada ||
    error instanceof SnapshotIncompleto ||
    error instanceof ZodError ||
    error instanceof SyntaxError
  );
}

/** El error impide seguir con la red o con la sesión (no vale la pena subir fotos ahora). */
function detieneLaRed(error: ErrorSync): boolean {
  return (
    error.code === null ||
    error.code === 'CLIENTE_DESACTUALIZADO' ||
    CODIGOS_DE_SESION.includes(error.code)
  );
}

/** B5: el servidor exige una versión más nueva de la app (426 de la petición entera). */
function esClienteDesactualizado(error: unknown): error is ErrorApi {
  return error instanceof ErrorApi && error.code === 'CLIENTE_DESACTUALIZADO';
}

function resumenVacio(motivo: MotivoSync): ResumenSync {
  return {
    motivo,
    ejecutada: false,
    omitida: null,
    user_id: null,
    lotes: 0,
    enviadas: 0,
    aplicadas: 0,
    rechazadas: 0,
    conflictos: 0,
    sin_resultado: 0,
    cambios: 0,
    paginas_snapshot: 0,
    epoca_cambiada: false,
    fotos_subidas: 0,
    fotos_con_error: 0,
    siguiente_intento_at: null,
    error: null,
  };
}

function descripcionEvento(r: ResumenSync): string {
  const partes: string[] = [];
  if (r.aplicadas > 0) {
    partes.push(`${r.aplicadas} ${r.aplicadas === 1 ? 'registro' : 'registros'}`);
  }
  if (r.fotos_subidas > 0) {
    partes.push(`${r.fotos_subidas} ${r.fotos_subidas === 1 ? 'foto' : 'fotos'}`);
  }
  const problemas = r.rechazadas + r.conflictos;
  const detalle = problemas > 0 ? `, ${problemas} con problemas` : '';
  const origen = r.motivo === 'manual' ? 'manual' : 'auto-sync';
  return `sincronizó ${partes.join(' y ') || 'sin cambios'}${detalle} (${origen})`;
}

export class MotorSync {
  readonly #opciones: OpcionesMotor;
  readonly #estado: StoreEstadoSync;
  #enCurso: Promise<ResumenSync> | null = null;
  #repetir = false;
  /** Señal de la sesión de la sincronización en curso (una a la vez: candado). */
  #senal: AbortSignal = SIN_SENAL;

  constructor(opciones: OpcionesMotor) {
    this.#opciones = opciones;
    this.#estado = opciones.estado ?? useEstadoSync;
  }

  get estado(): StoreEstadoSync {
    return this.#estado;
  }

  #ahora(): Date {
    return new Date((this.#opciones.ahora ?? Date.now)());
  }

  #api(): ClienteApi {
    return this.#opciones.sesion.api;
  }

  /**
   * Sincroniza. Si ya hay una en curso en esta pestaña, devuelve esa misma y, al terminar, repite
   * UNA vez solo si quedaron mutaciones listas (por ejemplo, registradas durante el pull).
   */
  sincronizar(motivo: MotivoSync): Promise<ResumenSync> {
    if (this.#enCurso !== null) {
      this.#repetir = true;
      return this.#enCurso;
    }
    const enCurso = this.#ejecutarConRepeticion(motivo).finally(() => {
      this.#enCurso = null;
    });
    this.#enCurso = enCurso;
    return enCurso;
  }

  async #ejecutarConRepeticion(motivo: MotivoSync): Promise<ResumenSync> {
    let resumen = await this.#conCandado(motivo);
    while (this.#repetir && resumen.ejecutada && resumen.error === null && resumen.user_id) {
      this.#repetir = false;
      const listas = await siguienteLote(resumen.user_id, 1, this.#ahora());
      if (listas.length === 0) {
        break;
      }
      resumen = await this.#conCandado(motivo);
    }
    this.#repetir = false;
    return resumen;
  }

  #conCandado(motivo: MotivoSync): Promise<ResumenSync> {
    return conCandado(NOMBRE_CANDADO_SYNC, () => this.#ejecutar(motivo), {
      locks: this.#opciones.locks,
      duracionMs: this.#opciones.candado?.duracionMs ?? DURACION_CANDADO_SYNC_MS,
      intervaloMs: this.#opciones.candado?.intervaloMs,
    });
  }

  /**
   * Antes de cada petición: la sesión sigue siendo la del autor de la partición, `online`, sin
   * `requiere_contrasena`, y no se cerró ni cambió (señal de sesión).
   */
  #verificarSesion(userId: string): void {
    this.#verificarAutor(userId);
    const estado = this.#opciones.sesion.estado();
    if (estado.modo !== 'online' || estado.requiere_contrasena) {
      throw new SesionCambiada();
    }
  }

  /**
   * Justo antes de cada `fetch` (ADR 0023, M7): como `#verificarSesion`, pero marca que no se envió
   * nada. Entre esta comprobación y el `fetch` no hay ningún `await`.
   */
  #verificarAntesDeEnviar(userId: string): void {
    try {
      this.#verificarSesion(userId);
    } catch (error) {
      throw error instanceof SesionCambiada ? new SesionCambiada(true) : error;
    }
  }

  /**
   * Antes de escribir en la partición lo que llegó por la red: la sesión sigue siendo la del autor y
   * no se cerró (F4-05). Si solo perdió la sesión del servidor (`requiere_contrasena`), lo recibido
   * con su propio token sigue siendo suyo y se guarda.
   */
  #verificarAutor(userId: string): void {
    if (this.#senal.aborted || this.#opciones.sesion.usuarioDeLaSesion()?.id !== userId) {
      throw new SesionCambiada();
    }
  }

  /**
   * Petición autenticada con un token ligado a `userId` (F4-05): nunca con el de otra persona ni con
   * el auto-refresh del cliente (que tomaría la sesión que haya en ese momento). Ante 401 se
   * refresca UNA vez para ese mismo usuario. La sesión se revalida tras cada `await`.
   *
   * A4: si el refresh (aquí o dentro de `obtenerAccessToken`) responde 426 `CLIENTE_DESACTUALIZADO`,
   * se lanza ese `ErrorApi`, igual que el 426 de la propia petición: quien llama lo trata sin contar
   * intentos ni aplicar espera.
   */
  async #peticion(userId: string, ruta: string, opciones: OpcionesEnvio = {}): Promise<unknown> {
    const sesion = this.#opciones.sesion;
    const ligado: OpcionesToken = { esperado: userId, lanzarSiDesactualizado: true };
    const token = await sesion.obtenerAccessToken(ligado);
    this.#verificarAntesDeEnviar(userId);
    if (token === null) {
      throw new ErrorApi('NO_AUTENTICADO', 401);
    }
    try {
      return await this.#enviarCon(userId, ruta, opciones, token);
    } catch (error) {
      if (
        !(error instanceof ErrorApi && error.code === 'NO_AUTENTICADO') ||
        sesion.refrescar === undefined
      ) {
        throw error;
      }
      const nuevo = await sesion.refrescar(ligado);
      // El servidor respondió 401 sin procesar nada: el reintento todavía no salió.
      this.#verificarAntesDeEnviar(userId);
      if (nuevo === null) {
        throw error;
      }
      return this.#enviarCon(userId, ruta, opciones, nuevo);
    }
  }

  async #enviarCon(
    userId: string,
    ruta: string,
    opciones: OpcionesEnvio,
    token: string,
  ): Promise<unknown> {
    const senal = this.#senal;
    const { cuerpoAlEnviar, ...resto } = opciones;
    let respuesta: unknown;
    try {
      // Con `bearer`, el cliente no hace ningún `await` antes del `fetch`: el cuerpo calculado aquí
      // (con `enviado_at`) es el de ESTE envío, también en el reintento tras un 401.
      respuesta = await this.#api().peticion<unknown>(ruta, {
        ...resto,
        ...(cuerpoAlEnviar === undefined ? {} : { cuerpo: cuerpoAlEnviar() }),
        bearer: token,
        signal: senal,
      });
    } catch (error) {
      if (senal.aborted) {
        // `cerrarSesion` o un cambio de usuario cortó la petición en vuelo.
        throw new SesionCambiada();
      }
      if (
        error instanceof ErrorApi &&
        error.code === 'SESION_REVOCADA' &&
        this.#opciones.sesion.usuarioDeLaSesion()?.id === userId
      ) {
        // Con `bearer` el cliente no avisa a la sesión: se hace aquí, solo si sigue siendo la suya.
        // S-09: una revocación bloquea la sesión (no solo pide la contraseña).
        const sesion = this.#opciones.sesion;
        if (sesion.marcarSesionRevocada === undefined) {
          sesion.marcarRequiereContrasena();
        } else {
          sesion.marcarSesionRevocada();
        }
      }
      throw error;
    }
    this.#verificarAutor(userId);
    return respuesta;
  }

  async #precondiciones(motivo: MotivoSync, resumen: ResumenSync): Promise<string | null> {
    const sesion = this.#opciones.sesion;
    let estado = sesion.estado();
    const usuario = sesion.usuarioDeLaSesion();
    if (usuario === null || estado.usuario === null) {
      resumen.omitida = 'sin_sesion';
      return null;
    }
    if (
      estado.modo === 'offline' &&
      !estado.requiere_contrasena &&
      MOTIVOS_RECONEXION.includes(motivo)
    ) {
      // F4-12: tras un login offline, la sesión del servidor del MISMO usuario se recupera con la
      // cookie (refresh ligado a su id). Si la cookie es de otra persona, queda `requiere_contrasena`
      // y el aviso ofrece escribir la contraseña; sin red, sigue offline.
      await sesion.obtenerAccessToken({ esperado: usuario.id });
      estado = sesion.estado();
    }
    if (sesion.usuarioDeLaSesion()?.id !== usuario.id) {
      resumen.omitida = 'sin_sesion';
      return null;
    }
    if (estado.requiere_contrasena) {
      resumen.omitida = 'requiere_contrasena';
      return null;
    }
    if (estado.modo !== 'online') {
      resumen.omitida = 'offline';
      return null;
    }
    if ((await sesion.obtenerAccessToken({ esperado: usuario.id })) === null) {
      resumen.omitida = 'sin_token';
      return null;
    }
    // Tras el `await`, la sesión pudo cambiar.
    if (sesion.usuarioDeLaSesion()?.id !== usuario.id) {
      resumen.omitida = 'sin_sesion';
      return null;
    }
    return usuario.id;
  }

  async #ejecutar(motivo: MotivoSync): Promise<ResumenSync> {
    const resumen = resumenVacio(motivo);
    this.#senal = this.#opciones.sesion.senalDeSesion?.() ?? SIN_SENAL;
    const userId = await this.#precondiciones(motivo, resumen);
    if (userId === null) {
      await actualizarContadores(
        this.#estado,
        this.#opciones.sesion.usuarioDeLaSesion()?.id ?? null,
      );
      return resumen;
    }
    resumen.ejecutada = true;
    resumen.user_id = userId;
    this.#estado.setState({ sincronizando: true });
    try {
      await recuperarEnviando(userId, this.#ahora());
      // A1 (ADR 0016): si el servidor responde EPOCA_CAMBIADA, el lote volvió a pendiente sin
      // procesarse; el pull detecta la época nueva, reencola en orden y hace el snapshot.
      const primero = await this.#push(userId, resumen);
      // B10: otra sincronización ya está enviando estas mutaciones; esta se retira sin error.
      let ocupado = primero === 'ocupado';
      const epocaVieja = primero === 'epoca_cambiada';
      if (resumen.error === null && !ocupado) {
        await this.#pull(userId, resumen);
      }
      if (resumen.error === null && !ocupado && (resumen.epoca_cambiada || epocaVieja)) {
        // Tras un cambio de época se reenvían las mutaciones aplicadas que se conservaban.
        const segundo = await this.#push(userId, resumen);
        ocupado = segundo === 'ocupado';
        if (segundo === 'epoca_cambiada') {
          // La época volvió a cambiar (otra restauración): se reintenta en la próxima sync.
          resumen.error = { code: 'EPOCA_CAMBIADA', message: MENSAJES_ERROR.EPOCA_CAMBIADA };
        }
      }
      if (!ocupado && (resumen.error === null || !detieneLaRed(resumen.error))) {
        await this.#subirEvidencias(userId, resumen);
      }
      await purgarAplicadasAntiguas(userId, this.#ahora());
    } catch (error) {
      if (!esErrorEsperado(error)) {
        throw error;
      }
      resumen.error = errorSyncDe(error);
    } finally {
      await this.#cerrar(userId, resumen);
    }
    return resumen;
  }

  async #cerrar(userId: string, resumen: ResumenSync): Promise<void> {
    const sinConexion = resumen.error !== null && resumen.error.code === null;
    try {
      if (resumen.aplicadas + resumen.fotos_subidas + resumen.rechazadas + resumen.conflictos > 0) {
        await registrarEvento(
          userId,
          'sync.completada',
          userId,
          null,
          this.#ahora().toISOString(),
          descripcionEvento(resumen),
        );
      }
      // Los contadores se recalculan ANTES de salir de "Sincronizando…": el indicador nunca
      // muestra "Todo sincronizado" con un conteo viejo. Son los del usuario de la sesión ACTUAL
      // (si cambió durante la sync, nunca se muestran los de la partición anterior).
      await actualizarContadores(
        this.#estado,
        this.#opciones.sesion.usuarioDeLaSesion()?.id ?? null,
      );
    } finally {
      this.#estado.setState({
        sincronizando: false,
        error: resumen.error,
        ...(resumen.error === null
          ? { ultimoSync: this.#ahora().toISOString(), conexion: 'en_linea' as const }
          : sinConexion
            ? { conexion: 'sin_conexion' as const }
            : {}),
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------------------------

  /**
   * `ocupado` (B10): otra sincronización tomó el lote entre `siguienteLote` y `marcarEnviando` (por
   * ejemplo, otra pestaña tras vencer el candado alternativo). No es un error: esa sync lo envía.
   */
  async #push(userId: string, resumen: ResumenSync): Promise<'ok' | 'epoca_cambiada' | 'ocupado'> {
    for (let lotes = 0; lotes < MAX_LOTES; lotes += 1) {
      this.#verificarSesion(userId);
      const listo = await siguienteLote(userId, MAX_MUTACIONES_POR_LOTE, this.#ahora());
      if (listo.length === 0) {
        return 'ok';
      }
      const { epoca } = await leerMetaSync(userId);
      let lote;
      try {
        lote = await marcarEnviando(userId, listo, this.#ahora());
      } catch (error) {
        if (error instanceof ErrorDatosLocales && error.code === 'CONFLICTO') {
          // B10: alguna ya no está `pendiente` (la marcó otra sync). La transacción no cambió nada:
          // ninguna mutación se toca aquí y no se envía nada.
          return 'ocupado';
        }
        throw error;
      }
      resumen.lotes += 1;
      resumen.enviadas += lote.length;

      let resultados;
      try {
        // M7: el lote es de `userId` y la sesión sigue siendo suya (otra pestaña pudo cerrarla o
        // cambiar de usuario mientras se armaba el lote). `#peticion` vuelve a comprobarlo justo
        // antes del `fetch`.
        if (lote.some((m) => m.user_id !== userId)) {
          throw new SesionCambiada(true);
        }
        this.#verificarAntesDeEnviar(userId);
        const respuesta = await this.#peticion(userId, '/sync/push', {
          metodo: 'POST',
          // La época conocida viaja en el sobre (ADR 0016, A1). Sin época (nunca hubo pull) se omite.
          // `enviado_at` (ADR 0019, M2): la hora del dispositivo justo antes de CADA `fetch`; nunca
          // se guarda en el outbox.
          cuerpoAlEnviar: () => ({
            user_id: userId,
            epoca: epoca ?? undefined,
            enviado_at: this.#ahora().toISOString(),
            mutaciones: lote.map(aMutacion),
          }),
        });
        resultados = syncPushResponseSchema.parse(respuesta).resultados;
      } catch (error) {
        if (error instanceof SesionCambiada) {
          if (error.sinEnviar) {
            // No salió nada (M7): el lote vuelve a `pendiente` tal cual. Solo cambia el estado de
            // las filas del outbox de su autor; nada de la red se escribe en la partición.
            await devolverAPendiente(userId, lote, this.#ahora());
            resumen.enviadas -= lote.length;
          }
          // Si ya estaba en vuelo, queda `enviando`: vuelve a la cola con `recuperarEnviando` en la
          // próxima sync de su autor y el servidor, idempotente, devuelve lo que ya hubiera aplicado.
          throw error;
        }
        if (error instanceof ErrorApi && error.code === 'EPOCA_CAMBIADA') {
          // El servidor no procesó ni guardó nada: el lote vuelve a la cola tal cual.
          await devolverAPendiente(userId, lote, this.#ahora());
          resumen.enviadas -= lote.length;
          return 'epoca_cambiada';
        }
        if (esClienteDesactualizado(error)) {
          // B5: el servidor no procesó nada (rechazó la petición entera, no una mutación). El lote
          // vuelve a `pendiente` sin contar el intento ni backoff, y la sync se detiene. A4: también
          // si el 426 llegó en el refresh tras un 401 (el push tampoco se procesó).
          await devolverAPendiente(userId, lote, this.#ahora());
          resumen.enviadas -= lote.length;
          resumen.error = errorSyncDe(error);
          return 'ok';
        }
        // Sin respuesta utilizable: todo el lote queda sin resultado (sigue pendiente, con backoff).
        this.#verificarAutor(userId);
        const r = await aplicarResultados(userId, lote, [], {
          ahora: this.#ahora(),
          aleatorio: this.#opciones.aleatorio,
        });
        resumen.sin_resultado += r.sin_resultado;
        resumen.siguiente_intento_at = r.siguiente_intento_at;
        if (
          error instanceof ErrorApi &&
          error.code === 'AUTOR_NO_COINCIDE' &&
          this.#opciones.sesion.usuarioDeLaSesion()?.id === userId
        ) {
          this.#opciones.sesion.marcarRequiereContrasena();
        }
        resumen.error = errorSyncDe(error);
        return 'ok';
      }

      this.#verificarAutor(userId);
      const r = await aplicarResultados(userId, lote, resultados, {
        ahora: this.#ahora(),
        aleatorio: this.#opciones.aleatorio,
      });
      resumen.aplicadas += r.aplicadas;
      resumen.rechazadas += r.rechazadas + r.dependientes_rechazadas;
      resumen.conflictos += r.conflictos;
      resumen.sin_resultado += r.sin_resultado;
      if (r.sin_resultado > 0) {
        // El servidor se detuvo por un error transitorio: las demás esperan su backoff.
        resumen.siguiente_intento_at = r.siguiente_intento_at;
        return 'ok';
      }
    }
    return 'ok';
  }

  // -------------------------------------------------------------------------------------------
  // Pull y snapshot
  // -------------------------------------------------------------------------------------------

  async #pull(userId: string, resumen: ResumenSync): Promise<void> {
    let meta = await leerMetaSync(userId);
    const inicial = meta.epoca === null && meta.cursor === 0;
    if (!inicial && !meta.acciones.some((a) => a.tipo === 'snapshot')) {
      // Una descarga guardada que ya nadie necesita (no debería pasar): se descarta.
      await descartarSnapshot(userId);
    }
    if (inicial) {
      // Primer arranque: el snapshot es mucho más barato que recorrer todo el audit_log.
      await this.#snapshot(userId, resumen, { alcance: 'inicial' });
      meta = await leerMetaSync(userId);
    }
    await this.#atender(userId, resumen, meta.acciones);

    for (let ronda = 0; ronda < MAX_RONDAS_PULL; ronda += 1) {
      this.#verificarSesion(userId);
      meta = await leerMetaSync(userId);
      const respuesta = syncPullResponseSchema.parse(
        await this.#peticion(userId, `/sync/pull?cursor=${meta.cursor}`),
      );
      this.#verificarAutor(userId);
      const r = await aplicarCambios(userId, respuesta);
      resumen.cambios += respuesta.cambios.length;
      resumen.epoca_cambiada ||= r.epoca_cambiada;
      const huboSnapshot = await this.#atender(userId, resumen, r.acciones);
      if (!respuesta.hay_mas && !huboSnapshot) {
        return;
      }
    }
  }

  /** Atiende las acciones pendientes. Devuelve si hizo un snapshot completo. */
  async #atender(userId: string, resumen: ResumenSync, acciones: AccionMotor[]): Promise<boolean> {
    let completo = false;
    for (const accion of acciones) {
      if (accion.tipo === 'snapshot') {
        await this.#snapshot(userId, resumen, { alcance: 'inicial' });
        completo = true;
      } else if (!completo) {
        try {
          await this.#snapshot(userId, resumen, { alcance: 'orden', order_id: accion.order_id });
        } catch (error) {
          // A2: la orden se desasignó (o ya no existe) entre el `hidratar` y su snapshot. Se cierra
          // la hidratación igual; el `revocar` de la orden llega en el pull.
          if (!(error instanceof ErrorApi && error.code === 'NO_ENCONTRADO')) {
            throw error;
          }
        }
        this.#verificarAutor(userId);
        await completarHidratacion(userId, accion.order_id);
      }
    }
    return completo;
  }

  async #snapshot(
    userId: string,
    resumen: ResumenSync,
    consulta: { alcance: 'inicial' } | { alcance: 'orden'; order_id: string },
  ): Promise<void> {
    if (consulta.alcance === 'inicial') {
      await this.#snapshotInicial(userId, resumen);
      return;
    }
    // Hidratación de una orden: solo agrega datos, se aplica directo página a página.
    let pagina: string | null = null;
    const maxPaginas = this.#opciones.maxPaginasSnapshot ?? MAX_PAGINAS_SNAPSHOT;
    for (let n = 0; n < maxPaginas; n += 1) {
      this.#verificarSesion(userId);
      const parametros = new URLSearchParams({
        alcance: 'orden',
        order_id: consulta.order_id,
      });
      if (pagina !== null) {
        parametros.set('pagina', pagina);
      }
      const respuesta = snapshotResponseSchema.parse(
        await this.#peticion(userId, `/sync/snapshot?${parametros.toString()}`),
      );
      this.#verificarAutor(userId);
      await aplicarEntidades(userId, respuesta.entidades);
      resumen.paginas_snapshot += 1;
      pagina = respuesta.siguiente_pagina;
      if (pagina === null) {
        return;
      }
    }
    // M4: se agotó el tope y el servidor aún tiene más: la hidratación sigue pendiente en `meta`.
    throw new SnapshotIncompleto();
  }

  /**
   * Snapshot `inicial` (arranque, `reiniciar` o cambio de época) en el área temporal (ADR 0022):
   * reanuda la descarga guardada si sigue vigente, guarda cada página en una transacción y, con la
   * última, reemplaza el estado local en UNA transacción (`completarSnapshot`). Si se interrumpe,
   * los datos vivos quedan intactos. Empieza de cero UNA vez por sync si una página trae otra época
   * o el servidor rechaza el token de página; nunca mezcla épocas.
   */
  async #snapshotInicial(userId: string, resumen: ResumenSync): Promise<void> {
    const maxPaginas = this.#opciones.maxPaginasSnapshot ?? MAX_PAGINAS_SNAPSHOT;
    let progreso = await leerProgresoSnapshot(userId);
    if (progreso !== undefined && !progresoVigente(progreso, this.#ahora())) {
      await descartarSnapshot(userId);
      progreso = undefined;
    }
    let completo = progreso?.completo === true;
    let pagina: string | null = completo ? null : (progreso?.siguiente_pagina ?? null);
    let reiniciado = false;
    const empezarDeCero = async (): Promise<void> => {
      if (reiniciado) {
        throw new SnapshotIncompleto();
      }
      reiniciado = true;
      await descartarSnapshot(userId);
      pagina = null;
    };
    for (let n = 0; !completo; n += 1) {
      if (n >= maxPaginas) {
        // M4: tope agotado. Lo descargado se conserva; la próxima sync reanuda desde aquí.
        throw new SnapshotIncompleto();
      }
      this.#verificarSesion(userId);
      const parametros = new URLSearchParams({ alcance: 'inicial' });
      if (pagina !== null) {
        parametros.set('pagina', pagina);
      }
      let respuesta;
      try {
        respuesta = snapshotResponseSchema.parse(
          await this.#peticion(userId, `/sync/snapshot?${parametros.toString()}`),
        );
      } catch (error) {
        if (pagina !== null && error instanceof ErrorApi && error.code === 'VALIDACION') {
          // Token de página rechazado (p. ej. otra versión del Worker): se empieza de cero.
          await empezarDeCero();
          continue;
        }
        throw error;
      }
      this.#verificarAutor(userId);
      const guardada = await guardarPaginaSnapshot(userId, respuesta, this.#ahora().toISOString());
      if (guardada.resultado === 'epoca_distinta') {
        // La época cambió a mitad de la descarga (otra restauración): lo guardado no sirve.
        await empezarDeCero();
        continue;
      }
      resumen.paginas_snapshot += 1;
      pagina = respuesta.siguiente_pagina;
      completo = guardada.completo;
    }
    this.#verificarAutor(userId);
    const { epoca_cambiada } = await completarSnapshot(userId, {
      ahora: this.#ahora().toISOString(),
    });
    if (epoca_cambiada) {
      // Se confirmó otra época: el motor reenvía las mutaciones reencoladas.
      resumen.epoca_cambiada = true;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Evidencias
  // -------------------------------------------------------------------------------------------

  async #subirEvidencias(userId: string, resumen: ResumenSync): Promise<void> {
    const listas = await evidenciasListasParaSubir(userId, this.#ahora());
    for (const foto of listas) {
      this.#verificarSesion(userId);
      try {
        await this.#peticion(userId, `/evidences/${encodeURIComponent(foto.id)}`, {
          metodo: 'PUT',
          binario: { datos: foto.datos, tipo: foto.mime },
          tiempoEsperaMs: 60_000,
        });
        this.#verificarAutor(userId);
        await marcarEvidenciaSubida(userId, foto.id, this.#ahora());
        resumen.fotos_subidas += 1;
      } catch (error) {
        if (error instanceof SesionCambiada || esClienteDesactualizado(error)) {
          // Sigue `pendiente`: el servidor acepta otra vez los mismos bytes (mismo sha256). Con 426
          // (B5) la foto no cuenta el intento: se sube con la versión nueva.
          throw error;
        }
        const detalle = errorSyncDe(error);
        resumen.fotos_con_error += 1;
        if (error instanceof ErrorApi && [400, 413, 415].includes(error.status)) {
          await bloquearEvidencia(userId, foto.id, detalle, this.#ahora());
          continue;
        }
        if (error instanceof ErrorApi && error.code === 'EVIDENCIA_YA_SUBIDA') {
          // Otra foto con el mismo id ya está en el servidor: no se reintenta, se conserva.
          await bloquearEvidencia(userId, foto.id, detalle, this.#ahora());
          continue;
        }
        await programarReintentoEvidencia(userId, foto.id, detalle, {
          ahora: this.#ahora(),
          aleatorio: this.#opciones.aleatorio,
        });
        if (detieneLaRed(detalle) || (error instanceof ErrorApi && error.status >= 500)) {
          // Sin red, sin sesión o servidor con fallas: las demás fotos esperan al siguiente intento.
          return;
        }
      }
    }
  }
}

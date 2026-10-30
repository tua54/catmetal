// Sesión de la PWA (docs/spec.md §5; ADR 0008 puntos 1–8; ADR 0012 punto 4).
//
// - El access token vive SOLO en un campo privado de esta clase: nunca en el estado publicado, ni en
//   localStorage, ni en IndexedDB. El refresh token es una cookie HttpOnly que el JS no ve.
// - Modo `online`: hay sesión del servidor (access token). Modo `offline`: el usuario se autenticó
//   contra el verificador local; puede registrar, pero la sync no corre hasta tener sesión del
//   servidor (`obtenerAccessToken()` devuelve `null`).
// - Tablet compartida: hay UNA cookie por origen. Una sesión del servidor solo se adopta si es del
//   mismo usuario de la sesión local (ADR 0008 punto 8); si no, se pide la contraseña.

import {
  ahoraIso,
  loginSchema,
  MENSAJES_ERROR,
  uuidv7,
  type Perfil,
  type Permiso,
  type RespuestaSesion,
} from '@catmetal/shared';
import { db, obtenerInstalacionId } from '../datos/db';
import {
  borrarDatosDeUsuario,
  pendientesPorUsuario,
  puedeBorrarDatosDeUsuario,
} from '../datos/outbox';
import type { PerfilLocal, VerificadorLocal } from '../datos/tipos';
import { conCandado, type GestorCandados } from './candado';
import { crearClienteApi, ErrorApi, ErrorRed, type ClienteApi } from './cliente-api';
import { comprobarVerificador, crearVerificador, ITERACIONES_VERIFICADOR } from './verificador';

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
}

export const ESTADO_SIN_SESION: EstadoSesion = Object.freeze({
  modo: 'sin_sesion',
  usuario: null,
  permisos: [],
  device_id: null,
  requiere_contrasena: false,
});

export type CodigoErrorSesion = 'CREDENCIALES_INVALIDAS' | 'SIN_LOGIN_PREVIO' | 'VALIDACION';

const MENSAJES_SESION: Readonly<Record<CodigoErrorSesion, string>> = {
  // El mismo mensaje genérico del servidor: no revela si falló el correo o la contraseña.
  CREDENCIALES_INVALIDAS: MENSAJES_ERROR.CREDENCIALES_INVALIDAS,
  SIN_LOGIN_PREVIO:
    'No hay conexión. Para entrar sin conexión, primero inicie sesión con conexión en este dispositivo.',
  VALIDACION: MENSAJES_ERROR.VALIDACION,
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
  /** Pendientes que impidieron borrar: la UI debe advertir al usuario. */
  pendientes: { mutaciones: number; evidencias: number };
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
  email: string;
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
  enLinea?: () => boolean;
  ahora?: () => number;
  agenteUsuario?: string;
  candado?: { duracionMs?: number; intervaloMs?: number };
}

export const NOMBRE_CANDADO_REFRESH = 'catmetal-refresh';
/** Se refresca el access token si le quedan menos de 30 s. */
const MARGEN_EXPIRACION_MS = 30_000;

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

export class GestorSesion {
  readonly api: ClienteApi;
  readonly #opciones: OpcionesSesion;
  #estado: EstadoSesion = ESTADO_SIN_SESION;
  #token: string | null = null;
  #expiraEn = 0;
  #refrescoEnCurso: Promise<string | null> | null = null;
  readonly #oyentes = new Set<Oyente>();

  constructor(opciones: OpcionesSesion = {}) {
    this.#opciones = opciones;
    this.api = crearClienteApi({
      base: opciones.base,
      fetch: opciones.fetch,
      proveedor: {
        obtenerAccessToken: () => this.obtenerAccessToken(),
        refrescar: () => this.refrescar(),
        sesionRevocada: () => this.#perderSesionDelServidor(),
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

  /** Se llama con cada cambio de estado. Devuelve la función para desuscribirse. */
  suscribir(oyente: Oyente): () => void {
    this.#oyentes.add(oyente);
    return () => this.#oyentes.delete(oyente);
  }

  #publicar(estado: EstadoSesion): void {
    this.#estado = Object.freeze({ ...estado, permisos: Object.freeze([...estado.permisos]) });
    for (const oyente of this.#oyentes) {
      oyente(this.#estado);
    }
  }

  #ahora(): number {
    return (this.#opciones.ahora ?? Date.now)();
  }

  #enLinea(): boolean {
    return this.#opciones.enLinea?.() ?? globalThis.navigator?.onLine ?? true;
  }

  #guardarToken(respuesta: RespuestaSesion): void {
    this.#token = respuesta.access_token;
    this.#expiraEn = this.#ahora() + respuesta.expira_en * 1000;
  }

  #olvidarToken(): void {
    this.#token = null;
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

  async #guardarPerfil(
    respuesta: RespuestaSesion,
    verificador: VerificadorLocal | null,
  ): Promise<void> {
    const ahora = ahoraIso();
    await db.transaction('rw', db.perfiles, async () => {
      const previo = await db.perfiles.get(respuesta.usuario.id);
      await db.perfiles.put({
        user_id: respuesta.usuario.id,
        perfil: respuesta.usuario,
        device_id: respuesta.device_id,
        verificador: verificador ?? previo?.verificador ?? null,
        actualizado_at: ahora,
        ultimo_acceso_at: ahora,
        cierre_pendiente: false,
      });
    });
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
        ultimo_acceso_at: p.ultimo_acceso_at,
        offline_disponible: p.verificador !== null,
      }));
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
        const caidaDelServidor = error instanceof ErrorApi && error.status >= 500;
        if (!(error instanceof ErrorRed) && !caidaDelServidor) {
          throw error;
        }
      }
    }
    return this.#loginOffline(datos.data.email, datos.data.password);
  }

  async #loginOnline(email: string, password: string): Promise<EstadoSesion> {
    const existente = await this.#perfilPorEmail(email);
    const respuesta = await this.api.peticion<RespuestaSesion>('/auth/login', {
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
    // El verificador se deriva de la contraseña ya aceptada por el servidor y se queda en el
    // dispositivo. Nunca forma parte de ningún cuerpo enviado.
    const verificador = await crearVerificador(
      password,
      this.#opciones.iteraciones ?? ITERACIONES_VERIFICADOR,
    );
    await this.#guardarPerfil(respuesta, verificador);
    this.#guardarToken(respuesta);
    this.#publicar({
      modo: 'online',
      usuario: respuesta.usuario,
      permisos: respuesta.usuario.permisos,
      device_id: respuesta.device_id,
      requiere_contrasena: false,
    });
    return this.#estado;
  }

  async #loginOffline(email: string, password: string): Promise<EstadoSesion> {
    const perfil = await this.#perfilPorEmail(email);
    if (perfil?.verificador === null || perfil?.verificador === undefined) {
      throw new ErrorSesion('SIN_LOGIN_PREVIO');
    }
    if (!(await comprobarVerificador(password, perfil.verificador))) {
      throw new ErrorSesion('CREDENCIALES_INVALIDAS');
    }
    await db.perfiles.put({ ...perfil, ultimo_acceso_at: ahoraIso(), cierre_pendiente: false });
    this.#olvidarToken();
    this.#publicar({
      modo: 'offline',
      usuario: perfil.perfil,
      permisos: perfil.perfil.permisos,
      device_id: perfil.device_id,
      requiere_contrasena: false,
    });
    return this.#estado;
  }

  // -------------------------------------------------------------------------------------------
  // Refresh y token
  // -------------------------------------------------------------------------------------------

  /**
   * `POST /auth/refresh`, serializado entre pestañas (Web Locks o alternativa) y compartido dentro
   * de la pestaña: N llamadas simultáneas hacen UNA petición. Devuelve el access token o `null`.
   */
  refrescar(): Promise<string | null> {
    if (this.#refrescoEnCurso !== null) {
      return this.#refrescoEnCurso;
    }
    const enCurso = conCandado(NOMBRE_CANDADO_REFRESH, () => this.#refrescarConCandado(), {
      locks: this.#opciones.locks,
      duracionMs: this.#opciones.candado?.duracionMs,
      intervaloMs: this.#opciones.candado?.intervaloMs,
    }).finally(() => {
      this.#refrescoEnCurso = null;
    });
    this.#refrescoEnCurso = enCurso;
    return enCurso;
  }

  async #refrescarConCandado(): Promise<string | null> {
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

  async #adoptar(respuesta: RespuestaSesion): Promise<string | null> {
    const local = this.#estado.usuario;
    if (local !== null && local.id !== respuesta.usuario.id) {
      // La cookie es de otra persona que inició sesión en esta tablet: nunca se adopta su sesión
      // para el usuario local (ADR 0008 punto 8). Se pide la contraseña.
      this.#perderSesionDelServidor();
      return null;
    }
    if (local === null) {
      const perfil = await db.perfiles.get(respuesta.usuario.id);
      if (perfil?.cierre_pendiente === true) {
        // Ese usuario cerró sesión sin conexión: se revoca ahora y no se adopta.
        await this.#revocarEnServidor(respuesta.access_token);
        await db.perfiles.put({ ...perfil, cierre_pendiente: false });
        return null;
      }
    }
    await this.#guardarPerfil(respuesta, null);
    this.#guardarToken(respuesta);
    this.#publicar({
      modo: 'online',
      usuario: respuesta.usuario,
      permisos: respuesta.usuario.permisos,
      device_id: respuesta.device_id,
      requiere_contrasena: false,
    });
    return respuesta.access_token;
  }

  /**
   * Access token vigente para el motor de sync: refresca si le quedan menos de 30 s. `null` si no hay
   * usuario, si la sesión es offline sin sesión del servidor recuperable o si se requiere contraseña.
   */
  async obtenerAccessToken(): Promise<string | null> {
    if (this.#estado.usuario === null) {
      return null;
    }
    if (this.#token !== null && this.#ahora() < this.#expiraEn - MARGEN_EXPIRACION_MS) {
      return this.#token;
    }
    if (this.#estado.requiere_contrasena) {
      return null;
    }
    return this.refrescar();
  }

  /**
   * Al cargar la app: intenta recuperar la sesión del servidor con la cookie. Sin red queda
   * `sin_sesion` y la UI ofrece los perfiles del dispositivo (con contraseña, login offline).
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
   * Decisión: se conservan el perfil y el verificador, para que el usuario pueda volver a entrar sin
   * conexión en esta tablet (sus pendientes solo salen con su sesión). El riesgo de fuerza bruta
   * offline del verificador está aceptado en la ADR 0012.
   */
  async cerrarSesion(): Promise<ResultadoCierre> {
    const usuario = this.#estado.usuario;
    if (usuario === null) {
      return {
        servidor_notificado: false,
        datos_borrados: false,
        pendientes: { mutaciones: 0, evidencias: 0 },
      };
    }
    const token = this.#enLinea() ? await this.obtenerAccessToken() : null;
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
    this.#publicar(ESTADO_SIN_SESION);
    return {
      servidor_notificado: notificado,
      datos_borrados: borrados,
      pendientes: { mutaciones: pendientes.mutaciones, evidencias: pendientes.evidencias },
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

/** Sesión única de la PWA. */
export const sesion = new GestorSesion();

/** Cliente de la API con la sesión de la PWA (refresh automático ante 401). */
export const clienteApi: ClienteApi = sesion.api;

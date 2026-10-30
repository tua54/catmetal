// Cliente HTTP de la PWA hacia `/api/v1` del MISMO origen (docs/spec.md §5 y §7).
//
// - El access token lo da el proveedor de sesión y vive solo en memoria; aquí no se guarda nada.
// - `credentials: 'same-origin'`: la cookie `mp_refresh` (HttpOnly, Path=/api/v1/auth) la maneja el
//   navegador; el JS nunca la ve.
// - Errores: el formato único `{ code, message, details }` se convierte en `ErrorApi`; un fallo de
//   red o un tiempo de espera agotado es `ErrorRed` (sin conexión), para poder distinguirlos.
// - Ante 401 `NO_AUTENTICADO` se intenta UN refresh y se reintenta la petición UNA vez.
// - Toda escritura (método distinto de GET/HEAD) lleva `X-Hora-Dispositivo` con la hora del
//   dispositivo en el momento de CADA `fetch`, también en el reintento (ADR 0019, M2). No es un
//   secreto: el servidor la compara con la suya para `alerta_reloj`.

import {
  CABECERA_HORA_DISPOSITIVO,
  esCodigoError,
  MENSAJES_ERROR,
  type CodigoError,
} from '@catmetal/shared';

export const BASE_API = '/api/v1';
const TIEMPO_ESPERA_MS = 20_000;

/** Error HTTP de la API con su código del contrato. */
export class ErrorApi extends Error {
  override readonly name = 'ErrorApi';
  readonly code: CodigoError;
  readonly status: number;
  readonly details: unknown;

  constructor(code: CodigoError, status: number, message?: string, details?: unknown) {
    super(message ?? MENSAJES_ERROR[code]);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** No hubo respuesta del servidor: sin conexión, DNS, corte o tiempo de espera agotado. */
export class ErrorRed extends Error {
  override readonly name = 'ErrorRed';

  constructor(message = 'No hay conexión con el servidor.', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function esErrorDeRed(error: unknown): error is ErrorRed {
  return error instanceof ErrorRed;
}

/** Usuario al que debe pertenecer el token (F4-05): nunca se devuelve el de otra persona. */
export interface TokenEsperado {
  esperado?: string;
}

/** Lo que el cliente necesita de la sesión. */
export interface ProveedorSesion {
  /** Access token vigente (refrescándolo si está por vencer), o `null` si no hay sesión de servidor. */
  obtenerAccessToken(opciones?: TokenEsperado): Promise<string | null>;
  /** Fuerza un refresh (el servidor rechazó el token). Devuelve el nuevo token o `null`. */
  refrescar(opciones?: TokenEsperado): Promise<string | null>;
  /**
   * Usuario de la sesión al empezar la petición. Si existe, el token y el reintento tras un 401 se
   * piden ligados a ese usuario: si la sesión cambia a mitad de camino, no se reintenta con la de
   * otra persona.
   */
  usuarioActual?(): string | null;
  /** El servidor respondió `SESION_REVOCADA` a una petición autenticada. */
  sesionRevocada?(error: ErrorApi): void;
}

export interface OpcionesPeticion {
  metodo?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Cuerpo JSON. */
  cuerpo?: unknown;
  /** Cuerpo binario (subida de evidencias), con su `tipo` MIME. */
  binario?: { datos: BodyInit; tipo: string };
  /** Enviar `Authorization: Bearer` (por defecto, sí). */
  autenticar?: boolean;
  signal?: AbortSignal;
  tiempoEsperaMs?: number;
  /** Token a usar tal cual, sin pedirlo al proveedor ni refrescarlo. */
  bearer?: string;
  /**
   * `'omit'` evita enviar la cookie `mp_refresh`: el logout con `bearer` revoca entonces la familia
   * del token y no la de la cookie, que en una tablet compartida puede ser de otra persona.
   */
  credenciales?: RequestCredentials;
}

export interface ClienteApi {
  peticion<T>(ruta: string, opciones?: OpcionesPeticion): Promise<T>;
}

export interface ConfiguracionCliente {
  base?: string;
  fetch?: typeof fetch;
  proveedor?: ProveedorSesion;
  /** Reloj del dispositivo para `X-Hora-Dispositivo` (por defecto, `Date.now`). */
  ahora?: () => number;
}

/** Métodos que no escriben: no llevan la hora del dispositivo. */
const METODOS_DE_LECTURA: readonly string[] = ['GET', 'HEAD'];

async function leerError(respuesta: Response): Promise<ErrorApi> {
  let cuerpo: unknown = null;
  try {
    cuerpo = await respuesta.json();
  } catch {
    // Cuerpo vacío o no JSON (por ejemplo, una página de error de un proxy).
  }
  if (typeof cuerpo === 'object' && cuerpo !== null && 'code' in cuerpo) {
    const { code, message, details } = cuerpo as Record<string, unknown>;
    if (esCodigoError(code)) {
      return new ErrorApi(
        code,
        respuesta.status,
        typeof message === 'string' ? message : undefined,
        details,
      );
    }
  }
  const code: CodigoError =
    respuesta.status === 401
      ? 'NO_AUTENTICADO'
      : respuesta.status === 403
        ? 'PERMISO_DENEGADO'
        : respuesta.status === 404
          ? 'NO_ENCONTRADO'
          : 'ERROR_INTERNO';
  return new ErrorApi(code, respuesta.status);
}

async function leerCuerpo<T>(respuesta: Response): Promise<T> {
  const texto = await respuesta.text();
  return (texto === '' ? undefined : JSON.parse(texto)) as T;
}

export function crearClienteApi(configuracion: ConfiguracionCliente = {}): ClienteApi {
  const base = configuracion.base ?? BASE_API;
  // Se resuelve en cada llamada para respetar un `fetch` reemplazado después (pruebas, polyfills).
  const hacerFetch = (entrada: string, init: RequestInit): Promise<Response> =>
    (configuracion.fetch ?? globalThis.fetch)(entrada, init);

  async function enviar(
    ruta: string,
    opciones: OpcionesPeticion,
    token: string | null,
  ): Promise<Response> {
    const cabeceras = new Headers({ Accept: 'application/json' });
    let cuerpo: BodyInit | undefined;
    if (opciones.binario !== undefined) {
      cabeceras.set('Content-Type', opciones.binario.tipo);
      cuerpo = opciones.binario.datos;
    } else if (opciones.cuerpo !== undefined) {
      cabeceras.set('Content-Type', 'application/json');
      cuerpo = JSON.stringify(opciones.cuerpo);
    }
    if (token !== null) {
      cabeceras.set('Authorization', `Bearer ${token}`);
    }
    const metodo = opciones.metodo ?? 'GET';
    if (!METODOS_DE_LECTURA.includes(metodo)) {
      // Justo antes del `fetch` (sin `await` de por medio): la hora del envío, no la del registro.
      cabeceras.set(
        CABECERA_HORA_DISPOSITIVO,
        new Date((configuracion.ahora ?? Date.now)()).toISOString(),
      );
    }

    const control = new AbortController();
    const alAbortar = (): void => control.abort(opciones.signal?.reason);
    opciones.signal?.addEventListener('abort', alAbortar, { once: true });
    const temporizador = setTimeout(
      () => control.abort(new ErrorRed('El servidor tardó demasiado en responder.')),
      opciones.tiempoEsperaMs ?? TIEMPO_ESPERA_MS,
    );
    try {
      return await hacerFetch(`${base}${ruta}`, {
        method: metodo,
        headers: cabeceras,
        body: cuerpo,
        credentials: opciones.credenciales ?? 'same-origin',
        signal: control.signal,
      });
    } catch (error) {
      if (opciones.signal?.aborted === true) {
        throw error;
      }
      throw error instanceof ErrorRed ? error : new ErrorRed(undefined, { cause: error });
    } finally {
      clearTimeout(temporizador);
      opciones.signal?.removeEventListener('abort', alAbortar);
    }
  }

  async function peticion<T>(ruta: string, opciones: OpcionesPeticion = {}): Promise<T> {
    // Con `bearer` explícito no se consulta ni se refresca la sesión (por ejemplo, el logout).
    const autenticar = opciones.bearer === undefined && (opciones.autenticar ?? true);
    const proveedor = configuracion.proveedor;
    let token: string | null = opciones.bearer ?? null;
    // El usuario se fija ANTES del primer `await`: el token y el reintento quedan ligados a él.
    const esperado = autenticar ? (proveedor?.usuarioActual?.() ?? undefined) : undefined;
    const ligado: TokenEsperado = esperado === undefined ? {} : { esperado };
    if (autenticar) {
      token = (await proveedor?.obtenerAccessToken(ligado)) ?? null;
      if (token === null) {
        throw new ErrorApi('NO_AUTENTICADO', 401);
      }
    }

    let respuesta = await enviar(ruta, opciones, token);
    if (!respuesta.ok) {
      let error = await leerError(respuesta);
      if (autenticar && proveedor !== undefined && error.code === 'NO_AUTENTICADO') {
        const nuevo = await proveedor.refrescar(ligado);
        if (nuevo === null) {
          throw error;
        }
        respuesta = await enviar(ruta, opciones, nuevo);
        if (respuesta.ok) {
          return leerCuerpo<T>(respuesta);
        }
        error = await leerError(respuesta);
      }
      if (autenticar && error.code === 'SESION_REVOCADA') {
        proveedor?.sesionRevocada?.(error);
      }
      throw error;
    }
    return leerCuerpo<T>(respuesta);
  }

  return { peticion };
}

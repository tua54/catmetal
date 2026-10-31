// Errores de la API con el formato único `{ code, message, details }` (docs/spec.md §7).
// Los códigos, mensajes y estados HTTP vienen de @catmetal/shared.

import {
  type CodigoError,
  crearError,
  ESTADO_HTTP_POR_CODIGO,
  MENSAJES_ERROR,
} from '@catmetal/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { registrar } from './log';

/**
 * Error de negocio o de acceso que las rutas lanzan con `throw new ErrorApi('CODIGO')`.
 * `manejarError` lo traduce al formato único con el estado HTTP del código.
 */
export class ErrorApi extends Error {
  readonly code: CodigoError;
  readonly details: unknown;

  constructor(code: CodigoError, details?: unknown) {
    super(MENSAJES_ERROR[code]);
    this.name = 'ErrorApi';
    this.code = code;
    this.details = details;
  }
}

/** Responde con el formato único de error y el estado HTTP que corresponde al código. */
export function responderError(c: Context, code: CodigoError, details?: unknown): Response {
  const estado = ESTADO_HTTP_POR_CODIGO[code] as ContentfulStatusCode;
  return c.json(crearError(code, details), estado);
}

/** Códigos para las HTTPException que lanza Hono (por ejemplo, JSON mal formado en el cuerpo). */
function codigoDeEstado(estado: number): CodigoError {
  switch (estado) {
    case 400:
      return 'VALIDACION';
    case 401:
      return 'NO_AUTENTICADO';
    case 403:
      return 'PERMISO_DENEGADO';
    case 404:
      return 'NO_ENCONTRADO';
    default:
      return 'ERROR_INTERNO';
  }
}

/** Identificador de la petición para correlacionar logs (cf-ray en Cloudflare). */
function idPeticion(c: Context): string {
  return c.req.header('cf-ray') ?? crypto.randomUUID();
}

/**
 * `app.onError`: `ErrorApi` → su código; `HTTPException` de Hono → código equivalente; cualquier otro
 * error → 500 `ERROR_INTERNO`, sin filtrar detalles al cliente y con un log estructurado.
 */
export const manejarError: ErrorHandler = (err, c) => {
  if (err instanceof ErrorApi) {
    return responderError(c, err.code, err.details);
  }
  if (err instanceof HTTPException) {
    return responderError(c, codigoDeEstado(err.status));
  }
  // Solo nombre y mensaje del error (las rutas no deben poner datos personales en los mensajes),
  // método y ruta sin query string.
  registrar('error', 'error_no_controlado', {
    id_peticion: idPeticion(c),
    metodo: c.req.method,
    ruta: c.req.path,
    error: err.name,
    mensaje: err.message.slice(0, 300),
  });
  return responderError(c, 'ERROR_INTERNO');
};

/** `notFound` de la API: siempre JSON con el formato único, nunca el shell de la SPA. */
export const manejarNoEncontrado: NotFoundHandler = (c) => responderError(c, 'NO_ENCONTRADO');

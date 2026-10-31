// Límite de tamaño del cuerpo en `/api/v1/*` (H-05 de docs/auditoria/seguridad-fase-2.md).
//
// - Por defecto 64 KB: ningún JSON de la API necesita más (el login, sin autenticación, incluido).
// - `PUT /api/v1/evidences/:id` queda fuera: lee el cuerpo binario en streaming con su propio
//   límite de 5 MB (`MAX_EVIDENCIA_BYTES`, `leerCuerpoLimitado`).
// - `POST /api/v1/sync/push` (Fase 3) tendrá 2 MB: hasta 25 mutaciones de ≤ 64 KiB cada una
//   (`MAX_MUTACIONES_POR_LOTE` × `MAX_PAYLOAD_MUTACION_BYTES` ≈ 1,6 MB) más el sobre.
//
// Se aplica antes de autenticar y de validar: un cuerpo excesivo no llega a D1 ni al limitador.
// `bodyLimit` usa `Content-Length` si viene (y no hay `Transfer-Encoding`); si no, cuenta los bytes
// en streaming y corta al pasar el máximo. Error con el formato único: 413 `LOTE_DEMASIADO_GRANDE`.

import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { responderError } from '../errores';
import type { AppEnv } from '../tipos';

export const LIMITE_CUERPO_BYTES = 64 * 1024;
export const LIMITE_CUERPO_SYNC_PUSH_BYTES = 2 * 1024 * 1024;

const RUTA_EVIDENCIA = /^\/api\/v1\/evidences\/[^/]+$/;
const RUTA_SYNC_PUSH = '/api/v1/sync/push';

const demasiadoGrande = (c: Parameters<MiddlewareHandler>[0]) =>
  responderError(c, 'LOTE_DEMASIADO_GRANDE');

const limiteGeneral = bodyLimit({ maxSize: LIMITE_CUERPO_BYTES, onError: demasiadoGrande });
const limiteSyncPush = bodyLimit({
  maxSize: LIMITE_CUERPO_SYNC_PUSH_BYTES,
  onError: demasiadoGrande,
});

export const limitarCuerpo: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { method, path } = c.req;
  if (method === 'PUT' && RUTA_EVIDENCIA.test(path)) {
    await next();
    return undefined;
  }
  if (method === 'POST' && path === RUTA_SYNC_PUSH) {
    return limiteSyncPush(c, next);
  }
  return limiteGeneral(c, next);
};

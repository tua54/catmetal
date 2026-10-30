// Versión mínima del cliente (B5, ADR 0026). El cliente manda `X-Version-Cliente: <entero>` en toda
// petición a `/api/v1`; ausente o inválida cuenta como 1 (los clientes v1.0 no la mandan). Si es
// menor que `VERSION_MINIMA_CLIENTE` (variable de wrangler.jsonc por entorno; vacía o inválida → 1),
// responde 426 `CLIENTE_DESACTUALIZADO` con `details.version_minima`.
//
// Corre antes de autenticar, de leer el cuerpo y de tocar D1: un cliente desactualizado no escribe,
// no audita, no consume cupos de login y no deja filas en `sync_mutations`. El 426 es de la
// petición entera, no de una mutación: el cliente deja su outbox `pendiente` y se actualiza.
// `GET /api/v1/health` queda fuera (diagnóstico del despliegue, sin datos de negocio).

import { CABECERA_VERSION_CLIENTE, versionClienteDe } from '@catmetal/shared';
import type { MiddlewareHandler } from 'hono';
import { responderError } from '../errores';
import type { AppEnv } from '../tipos';

const RUTA_SALUD = '/api/v1/health';

export const verificarVersionCliente: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path === RUTA_SALUD) {
    await next();
    return undefined;
  }
  const versionMinima = versionClienteDe(c.env.VERSION_MINIMA_CLIENTE);
  const version = versionClienteDe(c.req.header(CABECERA_VERSION_CLIENTE));
  if (version < versionMinima) {
    return responderError(c, 'CLIENTE_DESACTUALIZADO', { version_minima: versionMinima });
  }
  await next();
  return undefined;
};

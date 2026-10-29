// CSRF por `Origin` (docs/spec.md §5, ADR 0008 punto 5): además de SameSite=Strict, toda petición
// a `/api` que cambie estado (método distinto de GET/HEAD/OPTIONS) exige `Origin` igual al origen de
// la petición o, solo en desarrollo, a uno de `ORIGENES_DEV` (separados por comas). Sin `Origin` → 403.

import type { MiddlewareHandler } from 'hono';
import { responderError } from '../errores';
import type { AppEnv } from '../tipos';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function origenesPermitidos(urlPeticion: string, origenesDev: string): Set<string> {
  const permitidos = new Set([new URL(urlPeticion).origin]);
  for (const origen of origenesDev.split(',')) {
    const limpio = origen.trim();
    if (limpio !== '') {
      permitidos.add(limpio);
    }
  }
  return permitidos;
}

export const verificarOrigen: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!METODOS_SEGUROS.has(c.req.method)) {
    const origen = c.req.header('Origin');
    if (origen === undefined || !origenesPermitidos(c.req.url, c.env.ORIGENES_DEV).has(origen)) {
      return responderError(c, 'ORIGEN_INVALIDO');
    }
  }
  await next();
  return undefined;
};

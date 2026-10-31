// CSRF por `Origin` (docs/spec.md §5, ADR 0008 punto 5): además de SameSite=Strict, toda petición
// a `/api` que cambie estado (método distinto de GET/HEAD/OPTIONS) exige `Origin` igual al origen de
// la petición o, solo en desarrollo, a uno de `ORIGENES_DEV` (separados por comas). Sin `Origin` → 403.
//
// H-06: `ORIGENES_DEV` solo se aplica si `ENTORNO === 'local'`, y de su lista solo se aceptan
// orígenes loopback exactos `http://localhost:<puerto>` o `http://127.0.0.1:<puerto>`. Un despliegue
// sin `--env` (que heredaría las `vars` locales) o un valor mal cargado no abren la API a otro sitio.

import type { MiddlewareHandler } from 'hono';
import { responderError } from '../errores';
import type { AppEnv } from '../tipos';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ORIGEN_LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):[1-9]\d{0,4}$/;

/** Orígenes de desarrollo aceptables: solo loopback por HTTP con puerto explícito. */
export function esOrigenDevValido(origen: string): boolean {
  if (!ORIGEN_LOOPBACK.test(origen)) {
    return false;
  }
  const puerto = Number(origen.slice(origen.lastIndexOf(':') + 1));
  return puerto <= 65_535;
}

export function origenesPermitidos(
  urlPeticion: string,
  origenesDev: string,
  entorno: string,
): Set<string> {
  const permitidos = new Set([new URL(urlPeticion).origin]);
  if (entorno !== 'local') {
    return permitidos;
  }
  for (const origen of origenesDev.split(',')) {
    const limpio = origen.trim();
    if (limpio !== '' && esOrigenDevValido(limpio)) {
      permitidos.add(limpio);
    }
  }
  return permitidos;
}

export const verificarOrigen: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!METODOS_SEGUROS.has(c.req.method)) {
    const origen = c.req.header('Origin');
    const permitidos = origenesPermitidos(c.req.url, c.env.ORIGENES_DEV, c.env.ENTORNO);
    if (origen === undefined || !permitidos.has(origen)) {
      return responderError(c, 'ORIGEN_INVALIDO');
    }
  }
  await next();
  return undefined;
};

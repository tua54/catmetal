// Validación de los secretos del Worker al primer uso (H-07 de docs/auditoria/seguridad-fase-2.md).
//
// `JWT_SECRET` y `REFRESH_SECRET` deben tener al menos 43 caracteres (32 bytes en base64url, como
// los genera `scripts/gen-dev-vars.mjs` y `docs/despliegue.md`) y ser distintos. Si no, toda ruta de
// `/api` responde 500 `ERROR_INTERNO` y se registra un log estructurado SIN los valores: un secreto
// corto o repetido cargado por error no debe firmar tokens.
//
// El resultado se memoriza por isolate para el par de valores evaluado (en producción el par no
// cambia; en las pruebas puede llegar otro `env`).

import type { MiddlewareHandler } from 'hono';
import { responderError } from '../errores';
import { registrar } from '../log';
import type { AppEnv } from '../tipos';

export const LONGITUD_MINIMA_SECRETO = 43;

export interface DiagnosticoSecretos {
  jwt_suficiente: boolean;
  refresh_suficiente: boolean;
  distintos: boolean;
}

export function diagnosticarSecretos(
  jwt: string | undefined,
  refresh: string | undefined,
): DiagnosticoSecretos {
  const jwtSuficiente = typeof jwt === 'string' && jwt.length >= LONGITUD_MINIMA_SECRETO;
  const refreshSuficiente =
    typeof refresh === 'string' && refresh.length >= LONGITUD_MINIMA_SECRETO;
  return {
    jwt_suficiente: jwtSuficiente,
    refresh_suficiente: refreshSuficiente,
    distintos: jwt !== refresh,
  };
}

let memoria: { jwt: string | undefined; refresh: string | undefined; validos: boolean } | null =
  null;

function secretosValidos(jwt: string | undefined, refresh: string | undefined): boolean {
  if (memoria !== null && memoria.jwt === jwt && memoria.refresh === refresh) {
    return memoria.validos;
  }
  const diagnostico = diagnosticarSecretos(jwt, refresh);
  const validos =
    diagnostico.jwt_suficiente && diagnostico.refresh_suficiente && diagnostico.distintos;
  if (!validos) {
    // Solo booleanos: nunca el valor ni la longitud exacta de un secreto.
    registrar('error', 'secretos_invalidos', { ...diagnostico });
  }
  memoria = { jwt, refresh, validos };
  return validos;
}

export const verificarSecretos: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!secretosValidos(c.env.JWT_SECRET, c.env.REFRESH_SECRET)) {
    return responderError(c, 'ERROR_INTERNO');
  }
  await next();
  return undefined;
};

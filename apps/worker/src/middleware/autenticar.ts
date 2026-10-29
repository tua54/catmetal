// Autenticación de cada petición (ADR 0008 punto 1).
//
// 1. `Authorization: Bearer <jwt>` → firma, algoritmo HS256, emisor, audiencia y vencimiento.
// 2. UNA consulta indexada: el usuario sigue activo, su rol ACTUAL y que la familia del token
//    (`fam`) tenga al menos un refresh token vigente. Así el logout, la desactivación, el cambio de
//    rol y la detección de robo cortan el acceso de inmediato, sin esperar a que venza el JWT.

import { ahoraIso, type Permiso, type Rol, tienePermiso } from '@catmetal/shared';
import type { MiddlewareHandler } from 'hono';
import { verificarAccessToken } from '../auth/tokens';
import { responderError } from '../errores';
import type { AppEnv } from '../tipos';

interface FilaSesion {
  rol: Rol;
  activo: number;
  familia_vigente: number;
}

const CONSULTA_SESION = `
  SELECT u.rol AS rol, u.activo AS activo,
    EXISTS (
      SELECT 1 FROM refresh_tokens AS r
      WHERE r.familia_id = ?1 AND r.user_id = u.id AND r.device_id = ?2
        AND r.revocado_at IS NULL AND r.expira_at > ?3
    ) AS familia_vigente
  FROM users AS u
  WHERE u.id = ?4`;

/** Lee el token Bearer de la cabecera `Authorization`. */
export function tokenBearer(cabecera: string | undefined): string | null {
  const coincidencia = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(cabecera ?? '');
  return coincidencia?.[1] ?? null;
}

export const autenticar: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = tokenBearer(c.req.header('Authorization'));
  if (token === null) {
    return responderError(c, 'NO_AUTENTICADO');
  }
  const claims = await verificarAccessToken(c.env.JWT_SECRET, token);
  if (claims === null) {
    return responderError(c, 'NO_AUTENTICADO');
  }
  const fila = await c.env.DB.prepare(CONSULTA_SESION)
    .bind(claims.fam, claims.did, ahoraIso(), claims.sub)
    .first<FilaSesion>();
  if (fila === null || fila.activo !== 1 || fila.familia_vigente !== 1) {
    return responderError(c, 'SESION_REVOCADA');
  }
  c.set('sesion', {
    userId: claims.sub,
    rol: fila.rol,
    deviceId: claims.did,
    familiaId: claims.fam,
  });
  await next();
  return undefined;
};

/** Exige un permiso del rol actual (docs/spec.md §3). Va siempre después de `autenticar`. */
export function requierePermiso(permiso: Permiso): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!tienePermiso(c.get('sesion').rol, permiso)) {
      return responderError(c, 'PERMISO_DENEGADO');
    }
    await next();
    return undefined;
  };
}

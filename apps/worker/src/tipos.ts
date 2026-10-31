// Tipos de Hono para el Worker.
//
// `Env` lo genera `wrangler types` en worker-configuration.d.ts a partir de wrangler.jsonc
// (bindings, vars y `secrets.required`). Tras cambiar wrangler.jsonc: `pnpm --filter @catmetal/worker cf-typegen`.

import type { Rol } from '@catmetal/shared';

/**
 * Sesión autenticada que deja el middleware `autenticar` (ADR 0008 punto 1).
 * `rol` es el rol ACTUAL leído de D1 en cada petición, nunca el del token.
 */
export interface Sesion {
  userId: string;
  rol: Rol;
  /** `did` del token: el servidor usa siempre este, nunca un `device_id` del cuerpo. */
  deviceId: string;
  /** `fam` del token: familia de refresh tokens de la sesión. */
  familiaId: string;
}

export interface Variables {
  sesion: Sesion;
}

export interface AppEnv {
  Bindings: Env;
  Variables: Variables;
}

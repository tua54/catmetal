// Contexto de un comando de dominio (docs/plan-fase-2.md, "Arquitectura: comandos de dominio").
//
// Un comando recibe el contexto, LEE y VALIDA, y devuelve un `PlanDeEscritura` sin ejecutarlo. Lo
// ejecutan la ruta REST (`ejecutarPlan`) o el motor de `/sync/push` (Fase 3), que agrega su fila de
// `sync_mutations` al final del mismo batch. Por eso el contexto no depende de Hono.

import { ahoraIso, type Rol } from '@catmetal/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../tipos';

export interface Actor {
  id: string;
  /** Rol ACTUAL leído de D1 por el middleware `autenticar` (ADR 0008 punto 1). */
  rol: Rol;
}

export interface Contexto {
  db: D1Database;
  actor: Actor;
  /** `did` de la sesión: el servidor nunca usa un `device_id` del cuerpo (ADR 0008 punto 7). */
  deviceId: string;
  /** Hora del servidor de la operación, en el formato único (`ahoraIso()`). */
  ahora: string;
  /** Hora del dispositivo, si la operación viene de una mutación offline (alerta de reloj). */
  clientAt?: string;
}

/** Contexto a partir de una petición autenticada (después del middleware `autenticar`). */
export function contextoDesdeHono(
  c: Context<AppEnv>,
  opciones: { clientAt?: string } = {},
): Contexto {
  const sesion = c.get('sesion');
  return {
    db: c.env.DB,
    actor: { id: sesion.userId, rol: sesion.rol },
    deviceId: sesion.deviceId,
    ahora: ahoraIso(),
    ...(opciones.clientAt === undefined ? {} : { clientAt: opciones.clientAt }),
  };
}

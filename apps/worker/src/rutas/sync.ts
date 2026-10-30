// Rutas de sincronización offline (docs/spec.md §6; tareas 3.1 y 3.2 de docs/plan-fase-3.md).
// Todas exigen sesión (cualquier rol): los permisos de cada mutación los revalida su comando de
// dominio, y lo que devuelven el pull y el snapshot lo filtran las reglas de visibilidad.

import { snapshotQuerySchema, syncPullQuerySchema, syncPushRequestSchema } from '@catmetal/shared';
import { Hono } from 'hono';
import { contextoDesdeHono } from '../dominio/contexto';
import { responderError } from '../errores';
import { autenticar } from '../middleware/autenticar';
import { registrar } from '../log';
import { pull } from '../sync/pull';
import { marcarSincronizado, procesarLote, type SesionPush } from '../sync/push';
import { snapshot } from '../sync/snapshot';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasSync(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  rutas.post('/push', autenticar, validar('json', syncPushRequestSchema), async (c) => {
    const { user_id: autor, mutaciones } = c.req.valid('json');
    const s = c.get('sesion');
    // Tablet compartida (ADR 0008 punto 8): nunca se registra lo de A con la sesión de B.
    if (autor !== s.userId) {
      return responderError(c, 'AUTOR_NO_COINCIDE');
    }
    const sesion: SesionPush = {
      db: c.env.DB,
      actor: { id: s.userId, rol: s.rol },
      deviceId: s.deviceId,
    };
    const resultados = await procesarLote(sesion, mutaciones);
    try {
      await marcarSincronizado(sesion);
    } catch (error) {
      // No se pierde la respuesta de lo ya aplicado por no poder anotar la hora de sync.
      registrar('aviso', 'sync_push_ultimo_sync_no_actualizado', {
        error: error instanceof Error ? error.name : 'desconocido',
      });
    }
    return c.json({ resultados });
  });

  rutas.get('/pull', autenticar, validar('query', syncPullQuerySchema), async (c) =>
    c.json(await pull(contextoDesdeHono(c), c.req.valid('query').cursor)),
  );

  rutas.get('/snapshot', autenticar, validar('query', snapshotQuerySchema), async (c) =>
    c.json(await snapshot(contextoDesdeHono(c), c.req.valid('query'))),
  );

  return rutas;
}

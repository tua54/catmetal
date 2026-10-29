// Respuesta temporal 501 para las rutas de la Fase 2 que todavía no están implementadas.
// La usan las sub-apps de consumos, evidencias, validaciones, auditoría y reportes mientras las
// completan las tareas 2.2–2.4; cuando una ruta real se registra, este handler se quita.

import { crearError } from '@catmetal/shared';
import type { Context } from 'hono';

/** 501 con el formato único de error (`ERROR_INTERNO` + `details.pendiente`). */
export function rutaPendiente(tarea: string) {
  return (c: Context) =>
    c.json(crearError('ERROR_INTERNO', { pendiente: true, tarea, ruta: c.req.routePath }), 501);
}

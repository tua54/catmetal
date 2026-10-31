// Rutas de consulta de la auditoría (docs/spec.md §3 "Ver auditoría" y §7).
//
// Esta sub-app se monta en la RAÍZ de `/api/v1` (app.ts), así que declara las rutas con su ruta
// completa y registra los middlewares POR RUTA, no con `use('*')`: los prefijos `/orders` y
// `/consumptions` los comparten varias sub-apps y un `use('*')` se aplicaría a rutas ajenas.
//
// Las dos rutas admiten cualquier rol autenticado: el filtro "solo lo propio" del supervisor lo
// aplica el dominio (dominio/auditoria-consulta.ts), no un 403.

import { auditoriaQuerySchema, idParamSchema, lineaTiempoQuerySchema } from '@catmetal/shared';
import { Hono } from 'hono';
import { lineaTiempoOrden, listarAuditoria } from '../dominio/auditoria-consulta';
import { contextoDesdeHono } from '../dominio/contexto';
import { autenticar } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasAuditoria(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  rutas.get('/audit', autenticar, validar('query', auditoriaQuerySchema), async (c) =>
    c.json(await listarAuditoria(contextoDesdeHono(c), c.req.valid('query'))),
  );

  rutas.get(
    '/orders/:id/audit',
    autenticar,
    validar('param', idParamSchema),
    validar('query', lineaTiempoQuerySchema),
    async (c) =>
      c.json(
        await lineaTiempoOrden(contextoDesdeHono(c), c.req.valid('param').id, c.req.valid('query')),
      ),
  );

  return rutas;
}

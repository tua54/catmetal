// Rutas `/api/v1/orders` (docs/spec.md §3 y §7).
//
// Los middlewares van POR RUTA (no con `use('*')`): el prefijo `/orders` lo comparten otras
// sub-apps (`/orders/:id/consumptions`, `/orders/:id/audit`) y un `use('*')` aquí también se
// aplicaría a esas rutas.

import {
  asignarSupervisoresSchema,
  crearOrdenSchema,
  finalizarOrdenSchema,
  idParamSchema,
  listarOrdenesQuerySchema,
} from '@catmetal/shared';
import { Hono } from 'hono';
import { reemplazarSupervisores } from '../dominio/asignaciones';
import { contextoDesdeHono } from '../dominio/contexto';
import {
  crearOrden,
  detalleOrden,
  finalizarOrden,
  iniciarOrden,
  listarOrdenes,
} from '../dominio/ordenes';
import { ejecutarPlan } from '../dominio/plan';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasOrdenes(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  // Ver: supervisor solo las asignadas activas; jefe y admin todas (dominio/visibilidad.ts).
  rutas.get('/', autenticar, validar('query', listarOrdenesQuerySchema), async (c) =>
    c.json(await listarOrdenes(contextoDesdeHono(c), c.req.valid('query'))),
  );

  rutas.get('/:id', autenticar, validar('param', idParamSchema), async (c) =>
    c.json(await detalleOrden(contextoDesdeHono(c), c.req.valid('param').id)),
  );

  rutas.post(
    '/',
    autenticar,
    requierePermiso('ordenes.gestionar'),
    validar('json', crearOrdenSchema),
    async (c) => {
      const plan = await crearOrden(contextoDesdeHono(c), c.req.valid('json'));
      return c.json(await ejecutarPlan(c.env.DB, plan), 201);
    },
  );

  rutas.post(
    '/:id/start',
    autenticar,
    requierePermiso('ordenes.gestionar'),
    validar('param', idParamSchema),
    async (c) => {
      const plan = await iniciarOrden(contextoDesdeHono(c), c.req.valid('param').id);
      return c.json(await ejecutarPlan(c.env.DB, plan));
    },
  );

  // Cuerpo opcional: sin cuerpo JSON equivale a `{}` (sin force).
  rutas.post(
    '/:id/finish',
    autenticar,
    requierePermiso('ordenes.gestionar'),
    validar('param', idParamSchema),
    validar('json', finalizarOrdenSchema),
    async (c) => {
      const plan = await finalizarOrden(
        contextoDesdeHono(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(await ejecutarPlan(c.env.DB, plan));
    },
  );

  rutas.put(
    '/:id/supervisors',
    autenticar,
    requierePermiso('admin.gestionar'),
    validar('param', idParamSchema),
    validar('json', asignarSupervisoresSchema),
    async (c) => {
      const plan = await reemplazarSupervisores(
        contextoDesdeHono(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(await ejecutarPlan(c.env.DB, plan));
    },
  );

  return rutas;
}

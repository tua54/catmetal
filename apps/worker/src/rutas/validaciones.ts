// Rutas de validación del jefe (docs/spec.md §3 y §7; tarea 2.3). Reglas en `dominio/validaciones.ts`.
//
// Esta sub-app se monta en la RAÍZ de `/api/v1` (app.ts) y declara sus rutas completas. Los
// middlewares van POR RUTA, no con `use('*')`: los prefijos `/consumptions` y `/orders` los
// comparten varias sub-apps y un `use('*')` se aplicaría a rutas ajenas.

import {
  aprobarSchema,
  colaValidacionQuerySchema,
  idParamSchema,
  rechazarSchema,
} from '@catmetal/shared';
import { Hono } from 'hono';
import { ejecutarConReintento } from '../dominio/consumos';
import { contextoDesdeHono } from '../dominio/contexto';
import { aprobarConsumo, colaDeValidacion, rechazarConsumo } from '../dominio/validaciones';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasValidaciones(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  rutas.get(
    '/validations/queue',
    autenticar,
    requierePermiso('consumos.validar'),
    validar('query', colaValidacionQuerySchema),
    async (c) => c.json(await colaDeValidacion(contextoDesdeHono(c), c.req.valid('query'))),
  );

  rutas.post(
    '/consumptions/:id/approve',
    autenticar,
    requierePermiso('consumos.validar'),
    validar('param', idParamSchema),
    validar('json', aprobarSchema),
    async (c) => {
      const entrada = { ...c.req.valid('json'), consumption_id: c.req.valid('param').id };
      const resultado = await ejecutarConReintento(c.env.DB, () =>
        aprobarConsumo(contextoDesdeHono(c), entrada),
      );
      return c.json(resultado, 201);
    },
  );

  rutas.post(
    '/consumptions/:id/reject',
    autenticar,
    requierePermiso('consumos.validar'),
    validar('param', idParamSchema),
    validar('json', rechazarSchema),
    async (c) => {
      const entrada = { ...c.req.valid('json'), consumption_id: c.req.valid('param').id };
      const resultado = await ejecutarConReintento(c.env.DB, () =>
        rechazarConsumo(contextoDesdeHono(c), entrada),
      );
      return c.json(resultado, 201);
    },
  );

  return rutas;
}

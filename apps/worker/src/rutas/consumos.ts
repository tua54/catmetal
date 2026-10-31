// Rutas de consumos y novedades (docs/spec.md §3 y §7; tarea 2.2).
//
// Esta sub-app se monta en la RAÍZ de `/api/v1` (app.ts) y declara sus rutas completas. Los
// middlewares van POR RUTA, no con `use('*')`: los prefijos `/orders` y `/consumptions` los
// comparten varias sub-apps y un `use('*')` se aplicaría a rutas ajenas.

import {
  crearConsumoSchema,
  crearNovedadSchema,
  editarConsumoSchema,
  idParamSchema,
  paginacionQuerySchema,
} from '@catmetal/shared';
import { Hono } from 'hono';
import {
  editarConsumo,
  ejecutarConReintento,
  listarConsumosDeOrden,
  registrarConsumo,
} from '../dominio/consumos';
import { contextoDesdeHono } from '../dominio/contexto';
import { registrarNovedad } from '../dominio/novedades';
import { ejecutarPlan } from '../dominio/plan';
import { ErrorApi } from '../errores';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

/** El id de la ruta y el del cuerpo deben ser el mismo registro. */
function exigirMismoId(deRuta: string, delCuerpo: string, campo: string): void {
  if (deRuta !== delCuerpo) {
    throw new ErrorApi('VALIDACION', [
      { campo, mensaje: 'El identificador del cuerpo no coincide con el de la ruta.' },
    ]);
  }
}

export function crearRutasConsumos(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  rutas.get(
    '/orders/:id/consumptions',
    autenticar,
    validar('param', idParamSchema),
    validar('query', paginacionQuerySchema),
    async (c) =>
      c.json(
        await listarConsumosDeOrden(
          contextoDesdeHono(c),
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
      ),
  );

  rutas.post(
    '/consumptions',
    autenticar,
    requierePermiso('consumos.registrar'),
    validar('json', crearConsumoSchema),
    async (c) => {
      const entrada = c.req.valid('json');
      const consumo = await ejecutarConReintento(c.env.DB, () =>
        registrarConsumo(contextoDesdeHono(c), entrada),
      );
      return c.json(consumo, 201);
    },
  );

  rutas.patch(
    '/consumptions/:id',
    autenticar,
    requierePermiso('consumos.editar_propio'),
    validar('param', idParamSchema),
    validar('json', editarConsumoSchema),
    async (c) => {
      const entrada = c.req.valid('json');
      exigirMismoId(c.req.valid('param').id, entrada.id, 'id');
      const consumo = await ejecutarConReintento(c.env.DB, () =>
        editarConsumo(contextoDesdeHono(c), entrada),
      );
      return c.json(consumo);
    },
  );

  rutas.post(
    '/consumptions/:id/incident',
    autenticar,
    requierePermiso('novedades.registrar'),
    validar('param', idParamSchema),
    validar('json', crearNovedadSchema),
    async (c) => {
      const entrada = c.req.valid('json');
      exigirMismoId(c.req.valid('param').id, entrada.consumption_id, 'consumption_id');
      const plan = await registrarNovedad(contextoDesdeHono(c), entrada);
      return c.json(await ejecutarPlan(c.env.DB, plan), 201);
    },
  );

  return rutas;
}

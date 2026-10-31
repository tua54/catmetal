// Rutas `/api/v1/materials` (docs/spec.md §3 y §7). Leer: cualquier usuario autenticado (lo
// necesitan los formularios de consumo y de órdenes). Crear y editar: solo `admin.gestionar`.
// Nunca se borra un material: se desactiva con `activo: false`.

import {
  crearMaterialSchema,
  editarMaterialSchema,
  idParamSchema,
  listarMaterialesQuerySchema,
} from '@catmetal/shared';
import { Hono } from 'hono';
import { contextoDesdeHono } from '../dominio/contexto';
import { crearMaterial, editarMaterial, listarMateriales } from '../dominio/materiales';
import { ejecutarPlan } from '../dominio/plan';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasMateriales(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();
  rutas.use('*', autenticar);

  rutas.get('/', validar('query', listarMaterialesQuerySchema), async (c) =>
    c.json(await listarMateriales(c.env.DB, c.req.valid('query'))),
  );

  rutas.post(
    '/',
    requierePermiso('admin.gestionar'),
    validar('json', crearMaterialSchema),
    async (c) => {
      const plan = crearMaterial(contextoDesdeHono(c), c.req.valid('json'));
      return c.json(await ejecutarPlan(c.env.DB, plan), 201);
    },
  );

  rutas.patch(
    '/:id',
    requierePermiso('admin.gestionar'),
    validar('param', idParamSchema),
    validar('json', editarMaterialSchema),
    async (c) => {
      const plan = await editarMaterial(
        contextoDesdeHono(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(await ejecutarPlan(c.env.DB, plan));
    },
  );

  return rutas;
}

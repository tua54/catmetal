// Rutas `/api/v1/settings` (docs/spec.md §4 y §7). Leer: cualquier usuario autenticado (la PWA
// muestra la tolerancia vigente). Cambiar la tolerancia: solo `admin.gestionar`, auditado.

import { toleranciaSchema } from '@catmetal/shared';
import { Hono } from 'hono';
import { contextoDesdeHono } from '../dominio/contexto';
import { ejecutarPlan } from '../dominio/plan';
import { cambiarTolerancia, leerConfiguracion } from '../dominio/settings';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasSettings(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();
  rutas.use('*', autenticar);

  rutas.get('/', async (c) => c.json(await leerConfiguracion(c.env.DB)));

  rutas.patch(
    '/tolerancia',
    requierePermiso('admin.gestionar'),
    validar('json', toleranciaSchema),
    async (c) => {
      const plan = await cambiarTolerancia(contextoDesdeHono(c), c.req.valid('json'));
      return c.json(await ejecutarPlan(c.env.DB, plan));
    },
  );

  return rutas;
}

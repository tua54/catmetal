// Rutas de reportes y exportación CSV (docs/spec.md §7 y §8).
//
// Esta sub-app se monta en la RAÍZ de `/api/v1` (app.ts), así que declara las rutas con su ruta
// completa y registra los middlewares POR RUTA, no con `use('*')`: los prefijos `/orders` y
// `/consumptions` los comparten varias sub-apps y un `use('*')` se aplicaría a rutas ajenas.
//
// Permisos (dominio/reportes.ts): jefe y admin cualquier orden; el supervisor solo sus órdenes
// asignadas activas; lo demás → 404.

import { idParamSchema } from '@catmetal/shared';
import { Hono } from 'hono';
import { contextoDesdeHono } from '../dominio/contexto';
import { exportarCsv, resumenOrden } from '../dominio/reportes';
import { autenticar } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasReportes(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  rutas.get('/reports/orders/:id/summary', autenticar, validar('param', idParamSchema), async (c) =>
    c.json(await resumenOrden(contextoDesdeHono(c), c.req.valid('param').id)),
  );

  rutas.get(
    '/reports/orders/:id/export.csv',
    autenticar,
    validar('param', idParamSchema),
    async (c) => {
      const { nombreArchivo, cuerpo } = await exportarCsv(
        contextoDesdeHono(c),
        c.req.valid('param').id,
      );
      // `nombreArchivo` solo tiene [A-Za-z0-9_-] y ".csv" (nombreArchivoCsv): no rompe la cabecera.
      return c.body(cuerpo, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${nombreArchivo}"`,
      });
    },
  );

  return rutas;
}

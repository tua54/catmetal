// Rutas de consumos y novedades (docs/spec.md §7).
//
// Lo completa la tarea 2.2 (docs/plan-fase-2.md). Esta sub-app se monta en la RAÍZ de
// `/api/v1` (app.ts), así que declara las rutas con su ruta completa. Registra los middlewares
// POR RUTA, no con `use('*')`: los prefijos `/orders` y `/consumptions` los comparten varias
// sub-apps y un `use('*')` se aplicaría a rutas ajenas. Reemplaza cada `rutaPendiente` por la
// ruta real.

import { Hono } from 'hono';
import type { AppEnv } from '../tipos';
import { rutaPendiente } from './pendiente';

export function crearRutasConsumos(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();
  const pendiente = rutaPendiente('2.2');
  rutas.get('/orders/:id/consumptions', pendiente);
  rutas.post('/consumptions', pendiente);
  rutas.patch('/consumptions/:id', pendiente);
  rutas.post('/consumptions/:id/incident', pendiente);
  return rutas;
}

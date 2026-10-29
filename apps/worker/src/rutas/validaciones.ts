// Rutas de validación del jefe (docs/spec.md §7).
//
// Lo completa la tarea 2.3 (docs/plan-fase-2.md). Esta sub-app se monta en la RAÍZ de
// `/api/v1` (app.ts), así que declara las rutas con su ruta completa. Registra los middlewares
// POR RUTA, no con `use('*')`: los prefijos `/orders` y `/consumptions` los comparten varias
// sub-apps y un `use('*')` se aplicaría a rutas ajenas. Reemplaza cada `rutaPendiente` por la
// ruta real.

import { Hono } from 'hono';
import type { AppEnv } from '../tipos';
import { rutaPendiente } from './pendiente';

export function crearRutasValidaciones(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();
  const pendiente = rutaPendiente('2.3');
  rutas.get('/validations/queue', pendiente);
  rutas.post('/consumptions/:id/approve', pendiente);
  rutas.post('/consumptions/:id/reject', pendiente);
  return rutas;
}

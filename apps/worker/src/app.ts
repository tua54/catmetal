// Aplicación Hono del Worker. Atiende todas las rutas (ADR 0004):
//   /api/v1/*  → API (Hono)
//   /api/*     → 404 JSON con el formato único (nunca el shell de la SPA)
//   el resto   → PWA compilada vía `env.ASSETS` (aplica `not_found_handling = single-page-application`)

import { Hono } from 'hono';
import { cabecerasSeguridad } from './cabeceras';
import { manejarError, manejarNoEncontrado } from './errores';
import { limitarCuerpo } from './middleware/limite-cuerpo';
import { verificarOrigen } from './middleware/origen';
import { verificarSecretos } from './middleware/secretos';
import { crearRutasAuditoria } from './rutas/auditoria';
import { crearRutasAuth } from './rutas/auth';
import { crearRutasConsumos } from './rutas/consumos';
import { crearRutasEvidencias } from './rutas/evidencias';
import { crearRutasMateriales } from './rutas/materiales';
import { crearRutasOrdenes } from './rutas/ordenes';
import { crearRutasReportes } from './rutas/reportes';
import { crearRutasSettings } from './rutas/settings';
import { crearRutasSync } from './rutas/sync';
import { crearRutasUsuarios } from './rutas/usuarios';
import { crearRutasValidaciones } from './rutas/validaciones';
import type { AppEnv } from './tipos';

/** Rutas de la API bajo `/api/v1`. */
function crearApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.get('/health', (c) =>
    c.json({ ok: true, entorno: c.env.ENTORNO, hora_servidor: new Date().toISOString() }),
  );
  api.route('/auth', crearRutasAuth());
  api.route('/users', crearRutasUsuarios());
  api.route('/materials', crearRutasMateriales());
  api.route('/settings', crearRutasSettings());
  api.route('/orders', crearRutasOrdenes());
  api.route('/sync', crearRutasSync());
  // Sub-apps de las tareas 2.2–2.4: se montan en la raíz y declaran sus rutas completas, porque
  // comparten prefijos (`/orders/:id/consumptions`, `/consumptions/:id/approve`). Así cada tarea
  // edita solo su archivo de rutas.
  api.route('/', crearRutasConsumos());
  api.route('/', crearRutasEvidencias());
  api.route('/', crearRutasValidaciones());
  api.route('/', crearRutasAuditoria());
  api.route('/', crearRutasReportes());

  return api;
}

/**
 * Sirve un asset estático. La respuesta de `env.ASSETS.fetch` tiene cabeceras inmutables: se copia
 * en una `Response` nueva para que el middleware pueda añadir las cabeceras de seguridad.
 */
async function servirAsset(request: Request, assets: Fetcher): Promise<Response> {
  const respuesta = await assets.fetch(request);
  return new Response(respuesta.body, respuesta);
}

export function crearApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', cabecerasSeguridad);
  app.onError(manejarError);
  app.notFound(manejarNoEncontrado);
  // Secretos fuertes y distintos (H-07): si no, toda la API responde 500 sin firmar nada.
  app.use('/api', verificarSecretos);
  app.use('/api/*', verificarSecretos);
  // CSRF por Origin en toda la API, antes de cualquier ruta (también en /auth/login y /auth/refresh).
  app.use('/api', verificarOrigen);
  app.use('/api/*', verificarOrigen);
  // Tamaño máximo del cuerpo (H-05), antes de autenticar, validar o tocar D1.
  app.use('/api/v1/*', limitarCuerpo);

  app.route('/api/v1', crearApi());
  app.all('/api', manejarNoEncontrado);
  app.all('/api/*', manejarNoEncontrado);

  app.all('*', (c) => servirAsset(c.req.raw, c.env.ASSETS));

  return app;
}

export const app = crearApp();

// Aplicación Hono del Worker. Atiende todas las rutas (ADR 0004):
//   /api/v1/*  → API (Hono)
//   /api/*     → 404 JSON con el formato único (nunca el shell de la SPA)
//   el resto   → PWA compilada vía `env.ASSETS` (aplica `not_found_handling = single-page-application`)

import { Hono } from 'hono';
import { cabecerasSeguridad } from './cabeceras';
import { manejarError, manejarNoEncontrado } from './errores';
import { verificarOrigen } from './middleware/origen';
import { crearRutasAuth } from './rutas/auth';
import { crearRutasUsuarios } from './rutas/usuarios';
import type { AppEnv } from './tipos';

/** Rutas de la API bajo `/api/v1`. */
function crearApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.get('/health', (c) =>
    c.json({ ok: true, entorno: c.env.ENTORNO, hora_servidor: new Date().toISOString() }),
  );
  api.route('/auth', crearRutasAuth());
  api.route('/users', crearRutasUsuarios());

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
  // CSRF por Origin en toda la API, antes de cualquier ruta (también en /auth/login y /auth/refresh).
  app.use('/api', verificarOrigen);
  app.use('/api/*', verificarOrigen);

  app.route('/api/v1', crearApi());
  app.all('/api', manejarNoEncontrado);
  app.all('/api/*', manejarNoEncontrado);

  app.all('*', (c) => servirAsset(c.req.raw, c.env.ASSETS));

  return app;
}

export const app = crearApp();

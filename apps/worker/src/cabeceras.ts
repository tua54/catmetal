// Cabeceras de seguridad para TODAS las respuestas: PWA y API (docs/spec.md §9, ADR 0004).

import type { MiddlewareHandler } from 'hono';

/**
 * CSP estricta. La PWA compilada no usa scripts ni estilos inline: React aplica `style={}` por
 * CSSOM (permitido) y Vite emite solo `<script src>` y `<link rel="stylesheet">`. Si algún día se
 * necesita un atributo `style=""` en HTML o un script inline, esta política lo bloqueará.
 */
export const POLITICA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const CABECERAS_SEGURIDAD: Readonly<Record<string, string>> = {
  'Content-Security-Policy': POLITICA_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
};

/** Respuestas de la API (`/api` y `/api/*`): nunca se cachean (datos de negocio y sesiones). */
function esRutaApi(ruta: string): boolean {
  return ruta === '/api' || ruta.startsWith('/api/');
}

/**
 * Aplica las cabeceras después de que la ruta respondió. Las respuestas deben tener cabeceras
 * mutables: las de `env.ASSETS.fetch` son inmutables, por eso la ruta de assets las copia antes
 * (ver `servirAsset` en app.ts).
 */
export const cabecerasSeguridad: MiddlewareHandler = async (c, next) => {
  await next();
  const cabeceras = c.res.headers;
  for (const [nombre, valor] of Object.entries(CABECERAS_SEGURIDAD)) {
    cabeceras.set(nombre, valor);
  }
  // Una ruta puede fijar su propio Cache-Control solo si también prohíbe guardar la respuesta (por
  // ejemplo `private, no-store` en GET /evidences/:id); cualquier otro valor se reemplaza.
  if (esRutaApi(c.req.path) && !(cabeceras.get('Cache-Control') ?? '').includes('no-store')) {
    cabeceras.set('Cache-Control', 'no-store');
  }
};

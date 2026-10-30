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
  // Trusted Types (`require-trusted-types-for 'script'`) se difiere a propósito (F6-07 de
  // docs/auditoria/seguridad-fase-6.md): exigirlo rompería React DOM y las librerías que asignan a
  // sinks de DOM (innerHTML del runtime, Workbox) sin una política propia y una revisión de cada
  // dependencia. Con `script-src 'self'` sin 'unsafe-inline'/'unsafe-eval' y sin
  // `dangerouslySetInnerHTML` en el código, el beneficio marginal no justifica ese trabajo ahora.
].join('; ');

export const CABECERAS_SEGURIDAD: Readonly<Record<string, string>> = {
  'Content-Security-Policy': POLITICA_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  // F6-07: aísla el contexto de navegación (una ventana abierta por otro origen no conserva
  // `window.opener` hacia la PWA). La PWA no usa popups OAuth ni comunicación entre ventanas.
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Respuestas de la API (`/api` y `/api/*`): nunca se cachean (datos de negocio y sesiones). */
function esRutaApi(ruta: string): boolean {
  return ruta === '/api' || ruta.startsWith('/api/');
}

/**
 * Archivos de la PWA sin hash en el nombre (F4-10 de docs/auditoria/seguridad-fase-4.md): el shell,
 * el Service Worker y el manifest. Deben revalidarse siempre: si una caché HTTP los retuviera, la
 * PWA no se enteraría de una versión nueva (el Service Worker nuevo no llegaría a instalarse).
 */
export const RUTAS_SIN_HASH: ReadonlySet<string> = new Set([
  '/',
  '/index.html',
  '/sw.js',
  '/manifest.webmanifest',
]);

/**
 * `Cache-Control: no-cache` para lo que no lleva hash: las rutas de `RUTAS_SIN_HASH` y cualquier
 * documento HTML (las navegaciones de la SPA devuelven `index.html` por `not_found_handling`). Los
 * assets con hash (`/assets/*.js`, `*.css`, fuentes, iconos) conservan el valor de Workers Static
 * Assets: no son HTML ni están en la lista.
 */
function debeRevalidarse(ruta: string, cabeceras: Headers): boolean {
  if (RUTAS_SIN_HASH.has(ruta)) {
    return true;
  }
  return (cabeceras.get('Content-Type') ?? '').toLowerCase().startsWith('text/html');
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
  if (esRutaApi(c.req.path)) {
    if (!(cabeceras.get('Cache-Control') ?? '').includes('no-store')) {
      cabeceras.set('Cache-Control', 'no-store');
    }
    return;
  }
  if (debeRevalidarse(c.req.path, cabeceras)) {
    cabeceras.set('Cache-Control', 'no-cache');
  }
};

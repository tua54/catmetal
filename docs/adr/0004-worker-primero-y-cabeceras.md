# ADR 0004 — El Worker atiende todas las rutas (`run_worker_first: true`) para aplicar las cabeceras de seguridad

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 0

## Contexto

La spec pide que las cabeceras de seguridad (CSP estricta, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) se apliquen a **todas** las respuestas, de la PWA y de la API (§7 y §9), y que `/api/*` llegue siempre al Worker (§2). La documentación de Workers Static Assets indica que, con `run_worker_first: ["/api/*"]`, el resto de rutas se sirve directamente desde assets **sin pasar por el Worker**, así que no llevarían las cabeceras que pone Hono.

## Opciones consideradas

1. `run_worker_first: ["/api/*"]` y un archivo `_headers` en el build de la web. Dos lugares con la misma política, fáciles de desincronizar, y el comportamiento de `_headers` en local no se prueba con el pool de Vitest.
2. `run_worker_first: true`: el Worker recibe todas las peticiones; `/api/*` lo atiende Hono y el resto se delega a `env.ASSETS.fetch(request)` (que aplica `not_found_handling = "single-page-application"`). Un único middleware aplica las cabeceras a todo.

## Decisión

Opción 2. Un solo middleware de cabeceras en el Worker, probado con pruebas de integración. `not_found_handling` sigue en `"single-page-application"` para que las rutas de la SPA devuelvan `index.html`. Las rutas `/api/*` desconocidas responden JSON 404 con el formato de error único, nunca el shell de la SPA.

## Consecuencias

- Cada petición de un asset estático cuenta como una invocación del Worker (coste despreciable para el volumen de una planta).
- La CSP se define en un solo archivo y se prueba.
- Se cumple también "que `/api/*` siempre llegue al Worker".

## Cómo revertir

Cambiar `run_worker_first` a `["/api/*"]` y generar un `_headers` en `apps/web/public/` con las mismas cabeceras.

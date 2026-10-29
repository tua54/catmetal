# ADR 0002 — Proceso de desarrollo local: `wrangler dev` + Vite, sin `@cloudflare/vite-plugin` en la v1

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 0

## Contexto

La spec (§2) pide evaluar `@cloudflare/vite-plugin` para tener un solo proceso de desarrollo con el Worker. El monorepo separa `apps/web` (PWA) de `apps/worker` (API + Static Assets), y `wrangler.jsonc` vive en `apps/worker`. Además:

- Las pruebas E2E offline (Fase 4) necesitan el **build real** de la PWA con su Service Worker; el SW de Workbox no se comporta igual en el servidor de desarrollo de Vite.
- Las pruebas del Worker usan `@cloudflare/vitest-pool-workers`, que lee `wrangler.jsonc` de forma independiente.
- El equipo trabaja en Windows y valora la simplicidad.

## Opciones consideradas

1. **`@cloudflare/vite-plugin` en `apps/web`**, apuntando a `../worker/wrangler.jsonc`. Un solo proceso con HMR y el Worker en `workerd`. Acopla el build de la web al del Worker, mezcla dos paquetes en un mismo proyecto de Vite y cambia cómo se resuelve `assets.directory`.
2. **Dos procesos**: `wrangler dev` en `apps/worker` (API + assets compilados, puerto 8787) y `vite` en `apps/web` (puerto 5173, proxy de `/api` hacia 8787). Un script de Node (`scripts/dev.mjs`) los lanza juntos.
3. Solo `wrangler dev` sirviendo el build (sin HMR).

## Decisión

Opción 2. `pnpm dev` ejecuta `scripts/dev.mjs`, que aplica las migraciones locales y lanza ambos procesos. Las E2E usan la opción 3 (build de la web + `wrangler dev`), que es lo más parecido a producción.

Para que la verificación de `Origin` (CSRF, §5) funcione detrás del proxy de Vite, el Worker acepta como origen propio el de la petición y, solo en desarrollo, los orígenes listados en la variable `ORIGENES_DEV` (no se define en `env.staging` ni en `env.production`).

## Consecuencias

- Dos puertos en desarrollo; el navegador usa el de Vite (5173).
- El build de producción no depende del plugin; `wrangler.jsonc` es la única configuración del Worker.
- Se pierde la paridad de `workerd` dentro del servidor de Vite, pero la API corre siempre en `wrangler dev` (workerd), así que no hay diferencia de runtime para el backend.

## Cómo revertir

Agregar `@cloudflare/vite-plugin` a `apps/web/vite.config.ts` con `configPath: '../worker/wrangler.jsonc'`, eliminar el proxy y simplificar `scripts/dev.mjs`. No afecta al código de la API ni de la PWA.

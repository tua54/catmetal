# Notas de plataforma

Particularidades encontradas en Windows, Cloudflare y las librerías durante la sesión.

## Windows

- **pnpm sin permisos de administrador.** `corepack enable` intenta escribir en `C:\Program Files\nodejs` y falla con `EPERM`. Alternativa sin admin: `corepack enable pnpm --install-directory "%APPDATA%\npm"` (esa carpeta ya está en el `PATH` del usuario; crearla si no existe).

## Diseño

- El servidor MCP de Figma no estaba conectado en la sesión. Se trabajó con `docs/diseno/README.md` y las capturas de baja resolución.

## Versiones

- `typescript-eslint` 8.72 admite `typescript >=4.8.4 <6.1.0`, así que no se puede usar TypeScript 7 (la versión `latest` en npm). Se fija TypeScript 6.0.x.
- `@cloudflare/vitest-pool-workers` 0.23 exige `vitest ^4.1.0`, así que no se puede usar Vitest 5. Se fija Vitest 4.1.x en todo el monorepo.

## Cloudflare (verificado en documentación oficial el 2026-10-29)

Fuente: informe de `documentation-researcher` (URLs en cada punto).

- **`@cloudflare/vitest-pool-workers` está deprecado** (npm: "renamed to @cloudflare/vitest-plugin"). Se usa **`@cloudflare/vitest-plugin` 1.4.x**, con la misma API. Desde 0.13 ya no existe `defineWorkersConfig`: se usa el plugin `cloudflareTest()` dentro de `defineConfig` de `vitest/config`. `isolatedStorage` y `singleWorker` ya no existen (aislamiento por archivo). `SELF`/`env` de `cloudflare:test` están deprecados: usar `import { env, exports } from 'cloudflare:workers'` y `exports.default.fetch()`. `exports.default.fetch` no sirve assets. Migraciones en pruebas: `readD1Migrations(dir)` + `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` en un `setupFiles`. https://developers.cloudflare.com/workers/testing/vitest-integration/
- **Cobertura en el pool de Workers: solo istanbul** (v8 no funciona). Hay reportes de cobertura 0 % con istanbul; se verifica en la Fase 0.
- **Rate Limiting**: clave `ratelimits` en `wrangler.jsonc` (`name`, `namespace_id` string numérica, `simple: { limit, period }`), `period` solo 10 o 60. `const { success } = await env.LOGIN_LIMITER.limit({ key })`. Aproximado y por ubicación. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **Static Assets**: `run_worker_first` acepta un array de patrones (`["/api/*"]`) y se combina con `not_found_handling: "single-page-application"`. Las respuestas servidas directamente desde assets **no pasan por el Worker**, así que no llevan las cabeceras que pone Hono: hay que cubrirlas con un `_headers` en el build o con `run_worker_first: true`.
- **Entornos**: `vars`, KV, R2, etc. no se heredan; `triggers`, `observability` y `assets` sí. Se repiten todos los bindings en cada entorno por regla general.
- **D1**: `batch()` atómico y secuencial; 100 parámetros enlazados por sentencia; 1000 consultas por invocación en Paid (un batch cuenta como una); FK siempre activas; `PRAGMA defer_foreign_keys = on` dentro de migraciones. `migrations_pattern` existe y debe empezar por `migrations_dir`.
- **PBKDF2**: workerd define `DEFAULT_MAX_PBKDF2_ITERATIONS = 100000` y lanza `DOMNotSupportedError` por encima. Los docs de Web Crypto no lo mencionan. https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h
- **Drizzle**: la documentación actual describe el formato de carpetas de drizzle-kit v1; con 0.31.x se verifica el formato real al generar. `drizzle-kit migrate/push` con `d1-http` van contra D1 remota: **prohibidos**; se aplica con `wrangler d1 migrations apply DB --local`. Para triggers: `drizzle-kit generate --custom --name triggers` (queda en el journal).
- **Hono**: `secureHeaders` con `contentSecurityPolicy`; `@hono/zod-validator` 0.9 acepta Zod 4; el hook debe devolver una `Response` para reemplazar el 400 por defecto.

## React Router 7 en Vitest

- En Vitest, `react-router` se resolvía como CommonJS y `react-router/dom` como ESM: quedaban dos contextos de router y fallaba `useRouteError`. Solución en `apps/web`: usar el `RouterProvider` de `react-router` pasándole `flushSync` de `react-dom` (lo mismo que hace internamente `react-router/dom`).

## Wrangler en Windows y en el pool de pruebas

- `wrangler dev` lanza `workerd.exe` como proceso nieto: para detenerlo hace falta matar el árbol (`taskkill /PID <pid> /T /F`). `scripts/dev.mjs` lo hace; en POSIX usa `detached` y mata el grupo de procesos.
- `wrangler d1 migrations apply --local` pide confirmación; sin TTY usa "fallback value: yes". Sin migraciones sale con código 0.
- `readD1Migrations('ruta')` resuelve rutas relativas desde el `cwd` (pnpm ejecuta los scripts en la carpeta del paquete).
- `secrets.required` en `wrangler.jsonc` (no se hereda: se repite por entorno) tipa los secretos en `wrangler types` sin leer `.dev.vars` y hace que `wrangler dev` avise si faltan.
- El binding `ratelimits` funciona en el pool de Vitest: 5 llamadas pasan y la sexta se bloquea.
- La cobertura istanbul **sí** funciona con `@cloudflare/vitest-plugin` 1.4.11 y Vitest 4.1.12 (no da 0 %).
- `vitest.config.mjs` (no `.ts`) en el worker: una config en TypeScript arrastra `@types/node` al programa de `src/` y permitiría usar APIs de Node sin error de tipos.
- Wrangler detecta que lo ejecuta un agente y anuncia una "Local Explorer API" en `/cdn-cgi/local/explorer/api` (solo local).
- `vite-plugin-pwa` con `injectRegister: 'inline'` rompería la CSP `script-src 'self'`: usar `'script'` o `virtual:pwa-register`.

## Drizzle y migraciones D1 (verificado en la tarea 1.1)

- drizzle-kit 0.31.11 genera archivos planos `NNNN_nombre.sql` más `meta/_journal.json` y `meta/NNNN_snapshot.json` (sin carpetas). `--custom` también genera snapshot. Wrangler y `readD1Migrations` solo leen los `.sql` del nivel superior: no hace falta `migrations_pattern`.
- drizzle-kit reescribe `migrations/meta/*.json` con tabulaciones en cada `db:generate`: esa carpeta está en `.prettierignore`.
- Wrangler (y `readD1Migrations`) separa sentencias como `sqlite3_complete`: entiende `CREATE TRIGGER ... BEGIN ... END;` y trata `--> statement-breakpoint` como comentario. Dentro del cuerpo de un trigger no debe aparecer `END;` salvo al final.
- SQLite no documenta el orden de disparo de varios triggers sobre la misma sentencia: si dos abortan, el mensaje que gana no es determinista.
- Errores de D1 por trigger: `D1_ERROR: <mensaje del RAISE>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`. Los CHECK fallidos incluyen el nombre de la restricción.
- `notnull` es palabra reservada en SQLite: no sirve como alias.
- En el pool de Workers no hay `fs`: las pruebas que necesitan leer archivos del repo reciben el contenido como binding generado en `vitest.config.mjs` (igual que `TEST_MIGRATIONS`).

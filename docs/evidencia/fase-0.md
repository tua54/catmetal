# Evidencia — Fase 0: Fundaciones

Fecha: 2026-10-29. Ejecutado por el orquestador en Windows 11, Node 24.18.0, pnpm 12.16.1, rama `build/v1`.

## Criterio de aceptación

> `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pasan, y `pnpm dev` levanta el Worker local con D1, R2 y KV locales.

**Cumplido.**

## Gates

| Comando | Código | Resumen |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | Lockfile al día |
| `pnpm lint` | 0 | ESLint 10 + typescript-eslint (type-aware) sin errores |
| `pnpm typecheck` | 0 | 3 paquetes; el worker incluye `wrangler types --check` |
| `pnpm test` | 0 | 152 pruebas aprobadas, 0 fallidas (detalle abajo) |
| `pnpm format:check` | 0 | Prettier sin diferencias |

### Pruebas y cobertura (istanbul)

| Paquete | Archivos | Pruebas | Fallidas | Líneas | Ramas | Funciones |
|---|---|---|---|---|---|---|
| `packages/shared` | 8 | 115 | 0 | 100 % | 93,26 % | 100 % |
| `apps/web` | 2 | 4 | 0 | (sin umbral) | — | — |
| `apps/worker` (pool real de Workers: D1, R2, KV y rate limiter locales) | 3 | 33 | 0 | 100 % | 94,44 % | 100 % |

El umbral de 80 % de líneas en `shared` y `worker` se comprobó forzándolo a 101 %: la ejecución sale con código 1 (lo verificaron los agentes de las tareas 0.2 y 0.3).

## `pnpm dev`

Script de verificación del orquestador (lanza `scripts/dev.mjs`, consulta la salud y mata el árbol de procesos):

```
8787: 200 {"ok":true,"entorno":"local","hora_servidor":"2026-10-29T22:22:38.290Z"}
5173 (proxy): 200 {"ok":true,"entorno":"local","hora_servidor":"2026-10-29T22:22:38.337Z"}
puerto 8787 libre
puerto 5173 libre
```

Las pruebas `apps/worker/test/bindings.test.ts` demuestran D1 (escritura/lectura, FK activas), R2 (put/get), KV (put/get) y `LOGIN_LIMITER` (la sexta llamada se bloquea) en local.

## Entregables

| Entregable | Ubicación |
|---|---|
| Monorepo pnpm | `package.json`, `pnpm-workspace.yaml` |
| Contratos | `packages/shared/src/` |
| Wrangler con entornos y bindings | `apps/worker/wrangler.jsonc` |
| ESLint, Prettier, Vitest | `eslint.config.js`, `.prettierrc.json`, `vitest.config.*` por paquete |
| CI | `.github/workflows/ci.yml` (no ejecutado aún en GitHub) |
| `.dev.vars.example` + generador | `apps/worker/.dev.vars.example`, `scripts/gen-dev-vars.mjs` |
| README para Windows | `README.md` |
| ADR de versiones | `docs/adr/0001-versiones.md` (más 0002, 0003, 0004) |

## Pendiente o con riesgo

- `ci.yml` no se ha ejecutado en GitHub (no hay push en esta sesión).
- La PWA genera el Service Worker pero no lo registra (Fase 4). El manifest no tiene íconos (pendiente humano del logo SVG).
- `apps/web` publica sourcemaps (`sourcemap: true`); se revisará en la Fase 6.

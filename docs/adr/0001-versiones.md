# ADR 0001 — Versiones principales del stack

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 0

## Contexto

`CLAUDE.md` pide usar versiones estables actuales al instalar, fijarlas en el lockfile y registrarlas en un ADR. Algunas versiones `latest` de npm no son compatibles entre sí, y una dependencia que nombra la spec quedó deprecada.

## Opciones consideradas

1. Tomar siempre `latest`.
2. Tomar la versión estable más reciente **compatible** con el resto (peers verificados con `npm view`), fijada sin `^` en cada `package.json`.

## Decisión

Opción 2. Versiones exactas (fijadas en `package.json` y `pnpm-lock.yaml`):

| Área | Paquete | Versión | Nota |
|---|---|---|---|
| Runtime | Node.js | ≥ 22 (desarrollo con 24.18) | `.nvmrc` = 24 |
| Gestor | pnpm | 12.16.1 | `packageManager` en `package.json` |
| Lenguaje | TypeScript | 6.0.3 | **No 7.0.2**: `typescript-eslint` 8.72 admite `<6.1.0` |
| Lint | ESLint / typescript-eslint | 10.13.0 / 8.72.1 | Flat config |
| Formato | Prettier | 3.9.10 | |
| Pruebas | Vitest / @vitest/coverage-istanbul | 4.1.12 | **No 5.x**: se mantiene la línea 4.1, soportada por el plugin de Workers. v8 no funciona en el pool de Workers |
| Pruebas Worker | @cloudflare/vitest-plugin | 1.4.11 | **Sucesor de `@cloudflare/vitest-pool-workers`** (deprecado en npm el 2026-08-19, misma API) |
| E2E | @playwright/test | 1.64.1 | |
| Worker | wrangler | 4.156.0 | El plugin de pruebas fija esta versión |
| Worker | hono / @hono/zod-validator | 4.13.14 / 0.9.1 | |
| Worker | drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | |
| Worker | jose | 6.2.13 | 6.2.14 solo cambia tipos y tenía menos de 24 h |
| Worker | @cloudflare/workers-types | 5.20261028.1 | |
| Compartido | zod | 4.6.7 | |
| Web | react / react-dom | 19.3.1 | La spec pide la estable actual (no React 18) |
| Web | vite / @vitejs/plugin-react | 8.3.5 / 6.1.2 | |
| Web | vite-plugin-pwa / workbox-window | 2.0.0 / 7.4.1 | |
| Web | tailwindcss / @tailwindcss/vite | 4.3.3 | |
| Web | react-router | 7.18.5 | |
| Web | @tanstack/react-query | 5.105.0 | |
| Web | zustand | 5.0.16 | |
| Web | react-hook-form / @hookform/resolvers | 7.91.0 / 5.9.2 | |
| Web | dexie | 4.4.7 | |
| Web | browser-image-compression | 2.0.2 | |
| Web | @fontsource/poppins | 5.3.0 | Fuente empaquetada (CSP `'self'`, offline) |

Configuración de pnpm 12 en `pnpm-workspace.yaml`:

- `allowBuilds`: solo `esbuild`, `workerd` y `sharp` pueden ejecutar scripts de instalación (`strictDepBuilds` hace fallar la instalación ante cualquier otro).
- `minimumReleaseAge` (24 h por defecto) se respeta. Excepciones exactas y temporales: `@cloudflare/vitest-plugin@1.4.11`, `wrangler@4.156.0` y `miniflare@5.20261023.3-beta`, publicadas el día de la instalación. Se pueden retirar después del 2026-10-30.

## Consecuencias

- La spec y `CLAUDE.md` nombran `@cloudflare/vitest-pool-workers`; se usa su sucesor con el mismo comportamiento (D1 y R2 reales locales vía Miniflare). Registrado en `docs/desviaciones.md`.
- Subir a TypeScript 7 o a Vitest 5 requiere que `typescript-eslint` y el plugin de Workers lo admitan.

## Cómo revertir

Cambiar la versión en el `package.json` correspondiente, ejecutar `pnpm install` y correr los gates. Para volver a `@cloudflare/vitest-pool-workers@0.23.0`, cambiar el paquete y los imports (`@cloudflare/vitest-plugin` → `@cloudflare/vitest-pool-workers`).

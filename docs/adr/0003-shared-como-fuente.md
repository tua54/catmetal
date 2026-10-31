# ADR 0003 — `@catmetal/shared` se consume como código fuente TypeScript

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 0

## Contexto

`packages/shared` contiene los contratos entre la PWA y el Worker: tipos, esquemas Zod, roles, permisos, estados, códigos de error, conversión de unidades y formato. Lo consumen Vite (web), Wrangler/esbuild (worker), Vitest (ambos) y `tsc --noEmit`.

## Opciones consideradas

1. Compilar `shared` a `dist/` (tsc o tsup) y publicar `exports` hacia JS + `.d.ts`. Exige un paso de build antes de cada `typecheck`, `test` y `dev`, y se desincroniza con facilidad.
2. Exportar el código fuente: `"exports": { ".": "./src/index.ts" }`. Todas las herramientas del monorepo entienden TypeScript con `moduleResolution: "bundler"`.

## Decisión

Opción 2. El paquete no tiene build. Todo el código de `shared` debe ser compatible con el navegador y con Workers: sin APIs de Node, solo `crypto.getRandomValues`, `Intl` y Zod.

## Consecuencias

- Un único origen de verdad sin artefactos intermedios.
- Si en el futuro se publica `shared` fuera del monorepo, habrá que agregar un build.

## Cómo revertir

Agregar un script `build` con `tsc -p packages/shared` hacia `dist/`, cambiar `exports` a `./dist/index.js` y `types` a `./dist/index.d.ts`, y ejecutar el build antes de las demás tareas.

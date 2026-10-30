# Evidencia — sesión de correcciones v1.2

Comandos ejecutados por el orquestador y resumen real de su salida. Las salidas completas de los fallos previos de cada ítem van en el cuerpo de su commit.

## A10. Prueba estática de los runners

`cd apps/worker && pnpm exec vitest run test/correcciones-a10-runners.test.ts`

- Antes de la corrección (workflows con `ubuntu-latest`): `Tests 2 failed | 1 passed (3)`. Fallo: `.github/workflows/ci.yml: expected 'ubuntu-latest' to be 'ubuntu-24.04'`, y `-latest` encontrado en el contenido.
- Después (`ubuntu-24.04` en los 4 jobs): `Tests 4 passed (4)`, junto con la de B8.

## Cierre de P1 (árbol con A1 + N1 y A2, antes de los commits `6fbad17` y `8206366`)

| Gate | Comando | Resultado |
|---|---|---|
| Lint | `pnpm lint` | sin errores |
| Tipos | `pnpm typecheck` | sin errores (worker, web, shared, raíz) |
| Formato | `pnpm format:check` | "All matched files use Prettier code style!" |
| Pruebas | `pnpm test` | shared 12 archivos / 265 pruebas, 100 % de líneas; web 70 / 646; worker 70 / 1411, 98,37 % de líneas (2485/2526). **2322 pruebas, 0 fallidas** |
| E2E | `pnpm test:e2e` | **36 passed** (2,0 min), Chromium y WebKit `@humo` |

Las pruebas de regresión de A1 (dominio, push, sesiones, estática, B4 determinista) y N1 fallaron con el código anterior: ver el cuerpo de `6fbad17`. La de A2 falló con `Tests 11 failed | 12 passed (23)`: ver `8206366`.

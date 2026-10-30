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

## Gates finales (HEAD `23289d0`)

| Gate | Comando | Resultado |
|---|---|---|
| Lint | `pnpm lint` | exit 0, sin errores |
| Tipos | `pnpm typecheck` | exit 0 (shared, worker con `wrangler types --check`, web con el SW, raíz) |
| Formato | `pnpm format:check` | exit 0, "All matched files use Prettier code style!" |
| Pruebas | `pnpm test` | shared 12 archivos / 265 pruebas, 100 % de líneas (317/317); web 74 / 662; worker 77 / 1438, **98,38 % de líneas** (2500/2541). **2365 pruebas, 0 fallidas** |
| E2E | `pnpm test:e2e` | **36 passed** (2,1 min): Chromium completo y WebKit `@humo` |
| Dependencias | `pnpm audit --prod` | "No known vulnerabilities found" |
| Lighthouse | `pnpm test:lighthouse` | Todas las categorías de todas las URL ≥ 90. Medianas de Performance: 92, 100, 100, 100, 100, 100; Accessibility y Best Practices 100. Resumen en `docs/evidencia/lighthouse/resumen.json` |

Primera corrida de `pnpm test` en esta fase (antes de N3): 1 fallo en `fase2-transversal-errores.test.ts` › "429 DEMASIADOS_INTENTOS: sexto intento de login con la misma IP y correo" (`expected { estado: 401 } to deeply equal { estado: 429 }`), por la ventana del limitador alineada al reloj. Se registró y corrigió como N3 (`947b69f`) y la corrida final de arriba es posterior.

## 20 repeticiones de las pruebas de concurrencia (A1 y B4)

Script de apoyo en el scratchpad de la sesión (`repetir-concurrencia.mjs`): corre 20 veces seguidas, sin cobertura y con un tope de 10 min por corrida, `pnpm exec vitest run` en `apps/worker` sobre:

- `correcciones-a1-dominio.test.ts`, `correcciones-a1-push.test.ts`, `correcciones-a1-sesiones.test.ts` (A1);
- `correcciones-n1-concurrencia-optimista.test.ts` (N1) y `correcciones-n2-marca-users.test.ts` (N2);
- `correcciones-b4-evidencias-concurrencia.test.ts` (B4, con la variante determinista);
- `fase3-push-concurrencia.test.ts`.

Resultado: **20/20 corridas sin fallos**, cada una `Test Files 7 passed (7) | Tests 41 passed (41)`, entre 7,9 y 8,7 s por corrida.

## A11. Procesos en segundo plano

- Ningún comando de espera sin tope: las esperas del orquestador usaron bucles con fin fijo (`fin=$((SECONDS+570))`, por debajo del tope de 10 min de la herramienta) y todos los briefs exigieron `timeout` y nada en segundo plano.
- Ninguna medición se lanzó en segundo plano. El orquestador no lanzó ningún shell en segundo plano en toda la sesión.
- Subagentes: los 7 lanzados (`software-architect`, `react-developer` ×2 encargos, `general-purpose` ×2 encargos, `database-specialist`, `security-reviewer`) terminaron y entregaron su informe; ninguno quedó en curso. Todos confirmaron no dejar procesos vivos.
- Comprobación final con PowerShell (`Get-Process` y `Win32_Process`): ningún `node.exe`, `workerd`, `wrangler`, `vitest` ni `playwright`. Solo quedan procesos `msedge` del perfil normal del usuario (`--no-startup-window`, sin depuración remota), ajenos a la sesión.

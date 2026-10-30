# Evidencia — Fase 3: Sincronización offline

Fecha: 2026-10-29. Ejecutado por el orquestador en Windows 11, Node 24.18.0, pnpm 12.16.1, rama `build/v1`, commit `1a2fbda`.

## Gates

| Comando | Código | Resumen |
|---|---|---|
| `pnpm typecheck` | 0 | 3 paquetes + `e2e/` (worker con `wrangler types --check`; SW de la PWA con su propio tsconfig) |
| `pnpm --filter @catmetal/shared test` | 0 | 209/209, 100 % de líneas |
| `pnpm --filter @catmetal/worker test` | 0 | 1.152/1.152, 97,84 % de líneas (ramas 91,88 %) |
| `pnpm --filter @catmetal/web test` | 0 | 374/374 (tres corridas seguidas estables tras el ajuste `asyncUtilTimeout`) |
| `pnpm lint` / `pnpm format:check` | 0 sobre lo versionado | En el árbol de trabajo fallaban solo `e2e/apoyo/{api,ui}.ts` (tarea 4.4b en curso, sin confirmar) |
| `pnpm audit --prod` | 0 | Sin vulnerabilidades conocidas |
| `pnpm test:e2e` (desde la Fase 4, informativo aquí) | 0 | 18/18 (Chromium 12, WebKit 6) en `573f3c0` |

Dos pruebas inestables detectadas y corregidas en esta fase sin tocar aserciones: el rate limiter frente al cambio de minuto (`2c80de8`, `1a2fbda`) y dos pruebas de la web con rutas `lazy` bajo carga (`f691638`).

## Pruebas de la fase

### Servidor (D1 y R2 reales locales)

| Archivo | Aprobadas |
|---|---|
| `fase3-push.test.ts` | 24/24 |
| `fase3-push-concurrencia.test.ts` | 5/5 |
| `fase3-push-limites.test.ts` | 3/3 |
| `fase3-pull.test.ts` | 14/14 |
| `fase3-snapshot.test.ts` | 7/7 |
| `fase3-revision.test.ts` | 24/24 |
| `fase6-cron-*.test.ts` (adelantada) | 37/37 |

### Cliente (`apps/web/src/{sync,datos,auth}`, fake-indexeddb y servidor falso alineado con el real)

14 archivos, 191 pruebas.

## Criterios de aceptación (§10, Fase 3)

| Criterio | Estado | Prueba |
|---|---|---|
| Una mutación repetida, también en concurrencia, no duplica | Cumplido | `fase3-push.test.ts` (repetida), `fase3-push-concurrencia.test.ts` (carreras reales que cruzan las peticiones), cliente: `sync/*.test.ts` (respuesta perdida) |
| Conflicto de versión | Cumplido | `fase3-push.test.ts` |
| La edición de un consumo ya validado se rechaza | Cumplido | `fase3-push.test.ts` (`CONSUMO_NO_PENDIENTE`, consumo intacto) |
| Registro tardío en una orden finalizada | Cumplido | `fase3-push.test.ts` (`registro_tardio = 1`) |
| Tolerancia superada sin novedad → `requiere_novedad = 1` | Cumplido | `fase3-push.test.ts` |
| Un lote de 25 mutaciones no excede los límites de D1 | Cumplido | `fase3-push-limites.test.ts` (147 llamadas, máximo 32 parámetros por sentencia) |
| El pull avanza el cursor aunque no haya cambios visibles | Cumplido | `fase3-pull.test.ts` (supervisor ajeno a 300 filas) |
| Revocación de visibilidad | Cumplido | `fase3-pull.test.ts` (servidor) y `datos/aplicar-cambios.test.ts`, `sync/revision-fase-3.test.ts` (cliente) |
| Cliente: Dexie, outbox particionado por usuario, motor con candado y subida de evidencias en segundo plano | Cumplido | `datos/outbox.test.ts`, `sync/motor*.test.ts`, `auth/*.test.ts` |
| Revisión del esquema y del protocolo | Cumplido | `docs/auditoria/revision-esquema-fase-3.md`: 3 altos, 5 medios y 7 bajos; altos corregidos (servidor `2bb5ef5`, cliente `f01ae99`), ADR 0016 |

# Evidencia — Fase 2: API de negocio

Fecha: 2026-10-29. Ejecutado por el orquestador en Windows 11, Node 24.18.0, pnpm 12.16.1, rama `build/v1`, commit `2594d7e`.

## Gates

| Comando | Código | Resumen |
|---|---|---|
| `pnpm lint` | 0 | Sin errores |
| `pnpm typecheck` | 0 | 3 paquetes (worker con `wrangler types --check`) |
| `pnpm test` | 0 | 1.428 pruebas aprobadas, 0 fallidas: shared 207, web 213, worker 1.008 |
| `pnpm format:check` | 1 en el árbol de trabajo, **0 sobre los archivos versionados** | Solo fallaban `apps/web/src/sync/{disparadores,motor}.ts`, trabajo en curso de la tarea 3.5 (adelantada) sin confirmar. `prettier --check` sobre `git ls-files`: sin diferencias |
| `pnpm audit --prod` | 0 | "No known vulnerabilities found" |

Cobertura (istanbul, líneas): `apps/worker/src` 98,78 % (ramas 93,17 %), `packages/shared` 100 %. Umbral 80 %.

### Pruebas de la Fase 2 (worker, D1 y R2 reales locales)

| Archivo | Aprobadas |
|---|---|
| `fase2-auditoria.test.ts` | 36/36 |
| `fase2-consumos-edicion.test.ts` | 12/12 |
| `fase2-consumos.test.ts` | 29/29 |
| `fase2-dominio.test.ts` | 13/13 |
| `fase2-evidencias.test.ts` | 15/15 |
| `fase2-materiales.test.ts` | 18/18 |
| `fase2-novedades.test.ts` | 5/5 |
| `fase2-ordenes-asignaciones.test.ts` | 9/9 |
| `fase2-ordenes-estado.test.ts` | 16/16 |
| `fase2-ordenes.test.ts` | 18/18 |
| `fase2-reportes.test.ts` | 13/13 |
| `fase2-seguridad-correcciones.test.ts` | 28/28 |
| `fase2-settings.test.ts` | 14/14 |
| `fase2-transversal-auditoria.test.ts` | 35/35 |
| `fase2-transversal-csrf.test.ts` | 41/41 |
| `fase2-transversal-errores.test.ts` | 89/89 |
| `fase2-transversal-matriz.test.ts` | 231/231 |
| `fase2-transversal-seguridad.test.ts` | 25/25 |
| `fase2-validaciones-unico-jefe.test.ts` | 1/1 |
| `fase2-validaciones.test.ts` | 21/21 |
| **Total Fase 2** | **670/670** (más 338 de las Fases 0–1: 1.008 en el worker) |

## Criterios de aceptación (§10, Fase 2)

| Criterio | Estado | Prueba |
|---|---|---|
| Órdenes, consumos (conversión y costo congelado), novedades, evidencias en R2, validaciones (sin autoaprobación y sin aprobar con `requiere_novedad`), auditoría, reportes y CSV | Cumplido | `fase2-ordenes*.test.ts`, `fase2-consumos*.test.ts`, `fase2-novedades.test.ts`, `fase2-evidencias.test.ts`, `fase2-validaciones*.test.ts`, `fase2-auditoria.test.ts`, `fase2-reportes.test.ts` |
| Toda escritura usa `db.batch()` con su auditoría | Cumplido | `fase2-transversal-auditoria.test.ts` (16 escrituras: filas exactas, `order_id`, `server_at`) |
| Pruebas de integración por endpoint y por permiso | Cumplido | `fase2-transversal-matriz.test.ts` (32 rutas × 5 actores + 11 variantes, contrastado con `app.routes`) |
| Un fallo a mitad del batch no deja datos parciales | Cumplido | `fase2-transversal-auditoria.test.ts` (trigger temporal que aborta la última fila; foto de 14 tablas idéntica), `fase2-dominio.test.ts` |
| Evidencias con un mime falso se rechazan | Cumplido | `fase2-evidencias.test.ts` (PNG declarado como JPEG, texto con `image/jpeg` → 415) |
| El CSV neutraliza fórmulas | Cumplido | `fase2-reportes.test.ts` y `packages/shared/src/reportes.test.ts` (`= + - @`, tab, CR, LF y anchos completos) |
| Revisión de seguridad | Cumplido | `docs/auditoria/seguridad-fase-2.md`: 0 críticos, 0 altos; el medio y los bajos corregidos en `2594d7e` |

## Revisiones y decisiones de la fase

- Seguridad: `docs/auditoria/seguridad-fase-2.md` (estado por hallazgo). ADR 0013 (alcance de la auditoría por rol).
- Preguntas abiertas nuevas: P22 (supervisor desasignado), P23 (separación de funciones novedad/aprobación).
- Tareas adelantadas de otras fases confirmadas durante la Fase 2: 4.1 (componentes base), 3.3 (Dexie + outbox), 3.4 (cliente de auth) y el contrato de `/sync/snapshot`.

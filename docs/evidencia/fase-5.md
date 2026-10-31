# Evidencia — Fase 5: PWA del jefe y del admin

Fecha: 2026-10-29. Ejecutado por el orquestador en Windows 11, Node 24.18.0, pnpm 12.16.1, rama `build/v1`, commit `0d7d9ad`.

Las tareas de esta fase se ejecutaron adelantadas, en paralelo con la Fase 4 (archivos separados): 5.1–5.2 (`e14ed95`), 5.3 (`8dddc03`) y 5.4 (`ad72a97`). Los gates de cierre son los mismos de la Fase 4 (mismo árbol, sin cambios de código posteriores).

## Gates

| Comando | Código | Resumen |
|---|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm format:check` | 0 | Sin errores |
| `pnpm test` | 0 | 1.859 pruebas (shared 209, web 485, worker 1.165); de ellas, 51 de las pantallas de jefe y admin (`src/pages/{jefe,admin}`, `src/features/{validacion,ordenes,admin}`) |
| `pnpm test:e2e` | 0 | 25/25 (Chromium 18, WebKit 7); 4 pruebas de la Fase 5 (`e2e/fase5-*.spec.ts`), estables en dos corridas seguidas |
| `pnpm audit --prod` | 0 | Sin vulnerabilidades conocidas |

## Criterios de aceptación (§10, Fase 5)

| Criterio | Estado | Prueba |
|---|---|---|
| Cola de validación, aprobar y rechazar, órdenes, resumen, línea de tiempo y administración | Cumplido | `apps/web/src/pages/jefe/validacion.test.tsx`, `pages/jefe/ordenes/ordenes.test.tsx`, `pages/admin/admin.test.tsx`, `features/admin/formato.test.ts` |
| E2E: el supervisor registra → el jefe rechaza → el supervisor ve el motivo y corrige → el jefe aprueba; todo visible en la auditoría | Cumplido | `e2e/fase5-flujo-completo.spec.ts` (dos dispositivos; verificado por API con `corrige_a`, y en la auditoría por API y en la línea de tiempo de la UI, en orden) |
| El jefe no puede aprobar un consumo propio ni uno con `requiere_novedad` | Cumplido | `e2e/fase5-restricciones-jefe.spec.ts` (UI deshabilitada con explicación; API 403 `AUTOAPROBACION` y 422 `REQUIERE_NOVEDAD`; aprobación posible tras registrar la novedad); servidor: `apps/worker/test/fase2-validaciones*.test.ts` |
| Administración (crear usuario y asignarlo; el supervisor ve solo su orden) | Cumplido | `e2e/fase5-admin.spec.ts` |

## Limitaciones conocidas

- La cola del jefe no se actualiza sola: se refresca al volver a la pantalla, al decidir o al recargar.
- Las pantallas de administración y la gestión de órdenes requieren conexión (lo indican en pantalla).
- No hay E2E de la decisión del jefe sin conexión (encolada en el outbox); está cubierta por pruebas de componentes (`validacion.test.tsx`) y del motor de sync.

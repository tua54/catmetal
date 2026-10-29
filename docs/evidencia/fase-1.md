# Evidencia — Fase 1: Base de datos y autenticación

Fecha: 2026-10-29. Ejecutado por el orquestador en Windows 11, Node 24.18.0, pnpm 12.16.1, rama `build/v1`, commit `d0419e2`.

## Gates

| Comando | Código | Resumen |
|---|---|---|
| `pnpm lint` | 0 | Sin errores |
| `pnpm typecheck` | 0 | 3 paquetes |
| `pnpm test` | 0 | 466 pruebas aprobadas, 0 fallidas (shared 126, web 4, worker 336) |
| `pnpm format:check` | 0 | Sin diferencias |
| `pnpm db:reset:local` | 0 | Aplica 0000–0004 y siembra 4 usuarios, 10 materiales, 2 órdenes, 3 asignaciones, 10 planeados, 31 filas de auditoría (lo ejecutó el agente de la tarea 1.7) |

Cobertura (istanbul, líneas): `packages/shared` 100 %, `apps/worker/src` 98,24 % (ramas 93,16 %). Umbral 80 %.

### Pruebas del worker por archivo (D1, R2, KV y rate limiter reales locales)

| Archivo | Aprobadas |
|---|---|
| `api.test.ts` | 19/19 |
| `auth-login.test.ts` | 16/16 |
| `auth-middleware.test.ts` | 13/13 |
| `auth-refresh.test.ts` | 13/13 |
| `auth-unidades.test.ts` | 16/16 |
| `bindings.test.ts` | 8/8 |
| `esquema-vs-migraciones.test.ts` | 56/56 |
| `handlers.test.ts` | 6/6 |
| `integridad-esquema.test.ts` | 37/37 |
| `integridad-triggers.test.ts` | 80/80 |
| `permisos-matriz.test.ts` | 36/36 |
| `permisos-sesion.test.ts` | 18/18 |
| `usuarios.test.ts` | 18/18 |
| **Total** | **336/336** |

## Criterios de aceptación (§10, Fase 1)

| Criterio | Estado | Prueba |
|---|---|---|
| UPDATE y DELETE en `audit_log` fallan; DELETE falla en las tablas de negocio | Cumplido | `integridad-triggers.test.ts` (inmutabilidad y `_no_delete` por tabla) |
| Todos los triggers existen después de todas las migraciones | Cumplido (34) | `integridad-esquema.test.ts` (`sqlite_master` contra lista literal) |
| Las foreign keys están activas | Cumplido | `bindings.test.ts`, `integridad-esquema.test.ts` (FK inválida falla) |
| Iteraciones PBKDF2 ≤ 100.000 | Cumplido | `auth-unidades.test.ts` |
| Login y rotación funcionan | Cumplido | `auth-login.test.ts`, `auth-refresh.test.ts` |
| Reutilizar un refresh revoca su familia | Cumplido | `auth-refresh.test.ts` (fuera de la ventana de gracia; concurrencia con `Promise.all`) |
| El bloqueo se activa tras 5 intentos | Cumplido | `auth-login.test.ts` (respuesta idéntica durante el bloqueo) |
| Cada regla de la §3 probada (positiva y negativa) | Cumplido a nivel de permiso de rol | `permisos-matriz.test.ts`, `permisos-sesion.test.ts`. Las restricciones de datos (solo asignadas, nunca uno propio, solo pendiente) se prueban por endpoint en la Fase 2 |
| La auditoría no contiene secretos | Cumplido | Cada archivo `auth-*.test.ts` y `usuarios.test.ts` termina buscando contraseñas, tokens, hashes y secretos en todo `audit_log` |

Además: atomicidad de `db.batch()` con fallo al final, esquema Drizzle igual a las migraciones, prohibición estática de `REPLACE` y de `DROP TABLE` sin `RENAME`, y `EXPLAIN QUERY PLAN` de las consultas calientes usando los índices nuevos.

## Revisiones

- `software-architect`: ADR 0005–0009 (4 hallazgos altos incorporados antes de implementar).
- `database-specialist`: `docs/auditoria/revision-esquema-fase-1.md` (2 altos, 7 medios). Aplicados en la tarea 1.7: H1, H3, H5, H6, H7, H8, H10, H11, H12, H13. H2 y H4 se aplican en las Fases 2–3; H9 y H14 en la Fase 6.

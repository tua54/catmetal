# ADR 0006 — Triggers de inmutabilidad en una migración SQL propia

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 1

## Contexto

D1 no tiene roles ni `GRANT`, así que la inmutabilidad (nada se borra, la auditoría no se modifica, un consumo decidido no cambia) se garantiza con triggers (§4). Drizzle no gestiona triggers: cuando drizzle-kit reconstruye una tabla (crear nueva, copiar, borrar, renombrar), los triggers de esa tabla desaparecen sin aviso.

## Opciones consideradas

1. Escribir los triggers dentro de la migración generada. Se pierden en la siguiente reconstrucción y nadie lo nota.
2. Una migración propia, creada con `drizzle-kit generate --custom --name triggers` (queda registrada en el journal de drizzle-kit y numerada en orden), escrita a mano, **más** una prueba que verifica en `sqlite_master` la lista completa de triggers después de aplicar todas las migraciones.

## Decisión

Opción 2. Triggers (ampliados tras la revisión de `software-architect`):

| Trigger | Efecto |
|---|---|
| `audit_log_no_update`, `audit_log_no_delete` | `RAISE(ABORT, 'audit_log es inmutable')` |
| `audit_log_seq_creciente` (AFTER INSERT) | Protege el cursor: nadie inserta un `seq` menor al máximo |
| `<tabla>_no_delete` en `consumptions`, `incidents`, `validations`, `evidences`, `production_orders`, `users`, `sync_mutations`, `order_supervisors`, `order_planned_materials`, `materials`, `settings`, `devices` | Nada se borra; se usan estados |
| `consumptions_decidido_inmutable` | Un consumo que ya no está `pendiente` no admite ningún UPDATE |
| `consumptions_autoria_inmutable` | `id`, `order_id`, `registrado_por`, `device_id`, `client_created_at`, `server_received_at`, `corrige_a`, `created_at` y `registro_tardio` no cambian nunca |
| `consumptions_version` | Todo UPDATE incrementa `version` exactamente en 1 (también la aprobación, para que una edición offline contra un consumo decidido dé conflicto) |
| `consumptions_estado_con_validacion` | El estado solo cambia si existe la fila de `validations` con esa decisión (se inserta antes en el mismo batch) |
| `consumptions_corrige_rechazado` (BEFORE INSERT) | `corrige_a` solo puede apuntar a un consumo `rechazado` |
| `validations_reglas` (BEFORE INSERT) | Sin autoaprobación, solo sobre consumos pendientes, y no se aprueba con `requiere_novedad = 1` sin novedad |
| `evidences_inmutable` | Solo se permite marcar `subido` 0→1 (y `subido_at`); el resto de columnas no cambia |
| `production_orders_estado_terminal` | Una orden `finalizada` o `cancelada` no cambia de estado (no se reabre, P16) |
| `validations_no_update`, `incidents_no_update`, `sync_mutations_no_update` | Registros inmutables |

Además:

- **Prohibido `REPLACE`, `INSERT OR REPLACE` y `ON CONFLICT REPLACE`**: en SQLite el borrado implícito de REPLACE no dispara los triggers de UPDATE (y los de DELETE solo con `recursive_triggers`), así que se saltaría la inmutabilidad. Una prueba estática falla si aparece en `apps/worker/src`, `migrations` o `scripts`.
- **Toda migración que reconstruya una tabla con triggers debe recrearlos en la misma migración.** La prueba de `sqlite_master` falla si falta alguno.

## Consecuencias

- Los triggers protegen también contra errores del propio código del Worker.
- Para "borrar" se usan estados (`activo = 0`, `cancelada`).
- `evidences` admite solo marcar `subido`; no `DELETE`.
- Las reglas de negocio críticas (autoaprobación, novedad obligatoria) se validan en el Worker **y** en la base (defensa en profundidad).

## Cómo revertir

Crear una migración nueva que haga `DROP TRIGGER` del trigger concreto y actualizar la prueba de `sqlite_master`. No se recomienda.

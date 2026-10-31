# ADR 0010 — Integridad reforzada en la base, `audit_log.order_id` y regla de reconstrucción de tablas

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 1
- Amplía: ADR 0006

## Contexto

La revisión de `database-specialist` (`docs/auditoria/revision-esquema-fase-1.md`) comprobó en un banco con datos sintéticos que:

1. Una validación puede insertarse sin que cambie el estado del consumo, y el jefe puede aprobar una versión que no vio (H1).
2. Varias inserciones directas quedan sin protección: consumos que nacen decididos, validaciones hechas por un no-jefe, evidencias que nacen subidas, transiciones de orden no permitidas (H3), valores de configuración que apagan la regla S7 (H12) y un `seq` explícito enorme que detendría todas las escrituras (H11).
3. La regla "recrear los triggers de la tabla reconstruida" de la ADR 0006 no basta: hay triggers de **otras** tablas que nombran a la tabla reconstruida y hacen fallar el `RENAME` (H5).
4. `audit_log` es inmutable: si no lleva `order_id` desde el principio, la línea de tiempo de una orden y la visibilidad del pull dependerán siempre de subconsultas (H8).

## Opciones consideradas

- Aplicar el estado del consumo desde el Worker (UPDATE tras INSERT de la validación) o **desde la base** con un trigger AFTER INSERT en `validations`.
- CHECK o **triggers** para las inserciones directas (un CHECK también aplica a los UPDATE legítimos y obliga a reconstruir la tabla).
- `audit_log.order_id` ahora o nunca.

## Decisión

1. **Migración `0003`** escrita a mano (`--custom`) con los triggers propuestos por la revisión: `validations_aplica_decision`, `consumptions_validado_no_se_edita`, `consumptions_insercion_valida`, `validations_validador_jefe`, `evidences_insercion_valida`, `production_orders_transicion`, `audit_log_seq_sin_saltos` y `settings_valores_validos`.
2. **La validación aplica la decisión**: al insertar una fila en `validations`, la base pone `estado = decision` y `version = version + 1` en el consumo. El Worker no hace ese UPDATE. Aprobar y rechazar llevan la `version` que vio el jefe; la inserción va condicionada (`INSERT … SELECT … WHERE EXISTS (consumo pendiente con esa versión)`) y, si no aplica, responde 409 `CONFLICTO`. La auditoría del consumo (con `version + 1`) se sigue escribiendo en el mismo batch, condicionada a que la validación exista.
3. **`audit_log.order_id`** (TEXT nullable, sin FK, como `entidad_id`) con índice parcial `(order_id, seq)`. Toda fila de auditoría de una entidad que pertenece a una orden (orden, asignación, plan, consumo, novedad, evidencia, validación) lleva su `order_id`.
4. **Índices** nuevos: `consumptions_pendientes_id` (parcial, cola de validación), `consumptions_order_id_id`, `refresh_tokens_vigentes_usuario` (parcial) y `audit_log_order_id_seq`.
5. **Booleanos en la auditoría** como `true/false` (igual que la API y el seed).
6. **Regla de reconstrucción** (reemplaza la de la ADR 0006): toda migración que reconstruya una tabla T debe (a) usar `PRAGMA defer_foreign_keys = on` (el `PRAGMA foreign_keys=OFF` que emite drizzle-kit no sirve en D1), (b) hacer `DROP TRIGGER` de todo trigger cuya tabla sea T **o cuyo cuerpo mencione T**, (c) crear `__new_T`, copiar, `DROP TABLE T`, renombrar, y (d) recrear todos esos triggers. Se prefiere siempre `ADD COLUMN`. Una prueba estática exige que todo `DROP TABLE` en `migrations/` vaya seguido del `RENAME` correspondiente, y la prueba de `sqlite_master` sigue verificando la lista completa de triggers.

## Consecuencias

- Las reglas críticas viven en la base además del Worker: un error en el código no puede dejar un consumo aprobado sin validación ni una validación sin efecto.
- El Worker debe usar sentencias con guarda (`WHERE` con estado, versión, autor) para que el camino normal dé `changes = 0` y no un error de trigger; los triggers son la última línea de defensa. En `/sync/push` los errores de constraint/trigger se clasifican como `rechazada`/`conflicto`, nunca como transitorios (Fase 3).
- Restaurar desde el backup en R2 requiere aplicar los triggers **después** de importar los datos (Fase 6, `docs/despliegue.md`).

## Cómo revertir

Migración nueva con `DROP TRIGGER` de los triggers de la `0003` y vuelta al UPDATE explícito en el Worker. `audit_log.order_id` no se puede quitar sin reconstruir la tabla (se dejaría sin uso).

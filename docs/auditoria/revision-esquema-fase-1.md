# Revisión del esquema D1 — cierre de la Fase 1

- Revisor: `database-specialist` (solo lectura), 2026-10-29.
- Alcance: `apps/worker/src/db/schema.ts`, `migrations/0000–0002`, `scripts/seed.mjs`, uso en auth/usuarios/auditoría, pruebas de integridad.
- Método: banco desechable con `node:sqlite` (SQLite 3.53) con las migraciones reales, 100k consumos, 300k filas de auditoría y 20k refresh tokens; `EXPLAIN QUERY PLAN`, tiempos y pruebas de triggers. D1 usa una versión de SQLite más antigua: los planes pueden variar algo.
- Línea base: 300 pruebas del worker en verde.

## Hallazgos y estado

| # | Sev. | Hallazgo | Decisión del orquestador | Estado |
|---|---|---|---|---|
| H1 | Alta | La validación y el estado del consumo están desacoplados: una validación puede insertarse sin cambiar el estado, y el jefe puede aprobar una versión que no vio | Trigger `validations_aplica_decision` (AFTER INSERT aplica estado y `version + 1`) y `consumptions_validado_no_se_edita`; aprobar/rechazar llevan la `version` vista y la inserción va condicionada (409 si cambió) | Tarea 1.6 (triggers) y Fase 2 (contrato) |
| H2 | Alta | Un error de constraint o trigger no puede tratarse como transitorio en `/sync/push` (atascaría el outbox) | Sentencias con guarda en el `WHERE`; clasificador de errores (constraint/RAISE → `rechazada`/`conflicto`, solo red/sobrecarga → transitorio); auditoría y `sync_mutations` condicionadas a que la sentencia principal aplicó | Fase 2 (patrón) y Fase 3 (clasificador) |
| H3 | Media | Inserciones directas sin protección: consumo que nace decidido o con `version ≠ 1`, id en mayúsculas, dispositivo de otro usuario, corrección a otra orden, validación por no-jefe, evidencia que nace subida, transiciones de orden no permitidas | Triggers `consumptions_insercion_valida`, `validations_validador_jefe`, `evidences_insercion_valida`, `production_orders_transicion` | Tarea 1.6 |
| H4 | Media | Carrera en la tolerancia y en `registro_tardio` entre pushes concurrentes | INSERT condicionado al acumulado leído y al estado de la orden, con reintento (máx. 3) | Fase 2 |
| H5 | Media | La regla de reconstrucción de la ADR 0006 está incompleta: hay triggers de otras tablas que nombran a la tabla reconstruida; `PRAGMA foreign_keys=OFF` de drizzle-kit no sirve en D1; `DROP TABLE` no dispara `_no_delete` | Regla corregida en la ADR 0010; prueba estática de `DROP TABLE` | Tarea 1.6 |
| H6 | Media | La cola de validación recorre toda la tabla | Índice parcial `consumptions_pendientes_id` | Tarea 1.6 |
| H7 | Media-baja | El middleware recorre la familia completa de refresh tokens | Índice parcial `refresh_tokens_vigentes_usuario` | Tarea 1.6 |
| H8 | Media | Decidir ya si `audit_log` lleva `order_id` (inmutable: no se podría rellenar después) | Se agrega `audit_log.order_id` + índice `(order_id, seq)` | Tarea 1.6 (ADR 0010) |
| H9 | Media | Restaurar desde el backup en R2 choca con los triggers | Procedimiento de restauración en orden (esquema → datos → triggers → época) | Fase 6 |
| H10 | Baja | Paginación: correcta; falta índice para consumos por orden | Índice `consumptions_order_id_id` | Tarea 1.6 |
| H11 | Baja | Un `seq` explícito enorme detiene todas las escrituras | Trigger `audit_log_seq_sin_saltos` | Tarea 1.6 |
| H12 | Baja | `settings` acepta valores que apagan S7 (`tolerancia_pct = "abc"`) | Trigger `settings_valores_validos` | Tarea 1.6 |
| H13 | Baja | Booleanos con formato distinto en la auditoría (seed `true`, Worker `1`) | Normalizar a `true/false` en `auditar.ts` | Tarea 1.6 |
| H14 | Baja | Crecimiento ≈ 1 GB/año (8–10 años hasta 10 GB) | Purga de refresh tokens vencidos hace > 90 días y medir tamaño desde el cron | Fase 6 |
| H15 | Baja | `lote` NOT NULL (¿materiales a granel sin lote?) e iPad en HEIC | Pregunta abierta P20; el cliente recomprime siempre a JPEG/WebP | Preguntas abiertas / Fase 4 |
| H16 | Baja | Índices poco útiles (`consumptions_material_id`, `production_orders_estado`) | Se mantienen (inofensivos; servirán a reportes) | Sin cambio |

Seed: respeta triggers, idempotente, convención de `entidad_id` correcta; solo H13.
Migraciones 0000–0002: orden correcto; problemas futuros cubiertos por H5 y H9.

Fuentes citadas por el revisor: https://developers.cloudflare.com/d1/sql-api/foreign-keys/ , https://developers.cloudflare.com/d1/reference/migrations/ .

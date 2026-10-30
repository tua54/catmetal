# ADR 0014 — Backup diario paginado a R2 y mantenimiento del cron

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 6 (adelantada en paralelo con la Fase 3)

## Contexto

La spec (§2, §4) pide un Cron Trigger diario (`0 8 * * *` UTC) que exporte cada tabla a NDJSON comprimido en R2 (`backups/AAAA-MM-DD/<tabla>.ndjson.gz`) paginando por clave primaria, con `manifest.json` (conteos y sha256), sin la exportación nativa de D1 (bloquea las demás consultas), y retención de 90 días con una regla de ciclo de vida de R2, no con código. La revisión del esquema (H9) fijó el orden de exportación y el procedimiento de restauración; H14 propuso purgar refresh tokens vencidos y medir el tamaño de la base.

Límites: 1000 consultas por invocación (Workers Paid), CPU por invocación, memoria de 128 MB; un Cron Trigger puede ejecutarse hasta 15 min de reloj.

## Opciones consideradas

1. Exportar todo en una invocación, acumulando en memoria. Riesgo de memoria y de límites.
2. **Exportar por tabla y por lotes en streaming** (`CompressionStream('gzip')` hacia `R2.put` con un `ReadableStream` o multipart), con presupuesto de consultas y **reanudación**: si se acerca al límite, guarda el progreso en R2 (`backups/AAAA-MM-DD/progreso.json`) y la siguiente invocación del día continúa.

## Decisión

Opción 2:

- Orden de exportación (hijos antes que padres, H9): `audit_log`, `sync_mutations`, `validations`, `evidences`, `incidents`, `consumptions`, `order_planned_materials`, `order_supervisors`, `refresh_tokens`, `devices`, `settings`, `production_orders`, `materials`, `users`. Como nada se borra, así no quedan FK colgando al restaurar.
- Paginación: `id > ?` (UUID v7), `seq > ?` para `audit_log`, `(order_id, user_id) > (?, ?)` / `(order_id, material_id) > (?, ?)` para las PK compuestas, `clave > ?` para `settings`; lotes de 500 filas.
- Se exportan **todas las columnas**, incluidos `password_hash` y `token_hash` (un backup debe permitir restaurar el servicio). El bucket es privado y la retención de 90 días se aplica con la regla de ciclo de vida (`docs/despliegue.md`).
- `manifest.json` con: fecha, época, `MAX(seq)` al empezar, por tabla el conteo, bytes y sha256 del archivo comprimido, y la versión del esquema (última migración aplicada).
- Idempotente por fecha: si el manifest del día ya existe, no se repite.
- El backup no es una foto de un único instante (D1 no ofrece snapshot de lectura sin bloquear); Time Travel sigue siendo la primera línea de restauración.
- **Mantenimiento** en el mismo cron, después del backup: registrar en un log estructurado el tamaño aproximado de la base (conteos por tabla), y **purgar `refresh_tokens` revocados o vencidos hace más de 90 días**. `refresh_tokens` no es una tabla de negocio (no tiene trigger `_no_delete`); su historia de seguridad queda en `audit_log`. Es el único `DELETE` del sistema y se limita a esa tabla con una condición de fecha.

## Consecuencias

- Restaurar desde R2 sigue el procedimiento de H9 (esquema → datos con `defer_foreign_keys` → triggers → registrar migraciones → cambiar época), documentado en `docs/despliegue.md`.
- El backup contiene datos personales y hashes: acceso al bucket restringido (Ley 1581).

## Cómo revertir

Quitar la llamada al backup o a la purga en el handler `scheduled`; los archivos existentes en R2 expiran por la regla de ciclo de vida.

## Enmienda (2026-10-29, revisión de seguridad final F6-08)

Los backups (que incluyen `password_hash`, `token_hash`, correos y `payload_json`) se escriben en un **bucket R2 propio** (`mp-backups-local/staging/prod`, binding `BACKUPS`), separado de las evidencias (`EVIDENCE`), para que ninguna credencial de las fotos dé acceso a los backups. El prefijo `backups/AAAA-MM-DD/…` y la regla de ciclo de vida de 90 días se mantienen, ahora sobre el bucket de backups. También se enmienda la ADR 0016 (continuaciones del backup) en el mismo sentido.

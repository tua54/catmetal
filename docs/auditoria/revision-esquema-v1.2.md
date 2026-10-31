# Revisión de esquema — A1 (marca de escritura) y N1 · correcciones v1.2

- **Revisor**: `database-specialist`, en modo solo lectura. No modificó archivos ni ejecutó pruebas ni wrangler; git solo para leer.
- **Fecha**: 2026-10-30.
- **Alcance**: commit `6fbad17`, ADR 0028 (decisión y notas de implementación), `docs/correcciones-v1.2.md` §A1 y §N1.
- Informe guardado por el orquestador. El estado de cada hallazgo está al final.

## Veredicto

**Aprobado. No hay hallazgos críticos, altos ni medios.**

- La migración 0009 es puramente aditiva y coherente con Drizzle y con el journal.
- Todas las auditorías condicionales y las dependientes revisadas dependen solo de una marca que nada más la sentencia principal de su batch pudo escribir.
- La regla de orden se cumple en todos los batches con varias escrituras sobre la misma fila (login).
- Los triggers de inmutabilidad están intactos y no hay `DELETE` nuevo.
- Las búsquedas `EXISTS` usan claves indexadas.
- Quedan un hallazgo bajo (N1 en `users`) y varios informativos.

## Hallazgos

| Id | Sev. | Evidencia | Descripción | Recomendación |
|---|---|---|---|---|
| R-v12-01 | bajo | `apps/worker/src/auth/sesiones.ts:227-231`; `scripts/desbloqueo-emergencia-sql.mjs:76` | Dos escrituras de `users` no renuevan `escritura_id`: el `UPDATE users SET intentos_fallidos = 0, updated_at = ?` del login (sin auditar) y el script de desbloqueo de emergencia. En esos caminos el testigo de N1 queda solo en `updated_at`: si un login cae en el mismo milisegundo que el `updated_at` que leyó el admin, el `usuario.editar` del admin se aplica con un `datos_antes.intentos_fallidos` viejo. No se pierde ninguna actualización (el `CASE` solo toca esas columnas con `desbloquear`). | Fijar también una marca nueva en esos dos caminos (`nuevaMarca()` en el login; un valor aleatorio en el script). Nunca `NULL`, que reabriría el ABA contra una lectura `NULL`. |
| R-v12-02 | info | `migrations/0004_integridad_reforzada_triggers.sql:56-62` | `validations_aplica_decision` cambia `consumptions` sin fijar su marca, como ya documentan la ADR y `schema.ts`. Es correcto: aprobar, rechazar y B11 se condicionan a `validations.escritura_id`, y `validations` no admite `UPDATE`. | No usar nunca `consumptions.escritura_id` como testigo de concurrencia; el del consumo sigue siendo `version`. |
| R-v12-03 | info | `migrations/0009_marca_de_escritura.sql:14`; ADR 0028, nota 6 | `order_planned_materials.escritura_id` no la escribe nadie. Es inocua (`NULL`) y está documentada. | Ninguna. |
| R-v12-04 | info | `docs/despliegue.md` §4 | La lista de migraciones se quedaba en 0006. Un Worker v1.2 contra una base sin 0009 fallaría con `no such column`. `deploy-staging.yml` ya aplica las migraciones antes del `deploy`. | Actualizar el texto y dejar escrito que la 0009 se aplica antes de desplegar el Worker v1.2. |
| R-v12-05 | info | `docs/despliegue.md` §9.5 | Las consultas de detección recorren `audit_log` completa (no hay índice por `accion`, y la 3 agrupa por `datos_despues`): en una base grande pueden topar el tiempo máximo de consulta de D1. | Correrlas sobre una copia restaurada en local, o por rangos de `seq`. |
| R-v12-06 | info | `apps/worker/src/cron/backup.ts:577-619` | Entre aplicar la 0009 y desplegar el Worker v1.2, el cron de la v1.1 (`t.*`) exportaría `escritura_id` y su `octet_length` no la contaría (~36 B por fila). La restauración la ignora porque usa `columnas`. | Minimizar esa ventana. |

## Verificaciones por punto

1. **Migración 0009.** Son 11 `ALTER TABLE … ADD COLUMN escritura_id TEXT`, anulables y sin valor por defecto: no reconstruye tablas, no toca triggers y es O(1) en SQLite. `0009_snapshot.json` tiene `prevId` igual al `id` de la 0008 y el journal tiene `idx` 9; las demás diferencias de los snapshots son de orden de claves. Drizzle agrega `marcaDeEscritura()` en las mismas 11 tablas y los tipos `Fila*` omiten la columna.
2. **Marcas.**
   - UUID v7 nuevo por sentencia: evidencias, consumos (crear y editar), novedades, órdenes (crear, iniciar y finalizar), materiales, settings, asignaciones (una marca por cambio), usuarios, rehash, desbloqueo heredado, familias ajenas y `revocarFamilia`.
   - PK generada por el servidor: `porPkNueva` en `emitirSucesor`.
   - `reserva_id` nuevo: reinicios de cupos, tras el login y del admin, uno por tipo.
   - `porAuditoria`: encadena `sentenciaRevocarTodas` y el reinicio de cupos del admin.
   - Ningún id del cliente se usa como marca.
   - Sentencias de varias filas (familia con `familia_id + user_id`, cupos con `user_id + reserva_id`): el `EXISTS` solo es verdadero si este `UPDATE` cambió al menos una fila.
   - Settings: en el Worker no hay upsert, solo un `UPDATE` guardado. El upsert de la restauración corre sobre una base recién migrada.
   - Regla de orden en el login: cupos, rehash y su auditoría, desbloqueo y su auditoría, y el `UPDATE` de `intentos_fallidos` sin marca. Es correcta.
   - Asignaciones: cada cambio toca una fila distinta y cada auditoría usa la marca de su fila.
3. **N1.** `materials` (`updated_at` + marca), `settings` (`valor IS` + marca), `order_supervisors` (`s.escritura_id IS json_extract(…)`, que funciona con `NULL`) y `users`: cerrados. La única ventana residual es R-v12-01. El seed, los crons y la restauración no escriben estas tablas.
4. **Integridad.** Los triggers de `UPDATE` son listas negras de columnas y no bloquean `escritura_id`; `validations` e `incidents` la fijan solo en el `INSERT`. No hay `DELETE` nuevo. Las auditorías incondicionales que quedan son `INSERT … VALUES` (`material.crear`, `usuario.crear`, `sesion.inicio`, `dispositivo.registro`). Ningún `INSERT INTO audit_log` fuera de `auditar.ts`.
5. **Backup y restauración.** `columnasTecnicas` en las 11 tablas; `restauracion-nucleo.mjs` deja la columna en `NULL`; V3 y V4 usan `columnas`. Índices: las búsquedas usan la PK (`id`, `clave` o la compuesta de `order_supervisors`), `refresh_tokens_familia_id`, el prefijo `user_id` de `login_cupos_pk` y `audit_log_id_unico`. Ninguna recorre una tabla completa.
6. **Inyección SQL.** Los identificadores de `porMarca` se validan con `/^[a-z_][a-z0-9_]*$/` y la tabla contra una lista blanca. Todos los valores van enlazados.

## Verificado frente a supuestos

- Verificado leyendo el código y git, con las citas de archivo y línea.
- No verificado por el revisor: las cifras de los gates (salen del commit; el orquestador las ejecutó, ver `docs/evidencia/correcciones-v1.2.md`); la atomicidad y la serialización de `db.batch()` en la D1 remota, y que la D1 remota acepte la 0009 igual que miniflare (pendientes en staging, `docs/pendientes-humanos.md`).

## Estado de los hallazgos (orquestador)

| Id | Estado |
|---|---|
| R-v12-01 | Registrado como N2 en `docs/correcciones-v1.2.md` y corregido (ver su estado allí). |
| R-v12-02 | Sin acción: correcto y documentado. |
| R-v12-03 | Sin acción: documentado en la ADR 0028. |
| R-v12-04 | Corregido en `docs/despliegue.md` §4. |
| R-v12-05 | Corregido: nota en `docs/despliegue.md` §9.5. |
| R-v12-06 | Anotado en `docs/despliegue.md` §4 (aplicar la 0009 y desplegar seguidos). |

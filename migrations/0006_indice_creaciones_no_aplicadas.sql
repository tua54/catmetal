-- Índice por expresión para /sync/push (revisión docs/auditoria/revision-esquema-fase-3.md, B1).
-- Migración escrita a mano (`drizzle-kit generate --custom`): drizzle-kit 0.31 no sabe generar un
-- índice por expresión (parte `json_extract(...)` en columnas entre comillas), así que este índice no
-- está en apps/worker/src/db/schema.ts y la prueba esquema-vs-migraciones lo excluye.
--
-- Lo usa `creacionRechazadaGuardada` (apps/worker/src/sync/push.ts): "¿la creación de este consumo
-- quedó rechazada para este usuario?". La expresión `json_extract(payload_json, '$.payload.id')` y el
-- WHERE parcial deben coincidir LITERALMENTE con los de esa consulta para que SQLite lo use; la
-- prueba de integridad-esquema lo comprueba con EXPLAIN QUERY PLAN.
-- Solo CREATE INDEX: no reconstruye ninguna tabla.
CREATE INDEX `sync_mutations_no_aplicadas_consumo` ON `sync_mutations` (
  `user_id`,
  json_extract(payload_json, '$.payload.id')
) WHERE tipo = 'consumo.crear' AND resultado <> 'aplicada';

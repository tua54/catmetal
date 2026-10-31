-- Configuración inicial del sistema (no son datos de prueba). Migración escrita a mano con
-- `drizzle-kit generate --custom --name settings_iniciales`.
--
-- - `tolerancia_pct` = 5 (S7, `TOLERANCIA_PCT_DEFECTO` de @catmetal/shared; una prueba lo compara).
-- - `sync_epoca` (ADR 0009): UUID aleatorio generado al aplicar la migración, así cada base nueva
--   (local, staging, producción o una recreada desde cero) arranca con su propia época. El
--   procedimiento de restauración de docs/despliegue.md la cambia después de restaurar.
-- - Cada fila lleva su auditoría (`accion = 'seed'`, `actor_id` NULL: la escribe el sistema), porque
--   /sync/pull recorre audit_log (ADR 0005, invariante 8). Los ids de auditoría son fijos.
-- - Fechas con el formato de `toISOString()` (24 caracteres): strftime con %f da segundos.milisegundos.
INSERT INTO settings (clave, valor, actualizado_por, created_at, updated_at)
VALUES (
  'tolerancia_pct',
  '5',
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
--> statement-breakpoint
INSERT INTO settings (clave, valor, actualizado_por, created_at, updated_at)
SELECT
  'sync_epoca',
  json_quote(
    lower(
      hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
      || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2)
      || '-' || hex(randomblob(6))
    )
  ),
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
--> statement-breakpoint
INSERT INTO audit_log (
  id, entidad, entidad_id, accion, actor_id, device_id, datos_antes, datos_despues,
  client_at, server_at, alerta_reloj, created_at, updated_at
)
SELECT
  '019a3000-0000-7000-8000-000000000001', 'settings', clave, 'seed', NULL, NULL, NULL,
  json_object('clave', clave, 'valor', json(valor)),
  NULL, created_at, 0, created_at, created_at
FROM settings
WHERE clave = 'tolerancia_pct';
--> statement-breakpoint
INSERT INTO audit_log (
  id, entidad, entidad_id, accion, actor_id, device_id, datos_antes, datos_despues,
  client_at, server_at, alerta_reloj, created_at, updated_at
)
SELECT
  '019a3000-0000-7000-8000-000000000002', 'settings', clave, 'seed', NULL, NULL, NULL,
  json_object('clave', clave, 'valor', json(valor)),
  NULL, created_at, 0, created_at, created_at
FROM settings
WHERE clave = 'sync_epoca';

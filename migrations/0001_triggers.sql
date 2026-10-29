-- Triggers de inmutabilidad (ADR 0006). Migración escrita a mano: drizzle-kit NO gestiona triggers.
--
-- Reglas:
-- - Si una migración futura reconstruye una tabla de esta lista (crear nueva, copiar, borrar,
--   renombrar), debe recrear sus triggers en la MISMA migración. La prueba
--   apps/worker/test/integridad-esquema.test.ts compara sqlite_master con la lista completa.
-- - Prohibido el reemplazo implícito de SQLite (la variante "OR ..." del INSERT y la resolución de
--   conflictos que borra la fila): ese borrado no dispara los triggers de UPDATE y se saltaría la
--   inmutabilidad (ADR 0006).
-- - Cada trigger termina en "END;" y va separado por el marcador de drizzle-kit. wrangler y
--   readD1Migrations dividen las sentencias con la lógica de sqlite3_complete, que entiende
--   los bloques BEGIN ... END de los triggers.

-- ---------------------------------------------------------------------------------------------
-- audit_log: inmutable y con seq creciente (cursor de sync, ADR 0005)
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log es inmutable');
END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log es inmutable');
END;
--> statement-breakpoint
-- AUTOINCREMENT nunca reutiliza un seq, pero un INSERT con seq explícito menor al máximo sí entraría
-- y rompería el cursor de /sync/pull (un cliente que ya pasó ese seq nunca vería la fila).
CREATE TRIGGER audit_log_seq_creciente
AFTER INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log AS posterior WHERE posterior.seq > NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'audit_log.seq debe ser creciente');
END;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Nada se borra: se usan estados (activo = 0, cancelada, ...)
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER consumptions_no_delete
BEFORE DELETE ON consumptions
BEGIN
  SELECT RAISE(ABORT, 'consumptions no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER incidents_no_delete
BEFORE DELETE ON incidents
BEGIN
  SELECT RAISE(ABORT, 'incidents no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER validations_no_delete
BEFORE DELETE ON validations
BEGIN
  SELECT RAISE(ABORT, 'validations no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER evidences_no_delete
BEFORE DELETE ON evidences
BEGIN
  SELECT RAISE(ABORT, 'evidences no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER production_orders_no_delete
BEFORE DELETE ON production_orders
BEGIN
  SELECT RAISE(ABORT, 'production_orders no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER users_no_delete
BEFORE DELETE ON users
BEGIN
  SELECT RAISE(ABORT, 'users no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER sync_mutations_no_delete
BEFORE DELETE ON sync_mutations
BEGIN
  SELECT RAISE(ABORT, 'sync_mutations no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER order_supervisors_no_delete
BEFORE DELETE ON order_supervisors
BEGIN
  SELECT RAISE(ABORT, 'order_supervisors no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER order_planned_materials_no_delete
BEFORE DELETE ON order_planned_materials
BEGIN
  SELECT RAISE(ABORT, 'order_planned_materials no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER materials_no_delete
BEFORE DELETE ON materials
BEGIN
  SELECT RAISE(ABORT, 'materials no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER settings_no_delete
BEFORE DELETE ON settings
BEGIN
  SELECT RAISE(ABORT, 'settings no admite DELETE: se usan estados');
END;
--> statement-breakpoint
CREATE TRIGGER devices_no_delete
BEFORE DELETE ON devices
BEGIN
  SELECT RAISE(ABORT, 'devices no admite DELETE: se usan estados');
END;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- consumptions
-- ---------------------------------------------------------------------------------------------
-- Un consumo aprobado o rechazado no admite ningún UPDATE (S3, S10).
CREATE TRIGGER consumptions_decidido_inmutable
BEFORE UPDATE ON consumptions
WHEN OLD.estado <> 'pendiente'
BEGIN
  SELECT RAISE(ABORT, 'un consumo aprobado o rechazado es inmutable');
END;
--> statement-breakpoint
-- Trazabilidad: quién, desde qué dispositivo, cuándo y en qué orden; nunca cambia.
CREATE TRIGGER consumptions_autoria_inmutable
BEFORE UPDATE ON consumptions
WHEN NEW.id IS NOT OLD.id
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.registrado_por IS NOT OLD.registrado_por
  OR NEW.device_id IS NOT OLD.device_id
  OR NEW.client_created_at IS NOT OLD.client_created_at
  OR NEW.server_received_at IS NOT OLD.server_received_at
  OR NEW.corrige_a IS NOT OLD.corrige_a
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.registro_tardio IS NOT OLD.registro_tardio
BEGIN
  SELECT RAISE(ABORT, 'la autoría de un consumo es inmutable');
END;
--> statement-breakpoint
-- Concurrencia optimista: todo UPDATE (también la aprobación) incrementa version exactamente en 1.
CREATE TRIGGER consumptions_version
BEFORE UPDATE ON consumptions
WHEN NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'todo cambio de un consumo debe incrementar version en 1');
END;
--> statement-breakpoint
-- El estado solo cambia si ya existe la validación con esa decisión (insertada antes, en el mismo batch).
CREATE TRIGGER consumptions_estado_con_validacion
BEFORE UPDATE ON consumptions
WHEN NEW.estado IS NOT OLD.estado
  AND NOT EXISTS (
    SELECT 1 FROM validations AS v
    WHERE v.consumption_id = NEW.id AND v.decision = NEW.estado
  )
BEGIN
  SELECT RAISE(ABORT, 'el estado de un consumo solo cambia con su validación');
END;
--> statement-breakpoint
-- S3 y P2: un consumo corregido solo puede apuntar a un consumo rechazado.
CREATE TRIGGER consumptions_corrige_rechazado
BEFORE INSERT ON consumptions
WHEN NEW.corrige_a IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM consumptions AS original
    WHERE original.id = NEW.corrige_a AND original.estado = 'rechazado'
  )
BEGIN
  SELECT RAISE(ABORT, 'corrige_a solo puede apuntar a un consumo rechazado');
END;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- validations, incidents, evidences, production_orders, sync_mutations
-- ---------------------------------------------------------------------------------------------
-- Defensa en profundidad de S7 y S9 (el Worker valida lo mismo antes de escribir).
CREATE TRIGGER validations_reglas
BEFORE INSERT ON validations
BEGIN
  SELECT RAISE(ABORT, 'nadie valida un consumo que registró')
  WHERE (SELECT c.registrado_por FROM consumptions AS c WHERE c.id = NEW.consumption_id)
    = NEW.validado_por;
  SELECT RAISE(ABORT, 'solo se validan consumos pendientes')
  WHERE (SELECT c.estado FROM consumptions AS c WHERE c.id = NEW.consumption_id) <> 'pendiente';
  SELECT RAISE(ABORT, 'no se aprueba un consumo que requiere novedad sin una novedad registrada')
  WHERE NEW.decision = 'aprobado'
    AND (SELECT c.requiere_novedad FROM consumptions AS c WHERE c.id = NEW.consumption_id) = 1
    AND NOT EXISTS (SELECT 1 FROM incidents AS i WHERE i.consumption_id = NEW.consumption_id);
END;
--> statement-breakpoint
CREATE TRIGGER validations_no_update
BEFORE UPDATE ON validations
BEGIN
  SELECT RAISE(ABORT, 'validations es inmutable');
END;
--> statement-breakpoint
CREATE TRIGGER incidents_no_update
BEFORE UPDATE ON incidents
BEGIN
  SELECT RAISE(ABORT, 'incidents es inmutable');
END;
--> statement-breakpoint
-- Una evidencia solo admite pasar de subido = 0 a subido = 1 (con subido_at y updated_at).
CREATE TRIGGER evidences_inmutable
BEFORE UPDATE ON evidences
WHEN OLD.subido <> 0
  OR NEW.subido <> 1
  OR NEW.id IS NOT OLD.id
  OR NEW.incident_id IS NOT OLD.incident_id
  OR NEW.storage_key IS NOT OLD.storage_key
  OR NEW.mime IS NOT OLD.mime
  OR NEW.tamano_bytes IS NOT OLD.tamano_bytes
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'una evidencia solo admite marcarse como subida');
END;
--> statement-breakpoint
-- P16: una orden finalizada o cancelada no se reabre.
CREATE TRIGGER production_orders_estado_terminal
BEFORE UPDATE ON production_orders
WHEN OLD.estado IN ('finalizada', 'cancelada') AND NEW.estado IS NOT OLD.estado
BEGIN
  SELECT RAISE(ABORT, 'una orden finalizada o cancelada no cambia de estado');
END;
--> statement-breakpoint
CREATE TRIGGER sync_mutations_no_update
BEFORE UPDATE ON sync_mutations
BEGIN
  SELECT RAISE(ABORT, 'sync_mutations es inmutable');
END;

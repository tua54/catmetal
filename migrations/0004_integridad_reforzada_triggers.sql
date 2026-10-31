-- Integridad reforzada (ADR 0010, revisión docs/auditoria/revision-esquema-fase-1.md H1, H3, H11, H12).
-- Migración escrita a mano (`drizzle-kit generate --custom`): drizzle-kit NO gestiona triggers.
-- Los índices y `audit_log.order_id` están en 0003 (generada por drizzle-kit con ADD COLUMN, sin
-- reconstruir la tabla).
--
-- Regla de reconstrucción (ADR 0010, reemplaza la de la ADR 0006): una migración que reconstruya
-- una tabla T debe usar `PRAGMA defer_foreign_keys = on`, hacer DROP TRIGGER de todo trigger de T
-- o cuyo cuerpo mencione T, crear __new_T, copiar, DROP TABLE T, renombrar y recrear los triggers.
-- La prueba apps/worker/test/integridad-esquema.test.ts verifica la lista completa de triggers.

-- ---------------------------------------------------------------------------------------------
-- consumptions
-- ---------------------------------------------------------------------------------------------
-- H3: inserción directa válida. Nace pendiente y con version 1, id UUID en minúsculas, el
-- dispositivo es de quien registra y una corrección apunta a un consumo de la misma orden.
CREATE TRIGGER consumptions_insercion_valida
BEFORE INSERT ON consumptions
BEGIN
  SELECT RAISE(ABORT, 'un consumo nuevo nace pendiente y con version 1')
  WHERE NEW.estado IS NOT 'pendiente' OR NEW.version IS NOT 1;
  SELECT RAISE(ABORT, 'id de consumo no es un UUID en minúsculas')
  WHERE length(NEW.id) <> 36 OR NEW.id GLOB '*[^0-9a-f-]*';
  SELECT RAISE(ABORT, 'el dispositivo no pertenece a quien registra')
  WHERE (SELECT d.user_id FROM devices AS d WHERE d.id = NEW.device_id) IS NOT NEW.registrado_por;
  SELECT RAISE(ABORT, 'corrige_a debe ser un consumo de la misma orden')
  WHERE NEW.corrige_a IS NOT NULL
    AND (SELECT o.order_id FROM consumptions AS o WHERE o.id = NEW.corrige_a) IS NOT NEW.order_id;
END;
--> statement-breakpoint
-- H1: un consumo que ya tiene validación no vuelve a editarse (ni siquiera "como pendiente").
CREATE TRIGGER consumptions_validado_no_se_edita
BEFORE UPDATE ON consumptions
WHEN NEW.estado = 'pendiente'
  AND EXISTS (SELECT 1 FROM validations AS v WHERE v.consumption_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'un consumo con validación no se edita');
END;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- validations
-- ---------------------------------------------------------------------------------------------
-- H3: solo un jefe activo valida (el admin no valida, P1).
CREATE TRIGGER validations_validador_jefe
BEFORE INSERT ON validations
WHEN NOT EXISTS (
  SELECT 1 FROM users AS u WHERE u.id = NEW.validado_por AND u.rol = 'jefe' AND u.activo = 1
)
BEGIN
  SELECT RAISE(ABORT, 'solo un jefe activo valida consumos');
END;
--> statement-breakpoint
-- H1: la validación aplica la decisión. El Worker NO hace el UPDATE del estado. El UPDATE pasa por
-- los triggers de consumptions: versión + 1 (consumptions_version), validación existente con esa
-- decisión (consumptions_estado_con_validacion), estado previo pendiente (garantizado por
-- validations_reglas) y autoría intacta. updated_at = server_received_at cumple el CHECK de fecha.
CREATE TRIGGER validations_aplica_decision
AFTER INSERT ON validations
BEGIN
  UPDATE consumptions
  SET estado = NEW.decision, version = version + 1, updated_at = NEW.server_received_at
  WHERE id = NEW.consumption_id;
END;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- evidences y production_orders
-- ---------------------------------------------------------------------------------------------
-- H3: una evidencia nace sin subir (solo PUT /evidences/:id la marca, tras escribir en R2).
CREATE TRIGGER evidences_insercion_valida
BEFORE INSERT ON evidences
WHEN NEW.subido IS NOT 0 OR NEW.subido_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'una evidencia nace sin subir');
END;
--> statement-breakpoint
-- H3: transiciones permitidas: planeada → en_proceso | cancelada; en_proceso → finalizada | cancelada.
CREATE TRIGGER production_orders_transicion
BEFORE UPDATE ON production_orders
WHEN NEW.estado IS NOT OLD.estado
  AND NOT (
    (OLD.estado = 'planeada' AND NEW.estado IN ('en_proceso', 'cancelada'))
    OR (OLD.estado = 'en_proceso' AND NEW.estado IN ('finalizada', 'cancelada'))
  )
BEGIN
  SELECT RAISE(ABORT, 'transición de estado de orden no permitida');
END;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- audit_log y settings
-- ---------------------------------------------------------------------------------------------
-- H11: un seq explícito con salto (por ejemplo el máximo entero) detendría todas las escrituras.
CREATE TRIGGER audit_log_seq_sin_saltos
AFTER INSERT ON audit_log
WHEN NEW.seq > 1 + COALESCE((SELECT max(a.seq) FROM audit_log AS a WHERE a.seq < NEW.seq), 0)
BEGIN
  SELECT RAISE(ABORT, 'audit_log.seq no admite saltos');
END;
--> statement-breakpoint
-- H12: valores de configuración que apagarían S7 o la época de sync (ADR 0009).
CREATE TRIGGER settings_valores_validos
BEFORE UPDATE ON settings
WHEN NEW.clave IS NOT OLD.clave
  OR (NEW.clave = 'tolerancia_pct'
      AND (json_type(NEW.valor) NOT IN ('integer', 'real') OR CAST(NEW.valor AS REAL) < 0))
  OR (NEW.clave = 'sync_epoca' AND json_type(NEW.valor) IS NOT 'text')
BEGIN
  SELECT RAISE(ABORT, 'valor de configuración no válido');
END;

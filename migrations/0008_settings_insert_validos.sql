-- B7 (docs/correcciones-v1.1.md): valores válidos de `settings` también en INSERT.
-- Migración escrita a mano (`drizzle-kit generate --custom`): drizzle-kit NO gestiona triggers.
-- No reconstruye ninguna tabla.
--
-- `settings_valores_validos` (0004, H12) solo protegía los UPDATE: un INSERT, o el INSERT de un
-- upsert como el de la restauración (ADR 0021), aceptaba claves desconocidas o una tolerancia
-- fuera de rango. Esta migración:
-- - agrega `settings_insercion_valida` (BEFORE INSERT): solo las claves conocidas
--   (`tolerancia_pct` y `sync_epoca`), `tolerancia_pct` numérica entre 0 y 100, y `sync_epoca`
--   como texto JSON;
-- - recrea `settings_valores_validos` con el mismo criterio y el tope de 100, que coincide con
--   `toleranciaSchema` de packages/shared. Solo endurece: todo lo que antes se rechazaba se sigue
--   rechazando.

DROP TRIGGER settings_valores_validos;
--> statement-breakpoint
CREATE TRIGGER settings_valores_validos
BEFORE UPDATE ON settings
WHEN NEW.clave IS NOT OLD.clave
  OR (NEW.clave = 'tolerancia_pct'
      AND (json_type(NEW.valor) NOT IN ('integer', 'real')
           OR CAST(NEW.valor AS REAL) < 0
           OR CAST(NEW.valor AS REAL) > 100))
  OR (NEW.clave = 'sync_epoca' AND json_type(NEW.valor) IS NOT 'text')
BEGIN
  SELECT RAISE(ABORT, 'valor de configuración no válido');
END;
--> statement-breakpoint
CREATE TRIGGER settings_insercion_valida
BEFORE INSERT ON settings
WHEN NEW.clave NOT IN ('tolerancia_pct', 'sync_epoca')
  OR (NEW.clave = 'tolerancia_pct'
      AND (json_type(NEW.valor) NOT IN ('integer', 'real')
           OR CAST(NEW.valor AS REAL) < 0
           OR CAST(NEW.valor AS REAL) > 100))
  OR (NEW.clave = 'sync_epoca' AND json_type(NEW.valor) IS NOT 'text')
BEGIN
  SELECT RAISE(ABORT, 'valor de configuración no válido');
END;

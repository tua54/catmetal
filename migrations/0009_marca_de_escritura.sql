-- A1 (docs/correcciones-v1.2.md, ADR 0028): marca de escritura `escritura_id` en las tablas con
-- escrituras auditadas condicionales. La sentencia principal de cada escritura la fija con un
-- UUID v7 nuevo, y su auditoría y sus dependientes en el mismo batch la comprueban: solo el batch
-- que la escribió la encuentra (nunca una coincidencia de hora o de valores).
-- Escrita a mano a partir de `drizzle-kit generate --name marca_de_escritura` (que dejó el snapshot
-- y el journal): solo `ALTER TABLE … ADD COLUMN`, anulable y sin valor por defecto. No reconstruye
-- ninguna tabla ni toca triggers (precedente: 0003). Las filas existentes quedan en NULL; ninguna
-- condición compara con NULL. Sin `devices` (su escritura auditada es incondicional) ni
-- `login_cupos` (ya tiene `reserva_id`, ADR 0018).
ALTER TABLE consumptions ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE evidences ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE incidents ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE materials ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE order_planned_materials ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE order_supervisors ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE production_orders ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE refresh_tokens ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE settings ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE users ADD COLUMN escritura_id TEXT;--> statement-breakpoint
ALTER TABLE validations ADD COLUMN escritura_id TEXT;

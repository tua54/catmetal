-- M1 (ADR 0018): cupos de login por (cuenta, origen). Generada con `drizzle-kit generate --name login_cupos`.
-- Tabla técnica nueva (sin trigger de inmutabilidad, como refresh_tokens): no reconstruye ni toca
-- ninguna tabla existente, así que se aplica sin efecto sobre los datos de una base en uso.
CREATE TABLE `login_cupos` (
	`user_id` text NOT NULL,
	`origen` text NOT NULL,
	`fallos` integer NOT NULL,
	`ventana_inicio` text NOT NULL,
	`bloqueado_hasta` text,
	`reserva_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `origen`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "login_cupos_fallos_no_negativos" CHECK(fallos >= 0),
	CONSTRAINT "login_cupos_origen_valido" CHECK(origen = 'g' OR (origen GLOB 'd:?*' AND length(origen) <= 64) OR (origen GLOB 'ip:?*' AND length(origen) <= 64)),
	CONSTRAINT "login_cupos_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (length(ventana_inicio) = 24 AND ventana_inicio GLOB '????-??-??T??:??:??.???Z') AND (bloqueado_hasta IS NULL OR (length(bloqueado_hasta) = 24 AND bloqueado_hasta GLOB '????-??-??T??:??:??.???Z')))
);
--> statement-breakpoint
CREATE INDEX `login_cupos_updated_at` ON `login_cupos` (`updated_at`);
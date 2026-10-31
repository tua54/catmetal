CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`entidad` text NOT NULL,
	`entidad_id` text NOT NULL,
	`accion` text NOT NULL,
	`actor_id` text,
	`device_id` text,
	`datos_antes` text,
	`datos_despues` text,
	`client_at` text,
	`server_at` text NOT NULL,
	`alerta_reloj` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_log_datos_antes_json" CHECK(datos_antes IS NULL OR json_valid(datos_antes)),
	CONSTRAINT "audit_log_datos_despues_json" CHECK(datos_despues IS NULL OR json_valid(datos_despues)),
	CONSTRAINT "audit_log_alerta_reloj_booleano" CHECK(alerta_reloj IN (0, 1)),
	CONSTRAINT "audit_log_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (length(server_at) = 24 AND server_at GLOB '????-??-??T??:??:??.???Z') AND (client_at IS NULL OR (length(client_at) = 24 AND client_at GLOB '????-??-??T??:??:??.???Z')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_id_unico` ON `audit_log` (`id`);--> statement-breakpoint
CREATE INDEX `audit_log_entidad_entidad_id` ON `audit_log` (`entidad`,`entidad_id`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_id_seq` ON `audit_log` (`actor_id`,`seq`);--> statement-breakpoint
CREATE TABLE `consumptions` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`material_id` text NOT NULL,
	`cantidad` real NOT NULL,
	`unidad` text NOT NULL,
	`cantidad_en_unidad_plan` real NOT NULL,
	`lote` text NOT NULL,
	`costo_unitario_cop_snapshot` integer NOT NULL,
	`registrado_por` text NOT NULL,
	`device_id` text NOT NULL,
	`client_created_at` text NOT NULL,
	`server_received_at` text NOT NULL,
	`estado` text DEFAULT 'pendiente' NOT NULL,
	`corrige_a` text,
	`registro_tardio` integer DEFAULT false NOT NULL,
	`requiere_novedad` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `production_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`registrado_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`corrige_a`) REFERENCES `consumptions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "consumptions_cantidad_positiva" CHECK(cantidad > 0),
	CONSTRAINT "consumptions_cantidad_plan_positiva" CHECK(cantidad_en_unidad_plan > 0),
	CONSTRAINT "consumptions_costo_no_negativo" CHECK(costo_unitario_cop_snapshot >= 0),
	CONSTRAINT "consumptions_unidad_valida" CHECK(unidad IN ('kg', 'g', 'l', 'ml', 'und', 'm')),
	CONSTRAINT "consumptions_estado_valido" CHECK(estado IN ('pendiente', 'aprobado', 'rechazado')),
	CONSTRAINT "consumptions_no_se_corrige_a_si_mismo" CHECK(corrige_a IS NULL OR corrige_a <> id),
	CONSTRAINT "consumptions_registro_tardio_booleano" CHECK(registro_tardio IN (0, 1)),
	CONSTRAINT "consumptions_requiere_novedad_booleano" CHECK(requiere_novedad IN (0, 1)),
	CONSTRAINT "consumptions_version_positiva" CHECK(version >= 1),
	CONSTRAINT "consumptions_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (length(client_created_at) = 24 AND client_created_at GLOB '????-??-??T??:??:??.???Z') AND (length(server_received_at) = 24 AND server_received_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE INDEX `consumptions_order_id_estado` ON `consumptions` (`order_id`,`estado`);--> statement-breakpoint
CREATE INDEX `consumptions_registrado_por_created_at` ON `consumptions` (`registrado_por`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `consumptions_corrige_a_unico` ON `consumptions` (`corrige_a`) WHERE corrige_a IS NOT NULL;--> statement-breakpoint
CREATE INDEX `consumptions_material_id` ON `consumptions` (`material_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`instalacion_id` text,
	`nombre` text,
	`user_agent` text,
	`ultimo_sync_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "devices_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (ultimo_sync_at IS NULL OR (length(ultimo_sync_at) = 24 AND ultimo_sync_at GLOB '????-??-??T??:??:??.???Z')))
);
--> statement-breakpoint
CREATE INDEX `devices_user_id` ON `devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `evidences` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`mime` text NOT NULL,
	`tamano_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`subido` integer DEFAULT false NOT NULL,
	`subido_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "evidences_mime_valido" CHECK(mime IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "evidences_tamano_valido" CHECK(tamano_bytes > 0 AND tamano_bytes <= 5242880),
	CONSTRAINT "evidences_sha256_hex" CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "evidences_subido_booleano" CHECK(subido IN (0, 1)),
	CONSTRAINT "evidences_subido_coherente" CHECK((subido = 0 AND subido_at IS NULL) OR (subido = 1 AND subido_at IS NOT NULL)),
	CONSTRAINT "evidences_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (subido_at IS NULL OR (length(subido_at) = 24 AND subido_at GLOB '????-??-??T??:??:??.???Z')))
);
--> statement-breakpoint
CREATE INDEX `evidences_incident_id` ON `evidences` (`incident_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `evidences_storage_key_unico` ON `evidences` (`storage_key`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`consumption_id` text NOT NULL,
	`tipo` text NOT NULL,
	`descripcion` text NOT NULL,
	`registrado_por` text NOT NULL,
	`client_created_at` text NOT NULL,
	`server_received_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`consumption_id`) REFERENCES `consumptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`registrado_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "incidents_tipo_valido" CHECK(tipo IN ('reproceso', 'merma', 'dano', 'error_registro', 'otro')),
	CONSTRAINT "incidents_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (length(client_created_at) = 24 AND client_created_at GLOB '????-??-??T??:??:??.???Z') AND (length(server_received_at) = 24 AND server_received_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE INDEX `incidents_consumption_id` ON `incidents` (`consumption_id`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`codigo` text NOT NULL,
	`nombre` text NOT NULL,
	`unidad` text NOT NULL,
	`costo_unitario_cop` integer NOT NULL,
	`activo` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "materials_unidad_valida" CHECK(unidad IN ('kg', 'g', 'l', 'ml', 'und', 'm')),
	CONSTRAINT "materials_costo_no_negativo" CHECK(costo_unitario_cop >= 0),
	CONSTRAINT "materials_activo_booleano" CHECK(activo IN (0, 1)),
	CONSTRAINT "materials_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_codigo_unico` ON `materials` (`codigo`);--> statement-breakpoint
CREATE TABLE `order_planned_materials` (
	`order_id` text NOT NULL,
	`material_id` text NOT NULL,
	`cantidad_planeada` real NOT NULL,
	`unidad` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`order_id`, `material_id`),
	FOREIGN KEY (`order_id`) REFERENCES `production_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_planned_materials_cantidad_positiva" CHECK(cantidad_planeada > 0),
	CONSTRAINT "order_planned_materials_unidad_valida" CHECK(unidad IN ('kg', 'g', 'l', 'ml', 'und', 'm')),
	CONSTRAINT "order_planned_materials_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE INDEX `order_planned_materials_material_id` ON `order_planned_materials` (`material_id`);--> statement-breakpoint
CREATE TABLE `order_supervisors` (
	`order_id` text NOT NULL,
	`user_id` text NOT NULL,
	`asignado_por` text NOT NULL,
	`activo` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`order_id`, `user_id`),
	FOREIGN KEY (`order_id`) REFERENCES `production_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asignado_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_supervisors_activo_booleano" CHECK(activo IN (0, 1)),
	CONSTRAINT "order_supervisors_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE INDEX `order_supervisors_user_id` ON `order_supervisors` (`user_id`);--> statement-breakpoint
CREATE TABLE `production_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`codigo` text NOT NULL,
	`linea` text NOT NULL,
	`estado` text DEFAULT 'planeada' NOT NULL,
	`fecha_inicio` text,
	`fecha_fin` text,
	`creada_por` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`creada_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "production_orders_estado_valido" CHECK(estado IN ('planeada', 'en_proceso', 'finalizada', 'cancelada')),
	CONSTRAINT "production_orders_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (fecha_inicio IS NULL OR (length(fecha_inicio) = 24 AND fecha_inicio GLOB '????-??-??T??:??:??.???Z')) AND (fecha_fin IS NULL OR (length(fecha_fin) = 24 AND fecha_fin GLOB '????-??-??T??:??:??.???Z')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_orders_codigo_unico` ON `production_orders` (`codigo`);--> statement-breakpoint
CREATE INDEX `production_orders_estado` ON `production_orders` (`estado`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`familia_id` text NOT NULL,
	`expira_at` text NOT NULL,
	`revocado_at` text,
	`reemplazado_por` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refresh_tokens_token_hash_hex" CHECK(length(token_hash) = 64),
	CONSTRAINT "refresh_tokens_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (length(expira_at) = 24 AND expira_at GLOB '????-??-??T??:??:??.???Z') AND (revocado_at IS NULL OR (length(revocado_at) = 24 AND revocado_at GLOB '????-??-??T??:??:??.???Z')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_hash` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_user_id` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_familia_id` ON `refresh_tokens` (`familia_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`clave` text PRIMARY KEY NOT NULL,
	`valor` text NOT NULL,
	`actualizado_por` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`actualizado_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "settings_valor_json" CHECK(json_valid(valor)),
	CONSTRAINT "settings_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE TABLE `sync_mutations` (
	`mutation_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`tipo` text NOT NULL,
	`resultado` text NOT NULL,
	`respuesta_json` text NOT NULL,
	`payload_json` text,
	`procesada_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sync_mutations_resultado_valido" CHECK(resultado IN ('aplicada', 'rechazada', 'conflicto')),
	CONSTRAINT "sync_mutations_respuesta_json" CHECK(json_valid(respuesta_json)),
	CONSTRAINT "sync_mutations_payload_json" CHECK(payload_json IS NULL OR (json_valid(payload_json) AND length(payload_json) <= 65536)),
	CONSTRAINT "sync_mutations_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (length(procesada_at) = 24 AND procesada_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE INDEX `sync_mutations_user_id_procesada_at` ON `sync_mutations` (`user_id`,`procesada_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`nombre` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`rol` text NOT NULL,
	`activo` integer DEFAULT true NOT NULL,
	`intentos_fallidos` integer DEFAULT 0 NOT NULL,
	`bloqueado_hasta` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "users_email_minusculas" CHECK(email = lower(email) AND length(trim(email)) > 0),
	CONSTRAINT "users_rol_valido" CHECK(rol IN ('supervisor', 'jefe', 'admin')),
	CONSTRAINT "users_activo_booleano" CHECK(activo IN (0, 1)),
	CONSTRAINT "users_intentos_no_negativos" CHECK(intentos_fallidos >= 0),
	CONSTRAINT "users_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (bloqueado_hasta IS NULL OR (length(bloqueado_hasta) = 24 AND bloqueado_hasta GLOB '????-??-??T??:??:??.???Z')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unico` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `validations` (
	`id` text PRIMARY KEY NOT NULL,
	`consumption_id` text NOT NULL,
	`decision` text NOT NULL,
	`motivo` text,
	`validado_por` text NOT NULL,
	`client_created_at` text NOT NULL,
	`server_received_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`consumption_id`) REFERENCES `consumptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`validado_por`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "validations_decision_valida" CHECK(decision IN ('aprobado', 'rechazado')),
	CONSTRAINT "validations_motivo_si_rechaza" CHECK(decision = 'aprobado' OR (motivo IS NOT NULL AND length(trim(motivo)) >= 3)),
	CONSTRAINT "validations_fechas_iso" CHECK((length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z') AND (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z') AND (length(client_created_at) = 24 AND client_created_at GLOB '????-??-??T??:??:??.???Z') AND (length(server_received_at) = 24 AND server_received_at GLOB '????-??-??T??:??:??.???Z'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `validations_consumption_id_unico` ON `validations` (`consumption_id`);
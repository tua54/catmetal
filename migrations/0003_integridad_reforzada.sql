ALTER TABLE `audit_log` ADD `order_id` text;--> statement-breakpoint
CREATE INDEX `audit_log_order_id_seq` ON `audit_log` (`order_id`,`seq`) WHERE order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `consumptions_pendientes_id` ON `consumptions` (`id`) WHERE estado = 'pendiente';--> statement-breakpoint
CREATE INDEX `consumptions_order_id_id` ON `consumptions` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_vigentes_usuario` ON `refresh_tokens` (`user_id`,`device_id`) WHERE revocado_at IS NULL;
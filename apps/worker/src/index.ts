// Punto de entrada del Worker: `fetch` (PWA + API) y `scheduled` (cron diario).

import { app } from './app';
import { ejecutarCron } from './cron/ejecutar';

/**
 * Cron `0 8 * * *` (03:00 en Bogotá): backup paginado de D1 a R2 y mantenimiento (ADR 0014).
 * `ejecutarCron` nunca lanza: registra en logs estructurados el inicio, el resumen y los errores.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = (controller, env, ctx) => {
  ctx.waitUntil(
    ejecutarCron(env, { cron: controller.cron, scheduledTime: controller.scheduledTime }),
  );
};

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

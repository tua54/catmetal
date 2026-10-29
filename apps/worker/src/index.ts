// Punto de entrada del Worker: `fetch` (PWA + API) y `scheduled` (cron diario).

import { app } from './app';
import { registrar } from './log';

/**
 * Cron `0 8 * * *` (03:00 en Bogotá). En la Fase 6 hará el backup paginado de D1 a R2 y el
 * mantenimiento; por ahora solo deja constancia de la ejecución.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = (controller) => {
  registrar('info', 'cron_ejecutado', {
    cron: controller.cron,
    programado_para: new Date(controller.scheduledTime).toISOString(),
  });
};

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

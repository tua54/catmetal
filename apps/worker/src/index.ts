// Esqueleto mínimo del Worker. La app Hono y los bindings se configuran en la tarea 0.3.
import { NOMBRE_PAQUETE } from '@catmetal/shared';

export const NOMBRE_SERVICIO = 'catmetal-worker';

export default {
  fetch(): Response {
    return Response.json({ servicio: NOMBRE_SERVICIO, shared: NOMBRE_PAQUETE });
  },
} satisfies ExportedHandler;

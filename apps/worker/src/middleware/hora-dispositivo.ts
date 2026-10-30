// Hora del dispositivo al enviar en el REST (ADR 0019, docs/spec.md §6 "Reloj"). Las peticiones que
// escriben (método distinto de GET/HEAD/OPTIONS) pueden traer `X-Hora-Dispositivo` con la hora del
// dispositivo justo antes del `fetch`. Con ella se calcula UNA alerta de reloj para la petición, que
// llevan todas sus filas de auditoría. Ausente o con formato inválido → se ignora: alerta 0, sin
// rechazar la petición. `/sync/push` usa `enviado_at` del cuerpo en su lugar.

import { CABECERA_HORA_DISPOSITIVO, horaDeEnvio } from '@catmetal/shared';
import type { Context } from 'hono';
import { calcularAlertaReloj } from '../auditoria/auditar';
import type { AppEnv } from '../tipos';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Alerta de reloj de una petición REST: `X-Hora-Dispositivo` frente a `recibidoAt` (la hora del
 * servidor con la que se escribe la petición). Las lecturas nunca la marcan.
 */
export function alertaRelojDePeticion(c: Context<AppEnv>, recibidoAt: string): boolean {
  if (METODOS_SEGUROS.has(c.req.method)) {
    return false;
  }
  return calcularAlertaReloj(horaDeEnvio(c.req.header(CABECERA_HORA_DISPOSITIVO)), recibidoAt);
}

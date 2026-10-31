// Conversión de los eventos de `GET /orders/:id/audit` al componente `LineaTiempo`.

import { diaBogota, ZONA_HORARIA, type EventoLineaTiempo } from '@catmetal/shared';
import type { EventoLinea } from '../../components/ui';
import { nombreCorto } from '../../datos';
import { ROL_EN_LINEA } from './estado-orden';

export const ETIQUETA_TRAZABILIDAD = 'Trazabilidad completa de la orden';

const formatoDia = new Intl.DateTimeFormat('es-CO', {
  timeZone: ZONA_HORARIA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * Hora del evento: la del dispositivo (`client_at`, cuándo pasó en planta, aunque llegara después
 * por la sync) salvo que el reloj del dispositivo estuviera desfasado (`alerta_reloj`); en ese caso,
 * la del servidor.
 */
export function horaDelEvento(evento: EventoLineaTiempo): string {
  return evento.client_at !== null && !evento.alerta_reloj ? evento.client_at : evento.server_at;
}

/** Evento del contrato → evento del componente `LineaTiempo` (color por `tipo`). */
export function aEventoLinea(evento: EventoLineaTiempo, ahora: Date = new Date()): EventoLinea {
  const fechaHora = horaDelEvento(evento);
  // La línea muestra solo la hora: si el evento no es de hoy, la fecha va al inicio del texto.
  const otroDia = diaBogota(fechaHora) !== diaBogota(ahora.toISOString());
  const fecha = otroDia ? `${formatoDia.format(new Date(fechaHora))} · ` : '';
  const reloj = evento.alerta_reloj ? ' (reloj del dispositivo desfasado: hora del servidor)' : '';
  return {
    id: evento.id,
    fechaHora,
    actor: evento.actor === null ? 'Sistema' : nombreCorto(evento.actor.nombre),
    rol: evento.actor === null ? undefined : ROL_EN_LINEA[evento.actor.rol],
    descripcion: `${fecha}${evento.descripcion}${reloj}`,
    tipo: evento.tipo,
  };
}

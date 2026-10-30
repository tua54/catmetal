// Trazabilidad de este dispositivo: eventos locales "10:24 · Juan S. registró consumo + novedad".
// Es informativa para el operario; la auditoría autoritativa es `audit_log` del servidor.

import { formatearHora, uuidv7 } from '@catmetal/shared';
import { db } from './db';
import type { AccionTrazabilidad, EventoTrazabilidad } from './tipos';

export const DESCRIPCIONES_TRAZABILIDAD: Readonly<Record<AccionTrazabilidad, string>> = {
  'consumo.registrado': 'registró consumo',
  'consumo.registrado_con_novedad': 'registró consumo + novedad',
  'consumo.editado': 'editó consumo',
  'novedad.registrada': 'registró novedad',
  'consumo.aprobado': 'aprobó consumo',
  'consumo.rechazado': 'rechazó consumo',
  'sync.completada': 'sincronizó',
};

/** "Juan Sebastián Pérez" → "Juan S."; un solo nombre se deja igual; vacío → "Usuario". */
export function nombreCorto(nombre: string | null | undefined): string {
  const partes = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  const [primero, segundo] = partes;
  if (primero === undefined) {
    return 'Usuario';
  }
  return segundo === undefined ? primero : `${primero} ${segundo.charAt(0).toUpperCase()}.`;
}

/** Texto del evento para la UI, con la hora de Bogotá. */
export function textoEvento(evento: EventoTrazabilidad): string {
  return `${formatearHora(evento.ts)} · ${evento.actor_nombre} ${evento.descripcion}`;
}

/** Registra un evento. Debe llamarse dentro de la transacción de la acción que describe. */
export async function registrarEvento(
  userId: string,
  accion: AccionTrazabilidad,
  entidadId: string,
  orderId: string | null,
  ts: string,
  /** Texto propio (por ejemplo, el resumen de una sincronización); por defecto, el de la acción. */
  descripcion?: string,
): Promise<void> {
  const perfil = await db.perfiles.get(userId);
  await db.trazabilidad.add({
    id: uuidv7(),
    user_id: userId,
    ts,
    accion,
    descripcion: descripcion ?? DESCRIPCIONES_TRAZABILIDAD[accion],
    actor_nombre: nombreCorto(perfil?.perfil.nombre),
    entidad_id: entidadId,
    order_id: orderId,
  });
}

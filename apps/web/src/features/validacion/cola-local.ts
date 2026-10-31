// Cola de validación leída de la copia local del jefe (Dexie), para cuando no hay servidor (S5: el
// jefe trabaja normalmente con conexión, pero su app tolera cortes). Reproduce la forma de
// `ElementoCola` del contrato con lo que trajo la última sincronización; la UI avisa que es la
// copia de la tablet.

import type { ElementoCola, Evidencia, Novedad, NovedadConEvidencias } from '@catmetal/shared';
import { db, rangoDe } from '../../datos/db';
import type { EvidenciaLocal, NovedadLocal } from '../../datos/tipos';
import type { FiltrosCola } from './api';

function novedadDe(n: NovedadLocal): Novedad {
  return (
    n.servidor ?? {
      id: n.id,
      consumption_id: n.consumption_id,
      tipo: n.tipo,
      descripcion: n.descripcion,
      registrado_por: n.registrado_por,
      client_created_at: n.client_created_at,
      server_received_at: n.client_created_at,
      created_at: n.client_created_at,
      updated_at: n.actualizado_at,
    }
  );
}

function evidenciaDe(e: EvidenciaLocal): Evidencia {
  const subida = e.servidor?.subido === true || e.estado_subida === 'subida';
  return {
    ...(e.servidor ?? {
      id: e.id,
      incident_id: e.incident_id,
      mime: e.mime,
      tamano_bytes: e.tamano_bytes,
      sha256: e.sha256,
      subido_at: e.subido_at,
      created_at: e.actualizado_at,
      updated_at: e.actualizado_at,
    }),
    subido: subida,
  };
}

/**
 * Consumos `pendiente` (según el servidor) de la partición del jefe, con los mismos filtros que
 * `GET /validations/queue` y en el mismo orden (por id).
 */
export async function colaLocal(userId: string, filtros: FiltrosCola): Promise<ElementoCola[]> {
  const consumos = (
    await db.consumos
      .where(':id')
      .between(...rangoDe(userId))
      .toArray()
  ).filter(
    (c) =>
      c.servidor !== null &&
      c.servidor.estado === 'pendiente' &&
      c.perdido_en_restauracion !== true &&
      (filtros.orden === null || c.order_id === filtros.orden) &&
      (filtros.supervisor === null || c.registrado_por === filtros.supervisor),
  );
  if (consumos.length === 0) {
    return [];
  }

  const ids = consumos.map((c) => c.id);
  const novedades = (
    await db.novedades
      .where('[user_id+consumption_id]')
      .anyOf(ids.map((id) => [userId, id]))
      .toArray()
  ).filter((n) => n.estado_local !== 'rechazado_sync');
  const evidencias =
    novedades.length === 0
      ? []
      : await db.evidencias
          .where('[user_id+incident_id]')
          .anyOf(novedades.map((n) => [userId, n.id]))
          .toArray();
  const [materiales, usuarios, ordenes] = await Promise.all([
    db.materiales
      .where(':id')
      .between(...rangoDe(userId))
      .toArray(),
    db.usuarios
      .where(':id')
      .between(...rangoDe(userId))
      .toArray(),
    db.ordenes
      .where(':id')
      .between(...rangoDe(userId))
      .toArray(),
  ]);
  const material = new Map(materiales.map((m) => [m.id, m]));
  const usuario = new Map(usuarios.map((u) => [u.id, u]));
  const orden = new Map(ordenes.map((o) => [o.id, o]));

  const elementos: ElementoCola[] = [];
  for (const c of consumos) {
    const servidor = c.servidor;
    if (servidor === null) {
      continue;
    }
    const suyas: NovedadConEvidencias[] = novedades
      .filter((n) => n.consumption_id === c.id)
      .map((n) => ({
        ...novedadDe(n),
        evidencias: evidencias.filter((e) => e.incident_id === n.id).map(evidenciaDe),
      }));
    const falta = servidor.requiere_novedad && suyas.length === 0;
    if (filtros.conNovedad && suyas.length === 0 && !servidor.requiere_novedad) {
      continue;
    }
    const m = material.get(c.material_id);
    const o = orden.get(c.order_id);
    elementos.push({
      ...servidor,
      material: {
        id: c.material_id,
        codigo: m?.codigo ?? '',
        nombre: m?.nombre ?? 'Material sin catálogo local',
      },
      supervisor: {
        id: c.registrado_por,
        nombre: usuario.get(c.registrado_por)?.nombre ?? 'Supervisor',
      },
      orden: { id: c.order_id, codigo: o?.codigo ?? 'Orden sin datos locales' },
      falta_novedad: falta,
      propio: c.registrado_por === userId,
      novedades: suyas,
    });
  }
  return elementos.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Decisiones del jefe guardadas en esta tablet y aún sin confirmar por el servidor:
 * `consumption_id` → decisión. La tarjeta muestra "Pendiente de sync" y oculta los botones.
 */
export async function decisionesPendientesLocales(
  userId: string,
): Promise<Map<string, 'aprobado' | 'rechazado'>> {
  const validaciones = await db.validaciones
    .where(':id')
    .between(...rangoDe(userId))
    .toArray();
  return new Map(
    validaciones
      .filter((v) => v.estado_local === 'pendiente_sync')
      .map((v) => [v.consumption_id, v.decision]),
  );
}

/** Bytes de una evidencia guardados en esta tablet (solo existen para fotos tomadas aquí). */
export async function evidenciaLocal(userId: string, id: string): Promise<Blob | null> {
  const fila = await db.evidencias.get([userId, id]);
  if (fila?.datos === null || fila?.datos === undefined) {
    return null;
  }
  return new Blob([fila.datos], { type: fila.mime });
}

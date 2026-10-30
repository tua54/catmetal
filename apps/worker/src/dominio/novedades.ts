// Novedades (desviaciones justificadas) y metadatos de sus evidencias (docs/spec.md §1, §6, §7;
// docs/plan-fase-2.md "Novedad"; P14, P15).
//
// - La registra el autor del consumo o un jefe (supervisor ajeno → 403; admin → 403). El consumo
//   debe ser visible para quien la registra (si no, 404).
// - Se acepta sobre un consumo en cualquier estado (no se pierden datos de planta) y puede haber
//   varias por consumo.
// - En el mismo batch: la novedad, las evidencias declaradas (`subido = 0`, la foto se sube después
//   con `PUT /evidences/:id`) y una fila de auditoría por cada entidad, todas con `order_id`.

import {
  type CrearNovedad,
  type Evidencia,
  type Novedad,
  type NovedadConEvidencias,
  tienePermiso,
} from '@catmetal/shared';
import { type CondicionSql, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import type { Contexto } from './contexto';
import { buscarConsumo } from './consumos';
import type { PlanDeEscritura } from './plan';
import { puedeVerConsumo } from './visibilidad';

/** Clave del objeto en R2 (docs/spec.md §7). Nunca se expone por la API. */
export function claveEvidencia(orderId: string, evidenceId: string): string {
  return `evidencias/${orderId}/${evidenceId}`;
}

export async function registrarNovedad(
  ctx: Contexto,
  entrada: CrearNovedad,
): Promise<PlanDeEscritura<NovedadConEvidencias>> {
  if (!tienePermiso(ctx.actor.rol, 'novedades.registrar')) {
    throw new ErrorApi('PERMISO_DENEGADO');
  }
  const consumo = await buscarConsumo(ctx.db, entrada.consumption_id);
  if (consumo === null || !(await puedeVerConsumo(ctx, consumo))) {
    throw new ErrorApi('NO_ENCONTRADO', { campo: 'consumption_id' });
  }
  if (consumo.registrado_por !== ctx.actor.id && ctx.actor.rol !== 'jefe') {
    throw new ErrorApi('PERMISO_DENEGADO');
  }
  const existente = await ctx.db
    .prepare('SELECT 1 AS x FROM incidents WHERE id = ?')
    .bind(entrada.id)
    .first();
  if (existente !== null) {
    throw new ErrorApi('ID_DUPLICADO', { entidad: 'incidents', campos: ['id'] });
  }
  // La clave de R2 se deriva del id: un id repetido chocaría primero con el UNIQUE de
  // `storage_key` (→ CONFLICTO). Se comprueba antes para responder ID_DUPLICADO.
  const evidenciaRepetida = await ctx.db
    .prepare('SELECT 1 AS x FROM evidences WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1')
    .bind(JSON.stringify(entrada.evidencias.map((e) => e.id)))
    .first();
  if (evidenciaRepetida !== null) {
    throw new ErrorApi('ID_DUPLICADO', { entidad: 'evidences', campos: ['id'] });
  }

  const novedad: Novedad = {
    id: entrada.id,
    consumption_id: consumo.id,
    tipo: entrada.tipo,
    descripcion: entrada.descripcion,
    registrado_por: ctx.actor.id,
    client_created_at: entrada.client_created_at,
    server_received_at: ctx.ahora,
    created_at: ctx.ahora,
    updated_at: ctx.ahora,
  };
  const evidencias: Evidencia[] = entrada.evidencias.map((e) => ({
    id: e.id,
    incident_id: novedad.id,
    mime: e.mime,
    tamano_bytes: e.tamano_bytes,
    sha256: e.sha256,
    subido: false,
    subido_at: null,
    created_at: ctx.ahora,
    updated_at: ctx.ahora,
  }));
  // La novedad es "nuestra" si existe con este id, autor y hora de recepción.
  const aplicada: CondicionSql = {
    sql: 'EXISTS (SELECT 1 FROM incidents WHERE id = ? AND registrado_por = ? AND server_received_at = ?)',
    parametros: [novedad.id, ctx.actor.id, ctx.ahora],
  };
  const auditar = (
    entidad: 'incidents' | 'evidences',
    entidadId: string,
    accion: string,
    despues: Record<string, unknown>,
  ) =>
    sentenciaAuditoriaCondicional(
      ctx.db,
      {
        entidad,
        entidad_id: entidadId,
        accion,
        order_id: consumo.order_id,
        actor_id: ctx.actor.id,
        device_id: ctx.deviceId,
        despues,
        client_at: entrada.client_created_at,
        server_at: ctx.ahora,
        alerta_reloj: ctx.alertaReloj,
      },
      aplicada,
    );

  const sentencias: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT INTO incidents (id, consumption_id, tipo, descripcion, registrado_por,
           client_created_at, server_received_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        novedad.id,
        novedad.consumption_id,
        novedad.tipo,
        novedad.descripcion,
        novedad.registrado_por,
        novedad.client_created_at,
        novedad.server_received_at,
        ctx.ahora,
        ctx.ahora,
      ),
    auditar('incidents', novedad.id, 'novedad.crear', { ...novedad }),
  ];
  for (const evidencia of evidencias) {
    sentencias.push(
      ctx.db
        .prepare(
          `INSERT INTO evidences (id, incident_id, storage_key, mime, tamano_bytes, sha256, subido,
             subido_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 0, NULL, ?, ? WHERE ${aplicada.sql}`,
        )
        .bind(
          evidencia.id,
          evidencia.incident_id,
          claveEvidencia(consumo.order_id, evidencia.id),
          evidencia.mime,
          evidencia.tamano_bytes,
          evidencia.sha256,
          ctx.ahora,
          ctx.ahora,
          ...aplicada.parametros,
        ),
      auditar('evidences', evidencia.id, 'evidencia.crear', { ...evidencia }),
    );
  }
  return {
    sentencias,
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: { ...novedad, evidencias },
  };
}

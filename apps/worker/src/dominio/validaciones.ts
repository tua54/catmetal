// Validación del jefe: aprobar, rechazar y cola de pendientes (docs/spec.md S9, §3, §6, §7;
// docs/plan-fase-2.md "Validación"; ADR 0010 punto 2; P1).
//
// - Solo el jefe (`consumos.validar`). Nunca un consumo propio (`AUTOAPROBACION`), aunque sea el
//   único jefe (P1: queda pendiente hasta que lo valide otro jefe).
// - Solo `pendiente` y sobre la `version` que vio el jefe (si cambió → 409 `CONFLICTO`).
// - No se aprueba con `requiere_novedad = 1` sin ninguna novedad (`REQUIERE_NOVEDAD`).
// - El Worker NO actualiza el consumo: inserta la validación y el trigger
//   `validations_aplica_decision` pone `estado = decision` y `version + 1` en el mismo INSERT.
//   La inserción va condicionada a que el consumo siga como se leyó; la auditoría de la validación
//   y la del consumo, condicionadas a que la validación exista. Si no aplicó, se relee
//   (`ejecutarConReintento`) y el comando devuelve el error preciso.
// - Si aplicó lo dice una LECTURA en el mismo batch, justo después del INSERT (B11): la validación
//   propia de esta petición y el consumo ya decidido como se responde. No depende de que
//   `meta.changes` cuente las filas que escribe el trigger.
//
// Los payloads son los de las mutaciones `consumo.aprobar` / `consumo.rechazar` (`/sync/push`).

import {
  type ColaValidacion,
  type ColaValidacionQuery,
  type Consumo,
  type Decision,
  LIMITE_PAGINA_DEFECTO,
  type MutacionDe,
  type ResultadoValidacion,
  tienePermiso,
  type Validacion,
} from '@catmetal/shared';
import { nuevaMarca, porMarca, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import {
  agruparNovedades,
  buscarConsumo,
  COLUMNAS_CONSUMO,
  consumoDe,
  type FilaConsumo,
  sentenciasNovedadesDe,
} from './consumos';
import type { Contexto } from './contexto';
import type { PlanDeEscritura } from './plan';

export type AprobarConsumo = MutacionDe<'consumo.aprobar'>['payload'];
export type RechazarConsumo = MutacionDe<'consumo.rechazar'>['payload'];

const ACCION_CONSUMO: Readonly<Record<Decision, string>> = {
  aprobado: 'consumo.aprobar',
  rechazado: 'consumo.rechazar',
};

async function tieneNovedad(db: D1Database, consumoId: string): Promise<boolean> {
  const fila = await db
    .prepare('SELECT 1 AS x FROM incidents WHERE consumption_id = ? LIMIT 1')
    .bind(consumoId)
    .first();
  return fila !== null;
}

async function decidir(
  ctx: Contexto,
  decision: Decision,
  entrada: AprobarConsumo & { motivo?: string },
): Promise<PlanDeEscritura<ResultadoValidacion>> {
  if (!tienePermiso(ctx.actor.rol, 'consumos.validar')) {
    throw new ErrorApi('PERMISO_DENEGADO');
  }
  const actual = await buscarConsumo(ctx.db, entrada.consumption_id);
  if (actual === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  const repetida = await ctx.db
    .prepare('SELECT 1 AS x FROM validations WHERE id = ?')
    .bind(entrada.id)
    .first();
  if (repetida !== null) {
    throw new ErrorApi('ID_DUPLICADO', { entidad: 'validations', campos: ['id'] });
  }
  if (actual.registrado_por === ctx.actor.id) {
    throw new ErrorApi('AUTOAPROBACION');
  }
  if (actual.estado !== 'pendiente') {
    throw new ErrorApi('CONSUMO_NO_PENDIENTE', { estado: actual.estado });
  }
  if (actual.version !== entrada.version) {
    throw new ErrorApi('CONFLICTO', {
      version_servidor: actual.version,
      consumo: consumoDe(actual),
    });
  }
  const exigeNovedad = decision === 'aprobado' && actual.requiere_novedad === 1;
  if (exigeNovedad && !(await tieneNovedad(ctx.db, actual.id))) {
    throw new ErrorApi('REQUIERE_NOVEDAD');
  }

  const validacion: Validacion = {
    id: entrada.id,
    consumption_id: actual.id,
    decision,
    motivo: decision === 'rechazado' ? (entrada.motivo ?? null) : null,
    validado_por: ctx.actor.id,
    client_created_at: entrada.client_created_at,
    server_received_at: ctx.ahora,
    created_at: ctx.ahora,
    updated_at: ctx.ahora,
  };
  // Lo que aplica el trigger `validations_aplica_decision`.
  const decidido: FilaConsumo = {
    ...actual,
    estado: decision,
    version: actual.version + 1,
    updated_at: ctx.ahora,
  };
  // A1 (ADR 0028): el id de la validación lo manda el cliente, así que no sirve de marca. El INSERT
  // fija la suya y TODO lo demás se condiciona a ella. El trigger `validations_aplica_decision` no
  // fija la marca del consumo: las auditorías de aprobar/rechazar también usan la de la validación.
  const marca = nuevaMarca();
  const aplicada = porMarca('validations', { id: validacion.id }, marca);
  // B11: la validación es la de ESTE batch (su marca) y el trigger dejó el consumo como `decidido`
  // (lo que se responde).
  const verificacion = ctx.db
    .prepare(
      `SELECT 1 AS aplicada FROM validations AS v JOIN consumptions AS c ON c.id = v.consumption_id
       WHERE v.id = ? AND v.escritura_id = ? AND c.estado = ? AND c.version = ?`,
    )
    .bind(validacion.id, marca, decidido.estado, decidido.version);
  const auditar = (
    entidad: 'validations' | 'consumptions',
    entidadId: string,
    accion: string,
    antes: Record<string, unknown> | null,
    despues: Record<string, unknown>,
  ) =>
    sentenciaAuditoriaCondicional(
      ctx.db,
      {
        entidad,
        entidad_id: entidadId,
        accion,
        order_id: actual.order_id,
        actor_id: ctx.actor.id,
        device_id: ctx.deviceId,
        antes,
        despues,
        client_at: entrada.client_created_at,
        server_at: ctx.ahora,
        alerta_reloj: ctx.alertaReloj,
      },
      aplicada,
    );

  return {
    sentencias: [
      ctx.db
        .prepare(
          `INSERT INTO validations (id, consumption_id, decision, motivo, validado_por,
             client_created_at, server_received_at, created_at, updated_at, escritura_id)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM consumptions AS c
             WHERE c.id = ? AND c.estado = 'pendiente' AND c.version = ? AND c.registrado_por <> ?
               AND (? = 0 OR c.requiere_novedad = 0
                    OR EXISTS (SELECT 1 FROM incidents AS i WHERE i.consumption_id = c.id)))`,
        )
        .bind(
          validacion.id,
          validacion.consumption_id,
          validacion.decision,
          validacion.motivo,
          validacion.validado_por,
          validacion.client_created_at,
          validacion.server_received_at,
          ctx.ahora,
          ctx.ahora,
          marca,
          actual.id,
          actual.version,
          ctx.actor.id,
          decision === 'aprobado' ? 1 : 0,
        ),
      verificacion,
      auditar('validations', validacion.id, 'validacion.crear', null, { ...validacion }),
      auditar('consumptions', actual.id, ACCION_CONSUMO[decision], { ...actual }, { ...decidido }),
    ],
    // Por las filas de `verificacion`, no por `meta.changes` del INSERT (que en D1 incluye las
    // filas que escribe el trigger y podría cambiar): B11.
    principal: { indice: 1, filasEsperadas: 1 },
    aplicada,
    respuesta: { consumo: consumoDe(decidido), validacion },
    siNoAplica: new ErrorApi('CONFLICTO'),
  };
}

/** `POST /consumptions/:id/approve` y mutación `consumo.aprobar`. Úselo con `ejecutarConReintento`. */
export function aprobarConsumo(
  ctx: Contexto,
  entrada: AprobarConsumo,
): Promise<PlanDeEscritura<ResultadoValidacion>> {
  return decidir(ctx, 'aprobado', entrada);
}

/** `POST /consumptions/:id/reject` y mutación `consumo.rechazar` (motivo obligatorio en el esquema). */
export function rechazarConsumo(
  ctx: Contexto,
  entrada: RechazarConsumo,
): Promise<PlanDeEscritura<ResultadoValidacion>> {
  return decidir(ctx, 'rechazado', entrada);
}

// ---------------------------------------------------------------------------------------------
// Cola de validación
// ---------------------------------------------------------------------------------------------

interface FilaCola extends FilaConsumo {
  material_codigo: string;
  material_nombre: string;
  supervisor_nombre: string;
  orden_codigo: string;
  tiene_novedad: number;
}

/**
 * `GET /validations/queue` (jefe): consumos `pendiente` (índice parcial
 * `consumptions_pendientes_id`, por eso el literal `'pendiente'`), filtros opcionales por orden,
 * supervisor y `con_novedad`, cursor por id y el total `pendientes` del filtro.
 */
export async function colaDeValidacion(
  ctx: Contexto,
  query: ColaValidacionQuery,
): Promise<ColaValidacion> {
  if (!tienePermiso(ctx.actor.rol, 'consumos.validar')) {
    throw new ErrorApi('PERMISO_DENEGADO');
  }
  const limite = query.limite ?? LIMITE_PAGINA_DEFECTO;
  const conNovedad = query.con_novedad === undefined ? null : query.con_novedad ? 1 : 0;
  const filtro = `c.estado = 'pendiente'
    AND (?1 IS NULL OR c.order_id = ?1)
    AND (?2 IS NULL OR c.registrado_por = ?2)
    AND (?3 IS NULL OR ?3 = (c.requiere_novedad = 1
         OR EXISTS (SELECT 1 FROM incidents AS n WHERE n.consumption_id = c.id)))`;
  const parametros = [query.orden ?? null, query.supervisor ?? null, conNovedad];
  const columnas = COLUMNAS_CONSUMO.split(', ')
    .map((columna) => `c.${columna}`)
    .join(', ');
  const [pagina, total] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT ${columnas}, m.codigo AS material_codigo, m.nombre AS material_nombre,
           u.nombre AS supervisor_nombre, o.codigo AS orden_codigo,
           EXISTS (SELECT 1 FROM incidents AS i WHERE i.consumption_id = c.id) AS tiene_novedad
         FROM consumptions AS c
         JOIN materials AS m ON m.id = c.material_id
         JOIN users AS u ON u.id = c.registrado_por
         JOIN production_orders AS o ON o.id = c.order_id
         WHERE ${filtro} AND c.id > ?4
         ORDER BY c.id LIMIT ?5`,
      )
      .bind(...parametros, query.cursor ?? '', limite + 1),
    ctx.db
      .prepare(`SELECT count(*) AS pendientes FROM consumptions AS c WHERE ${filtro}`)
      .bind(...parametros),
  ]);
  const filas = (pagina?.results ?? []) as FilaCola[];
  const visibles = filas.slice(0, limite);
  const ultimo = visibles.at(-1);
  const [novedades, evidencias] =
    visibles.length === 0
      ? [undefined, undefined]
      : await ctx.db.batch(
          sentenciasNovedadesDe(ctx.db, JSON.stringify(visibles.map((f) => f.id))),
        );
  const novedadesPorConsumo = agruparNovedades(novedades, evidencias);
  return {
    elementos: visibles.map((fila) => {
      const {
        material_codigo: codigo,
        material_nombre: nombre,
        supervisor_nombre: supervisorNombre,
        orden_codigo: ordenCodigo,
        tiene_novedad: tieneAlguna,
        ...consumo
      } = fila;
      const base: Consumo = consumoDe(consumo);
      return {
        ...base,
        material: { id: base.material_id, codigo, nombre },
        supervisor: { id: base.registrado_por, nombre: supervisorNombre },
        orden: { id: base.order_id, codigo: ordenCodigo },
        falta_novedad: base.requiere_novedad && tieneAlguna !== 1,
        propio: base.registrado_por === ctx.actor.id,
        novedades: novedadesPorConsumo.get(base.id) ?? [],
      };
    }),
    pendientes: (total?.results[0] as { pendientes: number } | undefined)?.pendientes ?? 0,
    siguiente_cursor: filas.length > limite && ultimo !== undefined ? ultimo.id : null,
  };
}

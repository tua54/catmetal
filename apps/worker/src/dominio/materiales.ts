// Catálogo de materiales (docs/spec.md §3, §4 y §7). Solo el admin lo gestiona; nunca se borra un
// material: se desactiva con `activo = false`. El código y la unidad no se editan
// (`editarMaterialSchema`): la unidad la usan los planes y los consumos ya registrados.

import {
  type CrearMaterial,
  type EditarMaterial,
  LIMITE_PAGINA_DEFECTO,
  type ListaMateriales,
  type ListarMaterialesQuery,
  type Material,
  type Unidad,
  uuidv7,
} from '@catmetal/shared';
import { sentenciaAuditoria, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import type { Contexto } from './contexto';
import type { PlanDeEscritura } from './plan';

export const COLUMNAS_MATERIAL =
  'id, codigo, nombre, unidad, costo_unitario_cop, activo, created_at, updated_at';

export interface FilaMaterial {
  id: string;
  codigo: string;
  nombre: string;
  unidad: Unidad;
  costo_unitario_cop: number;
  activo: number;
  created_at: string;
  updated_at: string;
}

export function materialDe(fila: FilaMaterial): Material {
  return { ...fila, activo: fila.activo === 1 };
}

export async function buscarMaterial(db: D1Database, id: string): Promise<FilaMaterial | null> {
  return db
    .prepare(`SELECT ${COLUMNAS_MATERIAL} FROM materials WHERE id = ?`)
    .bind(id)
    .first<FilaMaterial>();
}

/** `GET /materials`: paginación por cursor sobre el id (nunca OFFSET), filtro opcional `activo`. */
export async function listarMateriales(
  db: D1Database,
  query: ListarMaterialesQuery,
): Promise<ListaMateriales> {
  const limite = query.limite ?? LIMITE_PAGINA_DEFECTO;
  const filtroActivo = query.activo === undefined ? null : query.activo ? 1 : 0;
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNAS_MATERIAL} FROM materials
       WHERE id > ?1 AND (?2 IS NULL OR activo = ?2)
       ORDER BY id LIMIT ?3`,
    )
    .bind(query.cursor ?? '', filtroActivo, limite + 1)
    .all<FilaMaterial>();
  const pagina = results.slice(0, limite);
  const ultimo = pagina.at(-1);
  return {
    materiales: pagina.map(materialDe),
    siguiente_cursor: results.length > limite && ultimo !== undefined ? ultimo.id : null,
  };
}

/** `POST /materials`. El código es único: si se repite, el batch falla y se traduce a 409. */
export function crearMaterial(ctx: Contexto, entrada: CrearMaterial): PlanDeEscritura<Material> {
  const fila: FilaMaterial = {
    id: uuidv7(),
    codigo: entrada.codigo,
    nombre: entrada.nombre,
    unidad: entrada.unidad,
    costo_unitario_cop: entrada.costo_unitario_cop,
    activo: 1,
    created_at: ctx.ahora,
    updated_at: ctx.ahora,
  };
  return {
    sentencias: [
      ctx.db
        .prepare(`INSERT INTO materials (${COLUMNAS_MATERIAL}) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(
          fila.id,
          fila.codigo,
          fila.nombre,
          fila.unidad,
          fila.costo_unitario_cop,
          ctx.ahora,
          ctx.ahora,
        ),
      sentenciaAuditoria(ctx.db, {
        entidad: 'materials',
        entidad_id: fila.id,
        accion: 'material.crear',
        actor_id: ctx.actor.id,
        device_id: ctx.deviceId,
        despues: { ...fila },
        server_at: ctx.ahora,
      }),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: materialDe(fila),
  };
}

/**
 * `PATCH /materials/:id`. El UPDATE se guarda con el `updated_at` leído: si otro admin lo editó
 * entretanto, no aplica (409) y la auditoría (condicionada) tampoco se escribe.
 */
export async function editarMaterial(
  ctx: Contexto,
  id: string,
  entrada: EditarMaterial,
): Promise<PlanDeEscritura<Material>> {
  const actual = await buscarMaterial(ctx.db, id);
  if (actual === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  const nuevo: FilaMaterial = {
    ...actual,
    nombre: entrada.nombre ?? actual.nombre,
    costo_unitario_cop: entrada.costo_unitario_cop ?? actual.costo_unitario_cop,
    activo: entrada.activo === undefined ? actual.activo : entrada.activo ? 1 : 0,
    updated_at: ctx.ahora,
  };
  return {
    sentencias: [
      ctx.db
        .prepare(
          `UPDATE materials SET nombre = ?, costo_unitario_cop = ?, activo = ?, updated_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        .bind(
          nuevo.nombre,
          nuevo.costo_unitario_cop,
          nuevo.activo,
          ctx.ahora,
          id,
          actual.updated_at,
        ),
      sentenciaAuditoriaCondicional(
        ctx.db,
        {
          entidad: 'materials',
          entidad_id: id,
          accion: 'material.editar',
          actor_id: ctx.actor.id,
          device_id: ctx.deviceId,
          antes: { ...actual },
          despues: { ...nuevo },
          server_at: ctx.ahora,
        },
        {
          sql: 'EXISTS (SELECT 1 FROM materials WHERE id = ? AND updated_at = ? AND nombre = ? AND costo_unitario_cop = ? AND activo = ?)',
          parametros: [id, ctx.ahora, nuevo.nombre, nuevo.costo_unitario_cop, nuevo.activo],
        },
      ),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: materialDe(nuevo),
  };
}

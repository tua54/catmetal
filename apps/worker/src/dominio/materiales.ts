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
import {
  nuevaMarca,
  porMarca,
  sentenciaAuditoria,
  sentenciaAuditoriaCondicional,
} from '../auditoria/auditar';
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

/**
 * El material y la marca de su última escritura (ADR 0028), que es interna: va aparte, nunca en
 * `FilaMaterial` (así no puede salir por la API).
 */
async function buscarMaterialConMarca(
  db: D1Database,
  id: string,
): Promise<{ fila: FilaMaterial; marca: string | null } | null> {
  const leida = await db
    .prepare(`SELECT ${COLUMNAS_MATERIAL}, escritura_id FROM materials WHERE id = ?`)
    .bind(id)
    .first<FilaMaterial & { escritura_id: string | null }>();
  if (leida === null) {
    return null;
  }
  const { escritura_id: marca, ...fila } = leida;
  return { fila, marca };
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
        alerta_reloj: ctx.alertaReloj,
      }),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: materialDe(fila),
  };
}

/**
 * `PATCH /materials/:id`. El UPDATE se guarda con el `updated_at` y la marca de escritura leídos
 * (N1: dos ediciones en el mismo milisegundo dejan el mismo `updated_at`, la marca no): si otro
 * admin lo editó entretanto, no aplica (409) y la auditoría, condicionada a la marca de ESTE plan
 * (ADR 0028), tampoco se escribe.
 */
export async function editarMaterial(
  ctx: Contexto,
  id: string,
  entrada: EditarMaterial,
): Promise<PlanDeEscritura<Material>> {
  const leido = await buscarMaterialConMarca(ctx.db, id);
  if (leido === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  const actual = leido.fila;
  const marca = nuevaMarca();
  const aplicada = porMarca('materials', { id }, marca);
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
          `UPDATE materials SET nombre = ?, costo_unitario_cop = ?, activo = ?, updated_at = ?,
             escritura_id = ?
           WHERE id = ? AND updated_at = ? AND escritura_id IS ?`,
        )
        .bind(
          nuevo.nombre,
          nuevo.costo_unitario_cop,
          nuevo.activo,
          ctx.ahora,
          marca,
          id,
          actual.updated_at,
          leido.marca,
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
          alerta_reloj: ctx.alertaReloj,
        },
        aplicada,
      ),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    aplicada,
    respuesta: materialDe(nuevo),
  };
}

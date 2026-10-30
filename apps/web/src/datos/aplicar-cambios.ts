// Aplicación del pull (`GET /sync/pull`) y del snapshot a la partición local (ADR 0005 y 0009).
//
// - `upsert`: estado actual de la entidad; si la entidad tiene mutaciones propias en cola, se difiere
//   (nunca pisa lo local pendiente; ver entidades.ts).
// - `revocar`: borra los datos locales de la entidad; para una orden, todo lo de la orden salvo lo
//   protegido (cola, rechazos, fotos sin subir) y los consumos propios.
// - `hidratar` y `reiniciar`: se PERSISTEN en `meta` (el cursor ya los pasó; si la app se cierra antes
//   de atenderlos, no se pierden) y se devuelven como acciones para el motor.
// - Época distinta: no se aplica nada de la respuesta; se reencolan las mutaciones aplicadas que se
//   conservan, se reinicia el estado sincronizado y se pide un snapshot completo.
//
// Cada llamada es UNA transacción: los cambios, el cursor y la época se guardan juntos o nada.

import {
  ahoraIso,
  syncPullResponseSchema,
  UNIDADES,
  type SyncPullResponse,
  type Unidad,
} from '@catmetal/shared';
import { db, tablasDeDatos } from './db';
import { recalcular } from './derivar';
import {
  reencolarAplicadas,
  reiniciarEstadoSincronizado,
  revocarEntidad,
  upsertConsumo,
  upsertEvidencia,
  upsertNovedad,
  upsertValidacion,
  type EntidadAfectada,
} from './entidades';
import {
  booleano,
  esConsumo,
  esEvidencia,
  esMaterial,
  esNovedad,
  esObjeto,
  esOrden,
  esRol,
  esValidacion,
} from './servidor';
import type { MetaSync } from './tipos';

/** Lo que el motor de sync debe hacer después de aplicar una página. */
export type AccionMotor =
  { tipo: 'snapshot'; motivo: 'epoca' | 'reiniciar' } | { tipo: 'hidratar'; order_id: string };

export interface ResultadoAplicarCambios {
  acciones: AccionMotor[];
  cursor: number;
  epoca: string;
  epoca_cambiada: boolean;
  /** Cambios aplicados (upsert y revocar). */
  aplicados: number;
  /** Cambios ignorados: entidad desconocida o datos que no tienen la forma esperada. */
  ignorados: number;
  /** Mutaciones aplicadas que volvieron a `pendiente` por el cambio de época. */
  reencoladas: number;
}

/** Entidad de un snapshot o de un `upsert`. */
export interface EntidadSync {
  entidad: string;
  id: string;
  datos: Record<string, unknown> | null;
}

function metaInicial(userId: string): MetaSync {
  return {
    user_id: userId,
    cursor: 0,
    epoca: null,
    ultimo_sync_at: null,
    requiere_snapshot: false,
    motivo_snapshot: null,
    hidrataciones: [],
  };
}

function accionesDe(meta: MetaSync): AccionMotor[] {
  if (meta.requiere_snapshot) {
    // El snapshot completo cubre también las hidrataciones.
    return [{ tipo: 'snapshot', motivo: meta.motivo_snapshot ?? 'reiniciar' }];
  }
  return meta.hidrataciones.map((order_id) => ({ tipo: 'hidratar', order_id }));
}

function esUnidad(valor: unknown): valor is Unidad {
  return typeof valor === 'string' && (UNIDADES as readonly string[]).includes(valor);
}

function parsearValor(valor: unknown): unknown {
  if (typeof valor !== 'string') {
    return valor;
  }
  try {
    return JSON.parse(valor) as unknown;
  } catch {
    return valor;
  }
}

/**
 * Aplica un `upsert`. Devuelve `null` si se ignoró, o las entidades a recalcular. Se copian solo los
 * campos conocidos (nunca se mezcla un `user_id` del servidor con el de la partición).
 */
async function aplicarUpsert(
  userId: string,
  { entidad, id, datos }: EntidadSync,
  ahora: string,
): Promise<EntidadAfectada[] | null> {
  if (!esObjeto(datos)) {
    return null;
  }
  switch (entidad) {
    case 'consumptions':
      return esConsumo(datos) ? [await upsertConsumo(userId, datos, 'pull', ahora)] : null;
    case 'incidents': {
      if (!esNovedad(datos)) {
        return null;
      }
      const afectadas = [await upsertNovedad(userId, datos, 'pull', ahora)];
      if (Array.isArray(datos.evidencias)) {
        for (const e of datos.evidencias as unknown[]) {
          if (esEvidencia(e)) {
            afectadas.push(await upsertEvidencia(userId, e, ahora));
          }
        }
      }
      return afectadas;
    }
    case 'evidences':
      return esEvidencia(datos) ? [await upsertEvidencia(userId, datos, ahora)] : null;
    case 'validations':
      return esValidacion(datos) ? [await upsertValidacion(userId, datos, 'pull', ahora)] : null;
    case 'production_orders': {
      if (!esOrden(datos)) {
        return null;
      }
      await db.ordenes.put({
        user_id: userId,
        id: datos.id,
        codigo: datos.codigo,
        linea: datos.linea,
        estado: datos.estado,
        fecha_inicio: datos.fecha_inicio ?? null,
        fecha_fin: datos.fecha_fin ?? null,
        creada_por: datos.creada_por,
        created_at: datos.created_at,
        updated_at: datos.updated_at,
        revocada: false,
      });
      return [];
    }
    case 'order_planned_materials': {
      const { order_id, material_id, cantidad_planeada, unidad } = datos;
      if (
        typeof order_id !== 'string' ||
        typeof material_id !== 'string' ||
        typeof cantidad_planeada !== 'number' ||
        !esUnidad(unidad)
      ) {
        return null;
      }
      await db.planeados.put({
        user_id: userId,
        id,
        order_id,
        material_id,
        cantidad_planeada,
        unidad,
      });
      return [];
    }
    case 'order_supervisors': {
      const { order_id, user_id: supervisorId, asignado_por, activo } = datos;
      if (typeof order_id !== 'string' || typeof supervisorId !== 'string') {
        return null;
      }
      await db.asignaciones.put({
        user_id: userId,
        id,
        order_id,
        supervisor_id: supervisorId,
        asignado_por: typeof asignado_por === 'string' ? asignado_por : null,
        activo: activo === undefined ? true : booleano(activo),
      });
      return [];
    }
    case 'materials':
      if (!esMaterial(datos)) {
        return null;
      }
      await db.materiales.put({
        user_id: userId,
        id: datos.id,
        codigo: datos.codigo,
        nombre: datos.nombre,
        unidad: datos.unidad,
        costo_unitario_cop: datos.costo_unitario_cop,
        activo: booleano(datos.activo),
      });
      return [];
    case 'settings': {
      const clave = typeof datos.clave === 'string' ? datos.clave : id;
      await db.settings.put({ user_id: userId, clave, valor: parsearValor(datos.valor) });
      return [];
    }
    case 'users': {
      if (typeof datos.id !== 'string' || typeof datos.nombre !== 'string') {
        return null;
      }
      // Solo lo necesario para mostrar nombres: sin correo (minimización de datos, Ley 1581).
      await db.usuarios.put({
        user_id: userId,
        id: datos.id,
        nombre: datos.nombre,
        rol: esRol(datos.rol) ? datos.rol : null,
        activo: datos.activo === undefined ? true : booleano(datos.activo),
      });
      return [];
    }
    default:
      return null;
  }
}

/** Cambio de época dentro de la transacción en curso. */
async function cambiarEpoca(
  userId: string,
  meta: MetaSync,
  epoca: string,
  ahora: string,
): Promise<number> {
  const { reencoladas, afectadas } = await reencolarAplicadas(userId, ahora);
  await reiniciarEstadoSincronizado(userId);
  await recalcular(userId, afectadas);
  await db.meta.put({
    ...meta,
    cursor: 0,
    epoca,
    ultimo_sync_at: ahora,
    requiere_snapshot: true,
    motivo_snapshot: 'epoca',
    hidrataciones: [],
  });
  return reencoladas;
}

/** Aplica una página de `/sync/pull` del usuario de la sesión. */
export async function aplicarCambios(
  userId: string,
  respuesta: SyncPullResponse,
): Promise<ResultadoAplicarCambios> {
  const r = syncPullResponseSchema.parse(respuesta);
  const ahora = ahoraIso();
  return db.transaction('rw', tablasDeDatos(), async () => {
    const meta = (await db.meta.get(userId)) ?? metaInicial(userId);

    if (meta.epoca !== null && meta.epoca !== r.epoca) {
      const reencoladas = await cambiarEpoca(userId, meta, r.epoca, ahora);
      return {
        acciones: [{ tipo: 'snapshot', motivo: 'epoca' }],
        cursor: 0,
        epoca: r.epoca,
        epoca_cambiada: true,
        aplicados: 0,
        ignorados: r.cambios.length,
        reencoladas,
      };
    }

    let aplicados = 0;
    let ignorados = 0;
    let reiniciar = false;
    const hidrataciones = new Set(meta.hidrataciones);
    const afectadas: EntidadAfectada[] = [];
    for (const cambio of r.cambios) {
      if (cambio.tipo === 'upsert') {
        const resultado = await aplicarUpsert(userId, cambio, ahora);
        if (resultado === null) {
          ignorados += 1;
        } else {
          aplicados += 1;
          afectadas.push(...resultado);
        }
      } else if (cambio.tipo === 'revocar') {
        afectadas.push(...(await revocarEntidad(userId, cambio.entidad, cambio.id)));
        aplicados += 1;
      } else if (cambio.tipo === 'hidratar') {
        if (cambio.entidad === 'production_orders') {
          hidrataciones.add(cambio.id);
        } else {
          ignorados += 1;
        }
      } else {
        reiniciar = true;
      }
    }
    await recalcular(userId, afectadas);

    if (reiniciar) {
      // Cambió el alcance del usuario (rol o reactivación): lo que ya no deba ver se borra ahora;
      // el snapshot completo trae lo que sí ve.
      await reiniciarEstadoSincronizado(userId);
    }
    const nueva: MetaSync = {
      ...meta,
      cursor: r.cursor,
      epoca: r.epoca,
      ultimo_sync_at: ahora,
      requiere_snapshot: meta.requiere_snapshot || reiniciar,
      motivo_snapshot: meta.requiere_snapshot
        ? meta.motivo_snapshot
        : reiniciar
          ? 'reiniciar'
          : null,
      hidrataciones: reiniciar ? [] : [...hidrataciones],
    };
    await db.meta.put(nueva);
    return {
      acciones: accionesDe(nueva),
      cursor: r.cursor,
      epoca: r.epoca,
      epoca_cambiada: false,
      aplicados,
      ignorados,
      reencoladas: 0,
    };
  });
}

/**
 * Aplica entidades de una página de snapshot (como `upsert`), sin tocar el cursor. El motor llama a
 * `completarSnapshot` o `completarHidratacion` al terminar la última página.
 */
export async function aplicarEntidades(
  userId: string,
  entidades: readonly EntidadSync[],
): Promise<{ aplicados: number; ignorados: number }> {
  const ahora = ahoraIso();
  return db.transaction('rw', tablasDeDatos(), async () => {
    let aplicados = 0;
    let ignorados = 0;
    const afectadas: EntidadAfectada[] = [];
    for (const entidad of entidades) {
      const resultado = await aplicarUpsert(userId, entidad, ahora);
      if (resultado === null) {
        ignorados += 1;
      } else {
        aplicados += 1;
        afectadas.push(...resultado);
      }
    }
    await recalcular(userId, afectadas);
    return { aplicados, ignorados };
  });
}

/**
 * Cierra un snapshot completo: guarda su cursor (`MAX(seq)` leído antes del estado, ADR 0005 regla
 * 7) y su época. Si la época cambió mientras tanto, reinicia de nuevo y pide otro snapshot.
 */
export async function completarSnapshot(
  userId: string,
  snapshot: { cursor: number; epoca: string },
): Promise<AccionMotor[]> {
  const ahora = ahoraIso();
  return db.transaction('rw', tablasDeDatos(), async () => {
    const meta = (await db.meta.get(userId)) ?? metaInicial(userId);
    if (meta.epoca !== null && meta.epoca !== snapshot.epoca) {
      await cambiarEpoca(userId, meta, snapshot.epoca, ahora);
      return [{ tipo: 'snapshot', motivo: 'epoca' }];
    }
    await db.meta.put({
      ...meta,
      cursor: snapshot.cursor,
      epoca: snapshot.epoca,
      ultimo_sync_at: ahora,
      requiere_snapshot: false,
      motivo_snapshot: null,
      hidrataciones: [],
    });
    return [];
  });
}

/** Cierra la hidratación de una orden (su snapshot ya se aplicó con `aplicarEntidades`). */
export async function completarHidratacion(userId: string, orderId: string): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    const meta = await db.meta.get(userId);
    if (meta !== undefined) {
      await db.meta.put({
        ...meta,
        hidrataciones: meta.hidrataciones.filter((id) => id !== orderId),
      });
    }
  });
}

/** Estado de sync del usuario (cursor, época y acciones pendientes). */
export async function leerMetaSync(
  userId: string,
): Promise<MetaSync & { acciones: AccionMotor[] }> {
  const meta = (await db.meta.get(userId)) ?? metaInicial(userId);
  return { ...meta, acciones: accionesDe(meta) };
}

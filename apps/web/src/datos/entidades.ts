// Escritura de entidades del servidor en la partición local, revocación de visibilidad y reinicio
// del estado sincronizado. Se usa desde los resultados del push (`modo = 'propio'`) y desde el pull
// (`modo = 'pull'`).
//
// Regla: en modo `pull`, el estado del servidor NUNCA pisa una entidad con mutaciones propias en cola;
// se guarda en `servidor_diferido` y se adopta cuando la cola de esa entidad se vacía. En modo
// `propio` (respuesta a una mutación propia ya aplicada) se adopta directamente, porque es el estado
// sobre el que se calcularon las mutaciones que siguen en la cola.
//
// Deben llamarse DENTRO de una transacción `rw` sobre `tablasDeDatos()`.

import {
  diaBogota,
  type Consumo,
  type Evidencia,
  type Novedad,
  type Validacion,
} from '@catmetal/shared';
import { db, rangoDe } from './db';
import { camposDe, entidadTieneCola, estaEnCola, evidenciaProtegida, leerClave } from './derivar';
import { booleano, masReciente, type EntidadesServidor } from './servidor';
import type { ConsumoLocal, TablaMutable } from './tipos';

export type ModoServidor = 'propio' | 'pull';

export interface EntidadAfectada {
  tabla: TablaMutable;
  id: string;
}

function consumoDesdeServidor(userId: string, s: Consumo, ahora: string): ConsumoLocal {
  return {
    user_id: userId,
    id: s.id,
    order_id: s.order_id,
    ...camposDe(s),
    corrige_a: s.corrige_a ?? null,
    registrado_por: s.registrado_por,
    client_created_at: s.client_created_at,
    dia_bogota: diaBogota(s.client_created_at),
    base_local: null,
    servidor: s,
    servidor_diferido: null,
    version: s.version,
    estado_local: 'sincronizado',
    ultimo_resultado: null,
    falta_novedad: false,
    requiere_novedad: booleano(s.requiere_novedad),
    registro_tardio: booleano(s.registro_tardio),
    motivo_rechazo: null,
    error_sync: null,
    conflicto_servidor: null,
    actualizado_at: ahora,
  };
}

export async function upsertConsumo(
  userId: string,
  s: Consumo,
  modo: ModoServidor,
  ahora: string,
): Promise<EntidadAfectada> {
  const c = await db.consumos.get([userId, s.id]);
  // El servidor lo tiene: deja de estar por verificar o perdido tras una restauración.
  const confirmado = { verificar_en_snapshot: false, perdido_en_restauracion: false };
  if (c === undefined) {
    await db.consumos.add(consumoDesdeServidor(userId, s, ahora));
  } else if (modo === 'pull' && (await entidadTieneCola(userId, 'consumos', s.id))) {
    await db.consumos.put({
      ...c,
      ...confirmado,
      servidor_diferido: masReciente(c.servidor_diferido, s),
      actualizado_at: ahora,
    });
  } else {
    await db.consumos.put({
      ...c,
      ...confirmado,
      servidor: masReciente(c.servidor, s),
      actualizado_at: ahora,
    });
  }
  return { tabla: 'consumos', id: s.id };
}

/**
 * Tras un snapshot COMPLETO: los consumos propios que siguen por verificar (el servidor no los
 * devolvió) y no tienen mutaciones en cola se marcan `perdido_en_restauracion`. Devuelve sus ids.
 */
export async function marcarPerdidosTrasSnapshot(userId: string): Promise<string[]> {
  const consumos = await db.consumos
    .where(':id')
    .between(...rangoDe(userId))
    .filter((c) => c.verificar_en_snapshot === true)
    .toArray();
  const perdidos: string[] = [];
  for (const c of consumos) {
    const enCola = await entidadTieneCola(userId, 'consumos', c.id);
    await db.consumos.put({ ...c, verificar_en_snapshot: false, perdido_en_restauracion: !enCola });
    if (!enCola) {
      perdidos.push(c.id);
    }
  }
  return perdidos;
}

export async function upsertNovedad(
  userId: string,
  s: Novedad,
  modo: ModoServidor,
  ahora: string,
): Promise<EntidadAfectada> {
  const n = await db.novedades.get([userId, s.id]);
  if (n === undefined) {
    await db.novedades.add({
      user_id: userId,
      id: s.id,
      consumption_id: s.consumption_id,
      tipo: s.tipo,
      descripcion: s.descripcion,
      registrado_por: s.registrado_por,
      client_created_at: s.client_created_at,
      servidor: s,
      servidor_diferido: null,
      estado_local: 'sincronizado',
      ultimo_resultado: null,
      error_sync: null,
      actualizado_at: ahora,
    });
  } else if (modo === 'pull' && (await entidadTieneCola(userId, 'novedades', s.id))) {
    await db.novedades.put({ ...n, servidor_diferido: s, actualizado_at: ahora });
  } else {
    await db.novedades.put({ ...n, servidor: s, actualizado_at: ahora });
  }
  return { tabla: 'novedades', id: s.id };
}

export async function upsertValidacion(
  userId: string,
  s: Validacion,
  modo: ModoServidor,
  ahora: string,
): Promise<EntidadAfectada> {
  const v = await db.validaciones.get([userId, s.id]);
  if (v === undefined) {
    await db.validaciones.add({
      user_id: userId,
      id: s.id,
      consumption_id: s.consumption_id,
      decision: s.decision,
      motivo: s.motivo,
      validado_por: s.validado_por,
      client_created_at: s.client_created_at,
      servidor: s,
      servidor_diferido: null,
      estado_local: 'sincronizado',
      ultimo_resultado: null,
      error_sync: null,
      actualizado_at: ahora,
    });
  } else if (modo === 'pull' && (await entidadTieneCola(userId, 'validaciones', s.id))) {
    await db.validaciones.put({ ...v, servidor_diferido: s, actualizado_at: ahora });
  } else {
    await db.validaciones.put({ ...v, servidor: s, actualizado_at: ahora });
  }
  return { tabla: 'validaciones', id: s.id };
}

/** Los metadatos del servidor nunca borran los bytes locales de una foto. */
export async function upsertEvidencia(
  userId: string,
  s: Evidencia,
  ahora: string,
): Promise<EntidadAfectada> {
  const e = await db.evidencias.get([userId, s.id]);
  const subida = booleano(s.subido);
  if (e === undefined) {
    await db.evidencias.add({
      user_id: userId,
      id: s.id,
      incident_id: s.incident_id,
      mime: s.mime,
      tamano_bytes: s.tamano_bytes,
      sha256: s.sha256,
      datos: null,
      estado_subida: subida ? 'subida' : 'remota',
      intentos_subida: 0,
      siguiente_intento_at: null,
      error_subida: null,
      subido_at: s.subido_at ?? null,
      servidor: s,
      actualizado_at: ahora,
    });
  } else {
    await db.evidencias.put({
      ...e,
      servidor: s,
      estado_subida: subida ? 'subida' : e.estado_subida,
      subido_at: subida ? (s.subido_at ?? e.subido_at ?? ahora) : e.subido_at,
      actualizado_at: ahora,
    });
  }
  return { tabla: 'evidencias', id: s.id };
}

/** Guarda todas las entidades reconocidas en una respuesta del servidor. */
export async function guardarEntidadesServidor(
  userId: string,
  entidades: EntidadesServidor,
  modo: ModoServidor,
  ahora: string,
): Promise<EntidadAfectada[]> {
  const afectadas: EntidadAfectada[] = [];
  for (const s of entidades.consumos) {
    afectadas.push(await upsertConsumo(userId, s, modo, ahora));
  }
  for (const s of entidades.novedades) {
    afectadas.push(await upsertNovedad(userId, s, modo, ahora));
  }
  for (const s of entidades.evidencias) {
    afectadas.push(await upsertEvidencia(userId, s, ahora));
  }
  for (const s of entidades.validaciones) {
    afectadas.push(await upsertValidacion(userId, s, modo, ahora));
  }
  return afectadas;
}

// ---------------------------------------------------------------------------------------------
// Revocación y reinicio
// ---------------------------------------------------------------------------------------------

async function novedadProtegida(userId: string, id: string): Promise<boolean> {
  if (await entidadTieneCola(userId, 'novedades', id)) {
    return true;
  }
  const n = await db.novedades.get([userId, id]);
  if (n !== undefined && n.estado_local === 'rechazado_sync') {
    return true;
  }
  const fotos = await db.evidencias.where('[user_id+incident_id]').equals([userId, id]).toArray();
  return fotos.some(evidenciaProtegida);
}

/**
 * Un consumo que no se puede borrar del dispositivo: tiene mutaciones en cola (propias o de sus
 * novedades y validaciones), un rechazo o conflicto de sync sin resolver, fotos sin subir o, si
 * `conservarPropios`, fue registrado por el usuario (ADR 0005 regla 2: el supervisor sigue viendo
 * lo suyo aunque pierda la orden, y el servidor no se lo volvería a enviar).
 */
async function consumoProtegido(
  userId: string,
  c: ConsumoLocal,
  conservarPropios: boolean,
): Promise<boolean> {
  if (conservarPropios && c.registrado_por === userId) {
    return true;
  }
  if (c.estado_local === 'rechazado_sync' || c.estado_local === 'conflicto') {
    return true;
  }
  if (await entidadTieneCola(userId, 'consumos', c.id)) {
    return true;
  }
  const novedades = await db.novedades
    .where('[user_id+consumption_id]')
    .equals([userId, c.id])
    .primaryKeys();
  for (const [, id] of novedades) {
    if (await novedadProtegida(userId, id)) {
      return true;
    }
  }
  const validaciones = await db.validaciones
    .where('[user_id+consumption_id]')
    .equals([userId, c.id])
    .primaryKeys();
  for (const [, id] of validaciones) {
    if (await entidadTieneCola(userId, 'validaciones', id)) {
      return true;
    }
  }
  return false;
}

async function borrarNovedadConFotos(userId: string, id: string): Promise<void> {
  await db.evidencias.where('[user_id+incident_id]').equals([userId, id]).delete();
  await db.novedades.delete([userId, id]);
}

async function borrarConsumoConHijos(userId: string, id: string): Promise<void> {
  const novedades = await db.novedades
    .where('[user_id+consumption_id]')
    .equals([userId, id])
    .primaryKeys();
  for (const [, idNovedad] of novedades) {
    await borrarNovedadConFotos(userId, idNovedad);
  }
  await db.validaciones.where('[user_id+consumption_id]').equals([userId, id]).delete();
  await db.consumos.delete([userId, id]);
}

/** Revoca una orden: borra sus datos locales salvo los consumos protegidos (y los suyos). */
export async function revocarOrden(userId: string, orderId: string): Promise<void> {
  const consumos = await db.consumos
    .where('[user_id+order_id]')
    .equals([userId, orderId])
    .toArray();
  let conservados = 0;
  for (const c of consumos) {
    if (await consumoProtegido(userId, c, true)) {
      conservados += 1;
    } else {
      await borrarConsumoConHijos(userId, c.id);
    }
  }
  await db.planeados.where('[user_id+order_id]').equals([userId, orderId]).delete();
  await db.asignaciones.where('[user_id+order_id]').equals([userId, orderId]).delete();
  const orden = await db.ordenes.get([userId, orderId]);
  if (orden !== undefined) {
    if (conservados > 0) {
      await db.ordenes.put({ ...orden, revocada: true });
    } else {
      await db.ordenes.delete([userId, orderId]);
    }
  }
}

/**
 * Atiende un cambio `revocar`. Devuelve las entidades cuyo consumo hay que recalcular. Las entidades
 * desconocidas se ignoran.
 */
export async function revocarEntidad(
  userId: string,
  entidad: string,
  id: string,
): Promise<EntidadAfectada[]> {
  switch (entidad) {
    case 'production_orders':
      await revocarOrden(userId, id);
      return [];
    case 'consumptions': {
      const c = await db.consumos.get([userId, id]);
      if (c !== undefined && !(await consumoProtegido(userId, c, true))) {
        await borrarConsumoConHijos(userId, id);
      }
      return [];
    }
    case 'incidents': {
      const n = await db.novedades.get([userId, id]);
      if (n !== undefined && !(await novedadProtegida(userId, id))) {
        await borrarNovedadConFotos(userId, id);
        return [{ tabla: 'consumos', id: n.consumption_id }];
      }
      return [];
    }
    case 'evidences': {
      const e = await db.evidencias.get([userId, id]);
      if (e !== undefined && !evidenciaProtegida(e)) {
        await db.evidencias.delete([userId, id]);
      }
      return [];
    }
    case 'validations': {
      const v = await db.validaciones.get([userId, id]);
      if (v !== undefined && !(await entidadTieneCola(userId, 'validaciones', id))) {
        await db.validaciones.delete([userId, id]);
        return [{ tabla: 'consumos', id: v.consumption_id }];
      }
      return [];
    }
    case 'materials':
      await db.materiales.delete([userId, id]);
      return [];
    case 'users':
      await db.usuarios.delete([userId, id]);
      return [];
    case 'settings':
      await db.settings.delete([userId, id]);
      return [];
    case 'order_supervisors':
      await db.asignaciones.delete([userId, id]);
      return [];
    case 'order_planned_materials':
      await db.planeados.delete([userId, id]);
      return [];
    default:
      return [];
  }
}

/**
 * Borra el estado sincronizado del usuario antes de un snapshot completo (`reiniciar` o cambio de
 * época). Conserva todo lo protegido (cola, rechazos y conflictos, fotos sin subir) y TODOS los
 * consumos propios: los que no están en cola se marcan `verificar_en_snapshot` y, si el snapshot
 * completo no los devuelve, `marcarPerdidosTrasSnapshot` los marca `perdido_en_restauracion`
 * (ADR 0016, M1). No toca `meta` ni `outbox`.
 */
export async function reiniciarEstadoSincronizado(userId: string): Promise<void> {
  const rango = rangoDe(userId);
  for (const tabla of [
    db.ordenes,
    db.planeados,
    db.asignaciones,
    db.materiales,
    db.settings,
    db.usuarios,
  ]) {
    await tabla
      .where(':id')
      .between(...rango)
      .delete();
  }
  const consumos = await db.consumos
    .where(':id')
    .between(...rango)
    .toArray();
  for (const c of consumos) {
    if (c.registrado_por === userId) {
      // Lo propio NUNCA se borra aquí (ADR 0016, M1): si no está en cola, queda por verificar y el
      // snapshot completo decide si sigue en el servidor o se perdió en una restauración.
      if (!(await entidadTieneCola(userId, 'consumos', c.id))) {
        await db.consumos.put({ ...c, verificar_en_snapshot: true });
      }
    } else if (!(await consumoProtegido(userId, c, false))) {
      await borrarConsumoConHijos(userId, c.id);
    }
  }
  // Huérfanos (hijos cuyo consumo ya no está en la partición).
  const novedades = await db.novedades
    .where(':id')
    .between(...rango)
    .toArray();
  for (const n of novedades) {
    const tieneConsumo = (await db.consumos.get([userId, n.consumption_id])) !== undefined;
    if (!tieneConsumo && !(await novedadProtegida(userId, n.id))) {
      await borrarNovedadConFotos(userId, n.id);
    }
  }
  const validaciones = await db.validaciones
    .where(':id')
    .between(...rango)
    .toArray();
  for (const v of validaciones) {
    const tieneConsumo = (await db.consumos.get([userId, v.consumption_id])) !== undefined;
    if (!tieneConsumo && !(await entidadTieneCola(userId, 'validaciones', v.id))) {
      await db.validaciones.delete([userId, v.id]);
    }
  }
  const evidencias = await db.evidencias
    .where(':id')
    .between(...rango)
    .toArray();
  for (const e of evidencias) {
    const tieneNovedad = (await db.novedades.get([userId, e.incident_id])) !== undefined;
    if (!tieneNovedad && !evidenciaProtegida(e)) {
      await db.evidencias.delete([userId, e.id]);
    }
  }
}

/**
 * Tras un cambio de época (ADR 0009): las mutaciones `aplicada` conservadas vuelven a `pendiente`
 * para reenviarse (el servidor es idempotente por `mutation_id`), y las fotos ya subidas que aún
 * tienen bytes locales vuelven a `pendiente`. Devuelve las entidades a recalcular.
 */
export async function reencolarAplicadas(
  userId: string,
  ahora: string,
): Promise<{ reencoladas: number; afectadas: EntidadAfectada[] }> {
  const aplicadas = await db.outbox
    .where('[user_id+estado+seq_local]')
    .between(...rangoDe(userId, 'aplicada'))
    .toArray();
  const afectadas: EntidadAfectada[] = [];
  for (const m of aplicadas) {
    if (m.user_id !== userId || estaEnCola(m.estado)) {
      continue;
    }
    await db.outbox.put({
      ...m,
      estado: 'pendiente',
      aplicada_at: null,
      siguiente_intento_at: null,
      error: null,
      actualizada_at: ahora,
    });
    for (const clave of m.claves) {
      const leida = leerClave(clave);
      if (leida !== null) {
        afectadas.push(leida);
      }
    }
  }
  const subidas = await db.evidencias
    .where('[user_id+estado_subida]')
    .equals([userId, 'subida'])
    .toArray();
  for (const e of subidas) {
    if (e.datos !== null) {
      await db.evidencias.put({
        ...e,
        estado_subida: 'pendiente',
        siguiente_intento_at: null,
        actualizado_at: ahora,
      });
    }
  }
  return { reencoladas: aplicadas.length, afectadas };
}

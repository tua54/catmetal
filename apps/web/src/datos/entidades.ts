// Escritura de entidades del servidor en la partición local y revocación de visibilidad. El reemplazo
// del estado tras un snapshot completo está en `snapshot-temporal.ts` (ADR 0022).
//
// Modos (ADR 0022, punto 5):
// - `pull` (pull e hidratación): el estado del servidor NUNCA pisa una entidad con mutaciones propias
//   en cola; se guarda en `servidor_diferido` y se adopta cuando la cola se vacía. Sin cola, se queda
//   el más reciente (misma época).
// - `propio` (respuesta `aplicada` a una mutación propia): se adopta directamente (es el estado sobre
//   el que se calcularon las mutaciones que siguen en la cola), el más reciente salvo que `servidor`
//   esté obsoleto.
// - `actual` (respuesta `conflicto` o `rechazada` con el estado actual del servidor): se adopta SIN
//   comparar versiones; el servidor acaba de leerlo (M6).
// - `autoridad` (reemplazo del snapshot tras `reiniciar` o cambio de época): sin cola, el servidor
//   reemplaza la copia local aunque su versión sea menor; con cola, va a `servidor_diferido` y
//   `servidor` queda `servidor_obsoleto` (base de la cola, pero ya no comparable).
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
import {
  camposDe,
  consumoDerivado,
  entidadTieneCola,
  estaEnCola,
  evidenciaProtegida,
  leerClave,
} from './derivar';
import { adoptarServidor, booleano, masReciente, type EntidadesServidor } from './servidor';
import type { ConsumoLocal, TablaMutable } from './tipos';

export type ModoServidor = 'propio' | 'pull' | 'actual' | 'autoridad';

/** Campos de estado del servidor que escribe un upsert (comunes a consumos, novedades y validaciones). */
interface EstadoServidor<T> {
  servidor: T | null;
  servidor_diferido: T | null;
  servidor_obsoleto?: boolean;
}

/**
 * Aplica la regla del modo (ver cabecera) a los campos de estado del servidor de una fila existente.
 * `servidor_obsoleto` solo se escribe si cambia o ya existía (las filas anteriores no lo tienen).
 */
async function nuevoEstadoServidor<T extends { version?: number; updated_at?: string }>(
  fila: EstadoServidor<T>,
  s: T,
  modo: ModoServidor,
  tieneCola: () => Promise<boolean>,
  comparar: boolean,
): Promise<EstadoServidor<T>> {
  const obsoleto = fila.servidor_obsoleto === true;
  const limpiar = obsoleto ? { servidor_obsoleto: false } : {};
  const elegir = (actual: T | null): T => (comparar ? (masReciente(actual, s) ?? s) : s);
  switch (modo) {
    case 'pull':
      if (await tieneCola()) {
        return { servidor: fila.servidor, servidor_diferido: elegir(fila.servidor_diferido) };
      }
      return {
        servidor: comparar ? adoptarServidor(fila.servidor, obsoleto, s) : s,
        servidor_diferido: fila.servidor_diferido,
        ...limpiar,
      };
    case 'propio':
      return {
        servidor: comparar ? adoptarServidor(fila.servidor, obsoleto, s) : s,
        servidor_diferido: fila.servidor_diferido,
        ...limpiar,
      };
    case 'actual':
      return { servidor: s, servidor_diferido: fila.servidor_diferido, ...limpiar };
    case 'autoridad':
      if (await tieneCola()) {
        return { servidor: fila.servidor, servidor_diferido: s, servidor_obsoleto: true };
      }
      return { servidor: s, servidor_diferido: null, ...limpiar };
  }
}

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
  // En el reemplazo del snapshot la vista se deriva antes de escribir: una sola escritura por
  // consumo en la transacción larga (ADR 0022, duración del reemplazo).
  const escribir = async (fila: ConsumoLocal): Promise<void> => {
    await db.consumos.put(modo === 'autoridad' ? await consumoDerivado(userId, fila) : fila);
  };
  if (c === undefined) {
    if (modo === 'autoridad') {
      await escribir(consumoDesdeServidor(userId, s, ahora));
    } else {
      await db.consumos.add(consumoDesdeServidor(userId, s, ahora));
    }
  } else {
    const estado = await nuevoEstadoServidor(
      c,
      s,
      modo,
      () => entidadTieneCola(userId, 'consumos', s.id),
      true,
    );
    await escribir({ ...c, ...confirmado, ...estado, actualizado_at: ahora });
  }
  return { tabla: 'consumos', id: s.id };
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
  } else {
    const estado = await nuevoEstadoServidor(
      n,
      s,
      modo,
      () => entidadTieneCola(userId, 'novedades', s.id),
      false,
    );
    await db.novedades.put({ ...n, ...estado, actualizado_at: ahora });
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
  } else {
    const estado = await nuevoEstadoServidor(
      v,
      s,
      modo,
      () => entidadTieneCola(userId, 'validaciones', s.id),
      false,
    );
    await db.validaciones.put({ ...v, ...estado, actualizado_at: ahora });
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
// Revocación y reencolado tras un cambio de época
// ---------------------------------------------------------------------------------------------

export async function novedadProtegida(userId: string, id: string): Promise<boolean> {
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
export async function consumoProtegido(
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

export async function borrarNovedadConFotos(userId: string, id: string): Promise<void> {
  await db.evidencias.where('[user_id+incident_id]').equals([userId, id]).delete();
  await db.novedades.delete([userId, id]);
}

export async function borrarConsumoConHijos(userId: string, id: string): Promise<void> {
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

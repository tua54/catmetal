// Derivación del estado local de las entidades a partir de: el último estado del servidor, la base
// local de la creación, las mutaciones propias aún en cola y el último resultado de sync.
//
// La vista local se RECALCULA (no se parchea): `servidor` (o `base_local` si el servidor aún no la
// conoce) + las ediciones en cola, en orden. Así, una edición rechazada desaparece sola de la vista y
// una actualización del servidor nunca pisa lo que el usuario tiene pendiente de enviar.
//
// Todas estas funciones deben llamarse DENTRO de una transacción de Dexie que incluya las tablas que
// tocan (`tablasDeDatos()`).

import { diaBogota, type EstadoOutbox, type Consumo } from '@catmetal/shared';
import { claveEntidad, db, rangoDe } from './db';
import { booleano, masReciente } from './servidor';
import type {
  CamposConsumo,
  ConsumoLocal,
  EstadoLocal,
  EstadoLocalSimple,
  ErrorSync,
  EvidenciaLocal,
  MutacionOutbox,
  TablaMutable,
  UltimoResultado,
} from './tipos';

/** Estados de una mutación que todavía debe llegar al servidor. */
export const ESTADOS_EN_COLA: readonly EstadoOutbox[] = ['pendiente', 'enviando'];

export function estaEnCola(estado: EstadoOutbox): boolean {
  return ESTADOS_EN_COLA.includes(estado);
}

function porSeq(a: MutacionOutbox, b: MutacionOutbox): number {
  return a.seq_local - b.seq_local;
}

/** Mutaciones en cola (pendiente o enviando) del usuario, en orden de envío. */
export async function mutacionesEnColaDeUsuario(userId: string): Promise<MutacionOutbox[]> {
  const pendientes = await db.outbox
    .where('[user_id+estado+seq_local]')
    .between(...rangoDe(userId, 'pendiente'))
    .toArray();
  const enviando = await db.outbox
    .where('[user_id+estado+seq_local]')
    .between(...rangoDe(userId, 'enviando'))
    .toArray();
  return [...pendientes, ...enviando].sort(porSeq);
}

/** Mutaciones en cola del usuario que afectan a la entidad, en orden. */
export async function mutacionesEnColaDeEntidad(
  userId: string,
  tabla: TablaMutable,
  id: string,
): Promise<MutacionOutbox[]> {
  const filas = await db.outbox
    .where('claves')
    .equals(claveEntidad(userId, tabla, id))
    .toArray();
  return filas.filter((m) => m.user_id === userId && estaEnCola(m.estado)).sort(porSeq);
}

export async function entidadTieneCola(
  userId: string,
  tabla: TablaMutable,
  id: string,
): Promise<boolean> {
  return (await mutacionesEnColaDeEntidad(userId, tabla, id)).length > 0;
}

/** Una foto con bytes locales que el servidor aún no tiene (o nunca tendrá): dato de planta. */
export function evidenciaProtegida(e: EvidenciaLocal): boolean {
  return e.datos !== null && (e.estado_subida === 'pendiente' || e.estado_subida === 'bloqueada');
}

export function camposDe(origen: CamposConsumo): CamposConsumo {
  return {
    material_id: origen.material_id,
    cantidad: origen.cantidad,
    unidad: origen.unidad,
    lote: origen.lote,
  };
}

function aplicarEdicion(
  campos: CamposConsumo,
  m: Extract<MutacionOutbox, { tipo: 'consumo.editar' }>,
): CamposConsumo {
  const p = m.payload;
  return {
    material_id: p.material_id ?? campos.material_id,
    cantidad: p.cantidad ?? campos.cantidad,
    unidad: p.unidad ?? campos.unidad,
    lote: p.lote ?? campos.lote,
  };
}

/** El aviso de la última mutación resuelta (rechazo o conflicto), si sigue vigente. */
function avisoVigente(
  ultimo: UltimoResultado | null,
  versionServidor: number | null,
): UltimoResultado | null {
  if (ultimo === null || ultimo.resultado === 'aplicada') {
    return null;
  }
  const vigente =
    versionServidor === null ||
    ultimo.version_servidor === null ||
    versionServidor <= ultimo.version_servidor;
  return vigente ? ultimo : null;
}

function estadoPorAviso(ultimo: UltimoResultado): 'rechazado_sync' | 'conflicto' {
  return ultimo.resultado === 'rechazada' ? 'rechazado_sync' : 'conflicto';
}

/** Recalcula la vista local de un consumo de la partición. No hace nada si no existe. */
export async function recalcularConsumo(userId: string, id: string): Promise<void> {
  const c = await db.consumos.get([userId, id]);
  if (c === undefined) {
    return;
  }
  const cola = await mutacionesEnColaDeEntidad(userId, 'consumos', id);
  let servidor: Consumo | null = c.servidor;
  let diferido: Consumo | null = c.servidor_diferido;
  if (cola.length === 0 && diferido !== null) {
    servidor = masReciente(servidor, diferido);
    diferido = null;
  }

  let campos = servidor !== null ? camposDe(servidor) : camposDe(c.base_local ?? c);
  for (const m of cola) {
    if (m.tipo === 'consumo.editar') {
      campos = aplicarEdicion(campos, m);
    }
  }

  const validaciones = (
    await db.validaciones.where('[user_id+consumption_id]').equals([userId, id]).toArray()
  ).filter((v) => v.estado_local !== 'rechazado_sync');
  const validacion = validaciones.find((v) => v.servidor !== null) ?? validaciones[0] ?? null;
  const novedades = (
    await db.novedades.where('[user_id+consumption_id]').equals([userId, id]).toArray()
  ).filter((n) => n.estado_local !== 'rechazado_sync');

  const versionServidor = servidor?.version ?? null;
  let estado: EstadoLocal;
  let errorSync: ErrorSync | null = null;
  const aviso = avisoVigente(c.ultimo_resultado, versionServidor);
  if (cola.length > 0) {
    estado = 'pendiente_sync';
  } else if (aviso !== null) {
    estado = estadoPorAviso(aviso);
    errorSync = aviso.error;
  } else if (servidor === null) {
    estado = c.ultimo_resultado?.resultado === 'aplicada' ? 'sincronizado' : 'pendiente_sync';
  } else if (servidor.estado === 'aprobado' || servidor.estado === 'rechazado') {
    estado = servidor.estado;
  } else if (validacion?.servidor) {
    // La validación llegó antes que el consumo actualizado: la decisión es definitiva.
    estado = validacion.decision;
  } else {
    estado = 'sincronizado';
  }

  const requiereNovedad = booleano(servidor?.requiere_novedad);
  const clientCreatedAt = servidor?.client_created_at ?? c.client_created_at;
  const actualizado: ConsumoLocal = {
    ...c,
    ...campos,
    order_id: servidor?.order_id ?? c.order_id,
    corrige_a: servidor !== null ? (servidor.corrige_a ?? null) : c.corrige_a,
    registrado_por: servidor?.registrado_por ?? c.registrado_por,
    client_created_at: clientCreatedAt,
    dia_bogota: diaBogota(clientCreatedAt),
    servidor,
    servidor_diferido: diferido,
    version: versionServidor,
    estado_local: estado,
    requiere_novedad: requiereNovedad,
    registro_tardio: booleano(servidor?.registro_tardio),
    falta_novedad: requiereNovedad && novedades.length === 0,
    motivo_rechazo: validacion?.decision === 'rechazado' ? validacion.motivo : null,
    error_sync: errorSync,
    conflicto_servidor: estado === 'conflicto' ? c.conflicto_servidor : null,
  };
  await db.consumos.put(actualizado);
}

function estadoSimple(
  enCola: boolean,
  ultimo: UltimoResultado | null,
  tieneServidor: boolean,
): EstadoLocalSimple {
  if (enCola) {
    return 'pendiente_sync';
  }
  if (!tieneServidor && ultimo !== null && ultimo.resultado !== 'aplicada') {
    return estadoPorAviso(ultimo);
  }
  return tieneServidor || ultimo?.resultado === 'aplicada' ? 'sincronizado' : 'pendiente_sync';
}

export async function recalcularNovedad(userId: string, id: string): Promise<void> {
  const n = await db.novedades.get([userId, id]);
  if (n === undefined) {
    return;
  }
  const enCola = await entidadTieneCola(userId, 'novedades', id);
  let servidor = n.servidor;
  let diferido = n.servidor_diferido;
  if (!enCola && diferido !== null) {
    servidor = masReciente(servidor, diferido);
    diferido = null;
  }
  const estado = estadoSimple(enCola, n.ultimo_resultado, servidor !== null);
  await db.novedades.put({
    ...n,
    ...(servidor !== null
      ? {
          consumption_id: servidor.consumption_id,
          tipo: servidor.tipo,
          descripcion: servidor.descripcion,
          registrado_por: servidor.registrado_por,
          client_created_at: servidor.client_created_at,
        }
      : {}),
    servidor,
    servidor_diferido: diferido,
    estado_local: estado,
    error_sync:
      estado === 'rechazado_sync' || estado === 'conflicto'
        ? (n.ultimo_resultado?.error ?? null)
        : null,
  });
}

export async function recalcularValidacion(userId: string, id: string): Promise<void> {
  const v = await db.validaciones.get([userId, id]);
  if (v === undefined) {
    return;
  }
  const enCola = await entidadTieneCola(userId, 'validaciones', id);
  let servidor = v.servidor;
  let diferido = v.servidor_diferido;
  if (!enCola && diferido !== null) {
    servidor = masReciente(servidor, diferido);
    diferido = null;
  }
  const estado = estadoSimple(enCola, v.ultimo_resultado, servidor !== null);
  await db.validaciones.put({
    ...v,
    ...(servidor !== null
      ? {
          consumption_id: servidor.consumption_id,
          decision: servidor.decision,
          motivo: servidor.motivo,
          validado_por: servidor.validado_por,
          client_created_at: servidor.client_created_at,
        }
      : {}),
    servidor,
    servidor_diferido: diferido,
    estado_local: estado,
    error_sync:
      estado === 'rechazado_sync' || estado === 'conflicto'
        ? (v.ultimo_resultado?.error ?? null)
        : null,
  });
}

/**
 * Recalcula las entidades indicadas y, después, los consumos de los que dependen (la vista de un
 * consumo depende de sus novedades y validaciones).
 */
export async function recalcular(
  userId: string,
  entidades: Iterable<{ tabla: TablaMutable; id: string }>,
): Promise<void> {
  const consumos = new Set<string>();
  for (const { tabla, id } of entidades) {
    if (tabla === 'novedades') {
      await recalcularNovedad(userId, id);
      const n = await db.novedades.get([userId, id]);
      if (n !== undefined) {
        consumos.add(n.consumption_id);
      }
    } else if (tabla === 'validaciones') {
      await recalcularValidacion(userId, id);
      const v = await db.validaciones.get([userId, id]);
      if (v !== undefined) {
        consumos.add(v.consumption_id);
      }
    } else if (tabla === 'consumos') {
      consumos.add(id);
    }
  }
  for (const id of consumos) {
    await recalcularConsumo(userId, id);
  }
}

/** Separa una clave `user_id|tabla|id` de `outbox.claves`. */
export function leerClave(clave: string): { tabla: TablaMutable; id: string } | null {
  const [, tabla, id] = clave.split('|');
  if (
    id === undefined ||
    (tabla !== 'consumos' &&
      tabla !== 'novedades' &&
      tabla !== 'evidencias' &&
      tabla !== 'validaciones')
  ) {
    return null;
  }
  return { tabla, id };
}

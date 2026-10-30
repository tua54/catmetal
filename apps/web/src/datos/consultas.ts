// Lecturas de la partición local para la UI (siempre del usuario de la sesión).
//
// Son funciones asíncronas puras de lectura: `dexie-react-hooks` no está instalado, así que la Fase 4
// puede envolverlas con `liveQuery` de Dexie (núcleo) o con `useLiveQuery` si se agrega la librería.
// Todas consultan índices `[user_id+…]`: nunca recorren datos de otro usuario.

import {
  TOLERANCIA_PCT_DEFECTO,
  convertir,
  diaBogota,
  excedeTolerancia,
  redondear6,
  type Unidad,
} from '@catmetal/shared';
import { db, rangoDe } from './db';
import type {
  ConsumoLocal,
  EventoTrazabilidad,
  EvidenciaLocal,
  MutacionOutbox,
  NovedadLocal,
  OrdenLocal,
} from './tipos';

/** Más reciente primero; a igual instante, el id (UUID v7) mayor primero. */
function recientesPrimero(a: ConsumoLocal, b: ConsumoLocal): number {
  return b.client_created_at.localeCompare(a.client_created_at) || b.id.localeCompare(a.id);
}

/** "Registros del día": día calendario de Bogotá (§4). Por defecto, solo los propios. */
export async function registrosDelDia(
  userId: string,
  ahora: Date = new Date(),
  opciones: { soloPropios?: boolean } = {},
): Promise<ConsumoLocal[]> {
  const dia = diaBogota(ahora.toISOString());
  const filas = await db.consumos.where('[user_id+dia_bogota]').equals([userId, dia]).toArray();
  const soloPropios = opciones.soloPropios ?? true;
  return filas.filter((c) => !soloPropios || c.registrado_por === userId).sort(recientesPrimero);
}

/** Consumos de una orden con su estado local. */
export async function consumosDeOrden(userId: string, orderId: string): Promise<ConsumoLocal[]> {
  const filas = await db.consumos.where('[user_id+order_id]').equals([userId, orderId]).toArray();
  return filas.sort(recientesPrimero);
}

export async function consumoLocal(userId: string, id: string): Promise<ConsumoLocal | null> {
  return (await db.consumos.get([userId, id])) ?? null;
}

async function consumosEnEstado(
  userId: string,
  estados: readonly ConsumoLocal['estado_local'][],
): Promise<ConsumoLocal[]> {
  const filas: ConsumoLocal[] = [];
  for (const estado of estados) {
    filas.push(
      ...(await db.consumos.where('[user_id+estado_local]').equals([userId, estado]).toArray()),
    );
  }
  return filas.sort(recientesPrimero);
}

/** Consumos con mutaciones propias aún sin confirmar. */
export function consumosPendientesDeSync(userId: string): Promise<ConsumoLocal[]> {
  return consumosEnEstado(userId, ['pendiente_sync']);
}

/**
 * Consumos rechazados: por el jefe (`rechazado`, con `motivo_rechazo`) o por el servidor al
 * sincronizar (`rechazado_sync`, con `error_sync`). La UI ofrece crear un consumo corregido (S3).
 */
export function consumosRechazados(userId: string): Promise<ConsumoLocal[]> {
  return consumosEnEstado(userId, ['rechazado', 'rechazado_sync']);
}

/** Consumos en conflicto de versión, con `conflicto_servidor`. */
export function consumosEnConflicto(userId: string): Promise<ConsumoLocal[]> {
  return consumosEnEstado(userId, ['conflicto']);
}

/** Consumos con `requiere_novedad` y sin novedad ("Falta justificar la novedad"). */
export async function consumosSinNovedad(userId: string): Promise<ConsumoLocal[]> {
  const filas = await db.consumos
    .where(':id')
    .between(...rangoDe(userId))
    .toArray();
  return filas.filter((c) => c.falta_novedad).sort(recientesPrimero);
}

/** Mutaciones del usuario que el servidor rechazó o devolvió en conflicto (nunca se borran). */
export async function mutacionesConProblema(userId: string): Promise<MutacionOutbox[]> {
  const indice = '[user_id+estado+seq_local]';
  const rechazadas = await db.outbox
    .where(indice)
    .between(...rangoDe(userId, 'rechazada'))
    .toArray();
  const conflictos = await db.outbox
    .where(indice)
    .between(...rangoDe(userId, 'conflicto'))
    .toArray();
  return [...rechazadas, ...conflictos].sort((a, b) => a.seq_local - b.seq_local);
}

export async function novedadesDeConsumo(
  userId: string,
  consumoId: string,
): Promise<NovedadLocal[]> {
  const filas = await db.novedades
    .where('[user_id+consumption_id]')
    .equals([userId, consumoId])
    .toArray();
  return filas.sort((a, b) => a.client_created_at.localeCompare(b.client_created_at));
}

/** Metadatos de las fotos de una novedad (sin los bytes, para listar). */
export async function evidenciasDeNovedad(
  userId: string,
  incidentId: string,
): Promise<Omit<EvidenciaLocal, 'datos'>[]> {
  const filas = await db.evidencias
    .where('[user_id+incident_id]')
    .equals([userId, incidentId])
    .toArray();
  return filas.map((fila) => {
    const meta: Omit<EvidenciaLocal, 'datos'> & { datos?: ArrayBuffer | null } = { ...fila };
    delete meta.datos;
    return meta;
  });
}

/** Trazabilidad de este dispositivo del usuario, más reciente primero. */
export async function trazabilidadDelDispositivo(
  userId: string,
  limite = 50,
): Promise<EventoTrazabilidad[]> {
  return db.trazabilidad
    .where('[user_id+ts]')
    .between(...rangoDe(userId))
    .reverse()
    .limit(limite)
    .toArray();
}

function porCodigo(a: OrdenLocal, b: OrdenLocal): number {
  return a.codigo.localeCompare(b.codigo);
}

/** Órdenes en proceso visibles para el usuario (las revocadas no). */
export async function ordenesEnProceso(userId: string): Promise<OrdenLocal[]> {
  const filas = await db.ordenes.where('[user_id+estado]').equals([userId, 'en_proceso']).toArray();
  return filas.filter((o) => !o.revocada).sort(porCodigo);
}

/** Órdenes en proceso donde el usuario tiene una asignación activa (supervisor). */
export async function ordenesAsignadasEnProceso(userId: string): Promise<OrdenLocal[]> {
  const ordenes = await ordenesEnProceso(userId);
  const asignaciones = await db.asignaciones
    .where(':id')
    .between(...rangoDe(userId))
    .toArray();
  const asignadas = new Set(
    asignaciones.filter((a) => a.activo && a.supervisor_id === userId).map((a) => a.order_id),
  );
  return ordenes.filter((o) => asignadas.has(o.id));
}

/** Tolerancia vigente según los settings cacheados (S7); 5 % si no hay. */
export async function toleranciaLocal(userId: string): Promise<number> {
  const fila = await db.settings.get([userId, 'tolerancia_pct']);
  const valor: unknown = fila?.valor;
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return valor;
  }
  if (typeof valor === 'object' && valor !== null && 'tolerancia_pct' in valor) {
    const anidado: unknown = valor.tolerancia_pct;
    if (typeof anidado === 'number' && Number.isFinite(anidado)) {
      return anidado;
    }
  }
  return TOLERANCIA_PCT_DEFECTO;
}

export interface AvanceLocal {
  material_id: string;
  codigo: string | null;
  nombre: string | null;
  /** Unidad del plan. */
  unidad: Unidad;
  cantidad_planeada: number;
  /** Consumido local (no rechazado), convertido a la unidad del plan. */
  consumido: number;
  porcentaje: number;
  excede_tolerancia: boolean;
}

export interface ConsumoFueraDePlanLocal {
  material_id: string;
  codigo: string | null;
  nombre: string | null;
  unidad: Unidad;
  consumido: number;
}

export interface PlaneadoVsConsumidoLocal {
  order_id: string;
  tolerancia_pct: number;
  materiales: AvanceLocal[];
  fuera_de_plan: ConsumoFueraDePlanLocal[];
  /** Consumos cuya unidad no se puede convertir a la del plan (S11): no se suman. */
  incompatibles: number;
}

function cuentaComoConsumido(c: ConsumoLocal): boolean {
  return c.estado_local !== 'rechazado' && c.estado_local !== 'rechazado_sync';
}

/**
 * Planeado vs consumido con lo que ve ESTE dispositivo. Es orientativo: la autoridad de la
 * tolerancia es el servidor, porque offline no se ven los consumos de otros supervisores (§6).
 */
export async function planeadoVsConsumido(
  userId: string,
  orderId: string,
): Promise<PlaneadoVsConsumidoLocal> {
  const tolerancia = await toleranciaLocal(userId);
  const planeados = await db.planeados
    .where('[user_id+order_id]')
    .equals([userId, orderId])
    .toArray();
  const consumos = (
    await db.consumos.where('[user_id+order_id]').equals([userId, orderId]).toArray()
  ).filter(cuentaComoConsumido);
  const materiales = new Map(
    (
      await db.materiales
        .where(':id')
        .between(...rangoDe(userId))
        .toArray()
    ).map((m) => [m.id, m]),
  );

  let incompatibles = 0;
  const avance: AvanceLocal[] = planeados.map((plan) => {
    let consumido = 0;
    for (const c of consumos) {
      if (c.material_id !== plan.material_id) {
        continue;
      }
      const convertida = convertir(c.cantidad, c.unidad, plan.unidad);
      if (convertida === null) {
        incompatibles += 1;
      } else {
        consumido = redondear6(consumido + convertida);
      }
    }
    const material = materiales.get(plan.material_id);
    return {
      material_id: plan.material_id,
      codigo: material?.codigo ?? null,
      nombre: material?.nombre ?? null,
      unidad: plan.unidad,
      cantidad_planeada: plan.cantidad_planeada,
      consumido,
      porcentaje:
        plan.cantidad_planeada > 0
          ? Number(((consumido / plan.cantidad_planeada) * 100).toFixed(2))
          : 0,
      excede_tolerancia: excedeTolerancia({
        planeada: plan.cantidad_planeada,
        consumidaAcumulada: consumido,
        toleranciaPct: tolerancia,
      }),
    };
  });

  const enPlan = new Set(planeados.map((p) => p.material_id));
  const fuera = new Map<string, ConsumoFueraDePlanLocal>();
  for (const c of consumos) {
    if (enPlan.has(c.material_id)) {
      continue;
    }
    const material = materiales.get(c.material_id);
    const unidad = material?.unidad ?? c.unidad;
    const convertida = convertir(c.cantidad, c.unidad, unidad);
    if (convertida === null) {
      incompatibles += 1;
      continue;
    }
    const actual = fuera.get(c.material_id) ?? {
      material_id: c.material_id,
      codigo: material?.codigo ?? null,
      nombre: material?.nombre ?? null,
      unidad,
      consumido: 0,
    };
    actual.consumido = redondear6(actual.consumido + convertida);
    fuera.set(c.material_id, actual);
  }

  return {
    order_id: orderId,
    tolerancia_pct: tolerancia,
    materiales: avance,
    fuera_de_plan: [...fuera.values()],
    incompatibles,
  };
}

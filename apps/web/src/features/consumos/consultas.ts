// Lecturas de Dexie para las pantallas del supervisor (siempre de la partición del usuario de la
// sesión). Componen las consultas de `src/datos`; se usan con `useConsultaLocal` (liveQuery).

import {
  ordenesAsignadasEnProceso,
  planeadoVsConsumido,
  registrosDelDia,
  trazabilidadDelDispositivo,
  type ConsumoLocal,
  type EventoTrazabilidad,
  type MaterialLocal,
  type OrdenLocal,
  type PlaneadoVsConsumidoLocal,
} from '../../datos';
import { db, rangoDe } from '../../datos/db';

/** Todos los materiales del catálogo local (los inactivos se usan para mostrar nombres). */
export async function materialesLocales(userId: string): Promise<Map<string, MaterialLocal>> {
  const filas = await db.materiales
    .where(':id')
    .between(...rangoDe(userId))
    .toArray();
  return new Map(filas.map((m) => [m.id, m]));
}

export async function ordenLocal(userId: string, orderId: string): Promise<OrdenLocal | null> {
  return (await db.ordenes.get([userId, orderId])) ?? null;
}

/** Avance global de una orden: promedio del porcentaje de cada material planeado (tope 100 %). */
export function avanceGlobal(avance: PlaneadoVsConsumidoLocal): number {
  if (avance.materiales.length === 0) {
    return 0;
  }
  const suma = avance.materiales.reduce((total, m) => total + Math.min(m.porcentaje, 100), 0);
  return Math.round(suma / avance.materiales.length);
}

export interface ResumenOrden {
  orden: OrdenLocal;
  avance: PlaneadoVsConsumidoLocal;
  porcentaje: number;
  materialesExcedidos: number;
}

/** "Mis órdenes en proceso": órdenes asignadas con su avance según esta tablet. */
export async function misOrdenes(userId: string): Promise<ResumenOrden[]> {
  const ordenes = await ordenesAsignadasEnProceso(userId);
  const resumenes: ResumenOrden[] = [];
  for (const orden of ordenes) {
    const avance = await planeadoVsConsumido(userId, orden.id);
    resumenes.push({
      orden,
      avance,
      porcentaje: avanceGlobal(avance),
      materialesExcedidos: avance.materiales.filter((m) => m.excede_tolerancia).length,
    });
  }
  return resumenes;
}

export interface DatosOrden {
  orden: OrdenLocal | null;
  avance: PlaneadoVsConsumidoLocal;
  materiales: Map<string, MaterialLocal>;
}

export async function datosDeOrden(userId: string, orderId: string): Promise<DatosOrden> {
  const [orden, avance, materiales] = await Promise.all([
    ordenLocal(userId, orderId),
    planeadoVsConsumido(userId, orderId),
    materialesLocales(userId),
  ]);
  return { orden, avance, materiales };
}

export interface RegistroDeHoy {
  consumo: ConsumoLocal;
  material: MaterialLocal | null;
  conNovedad: boolean;
}

/** "Registros de hoy — Orden …": consumos propios del día (Bogotá) en la orden. */
export async function registrosDeHoyDeOrden(
  userId: string,
  orderId: string,
  ahora: Date = new Date(),
): Promise<RegistroDeHoy[]> {
  const consumos = (await registrosDelDia(userId, ahora)).filter((c) => c.order_id === orderId);
  const materiales = await materialesLocales(userId);
  const conNovedad = new Set(
    (
      await db.novedades
        .where('[user_id+consumption_id]')
        .anyOf(consumos.map((c) => [userId, c.id]))
        .toArray()
    )
      .filter((n) => n.estado_local !== 'rechazado_sync')
      .map((n) => n.consumption_id),
  );
  return consumos.map((consumo) => ({
    consumo,
    material: materiales.get(consumo.material_id) ?? null,
    conNovedad: conNovedad.has(consumo.id),
  }));
}

/**
 * Consumos propios que el servidor perdió tras una restauración (`perdido_en_restauracion`, ADR
 * 0016): siguen en la tablet y se pueden enviar de nuevo con `reenviarPerdido`.
 */
export async function consumosPerdidos(userId: string): Promise<ConsumoLocal[]> {
  const filas = await db.consumos
    .where(':id')
    .between(...rangoDe(userId))
    .toArray();
  return filas
    .filter((c) => c.perdido_en_restauracion === true && c.registrado_por === userId)
    .sort((a, b) => b.client_created_at.localeCompare(a.client_created_at));
}

/** Nombre del material para la UI (el catálogo local puede no tenerlo todavía). */
export function nombreDeMaterial(registro: { material: MaterialLocal | null }): string {
  return registro.material?.nombre ?? 'Material sin catálogo local';
}

/** Un consumo propio con su material (formularios de edición y corrección). */
export async function consumoConMaterial(
  userId: string,
  consumoId: string,
): Promise<{ consumo: ConsumoLocal; material: MaterialLocal | null } | null> {
  const consumo = await db.consumos.get([userId, consumoId]);
  if (consumo === undefined) {
    return null;
  }
  const material = (await db.materiales.get([userId, consumo.material_id])) ?? null;
  return { consumo, material };
}

export function trazabilidadReciente(userId: string): Promise<EventoTrazabilidad[]> {
  return trazabilidadDelDispositivo(userId, 20);
}

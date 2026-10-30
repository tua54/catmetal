// Reportes de una orden (docs/spec.md §7 y §8 "Resumen de la orden"; docs/plan-fase-2.md 2.4).
//
// Permisos (los mismos para el resumen y el CSV): jefe y admin cualquier orden que exista; el
// supervisor solo las que tiene asignadas ACTIVAS (igual que `GET /orders/:id`). En su orden ya ve
// todos los consumos con su costo congelado (P9), así que el reporte no le expone nada nuevo. Lo
// demás → 404 (no se revela si la orden existe).
//
// Reglas de cálculo:
// - Solo cuentan los consumos NO rechazados (pendientes y aprobados), igual que el acumulado de la
//   tolerancia (S7) y el detalle de la orden.
// - Costo de un consumo (S12) = cantidad convertida a la unidad del MATERIAL × costo unitario
//   congelado (`costo_unitario_cop_snapshot`), redondeado a pesos. La conversión kg↔g y l↔ml se
//   hace en SQL con la misma regla de `convertir` (multiplicar o dividir por 1000 y redondear a 6
//   decimales). La unidad de un material no se edita (editarMaterialSchema), así que la unidad
//   actual es la del registro. Cambiar el costo del material después no cambia el reporte.
// - Todo se agrega en SQL (`total()`, `count()`), en un solo `db.batch()` de lectura (una foto
//   consistente), con 1 parámetro por sentencia.
//
// CSV: una fila por consumo, en lotes de `LOTE_CSV` filas por consulta paginando por `id` con el
// índice `consumptions_order_id_id`, y la respuesta va en streaming (no se arma todo en memoria).
// Límite: una invocación de Workers Paid admite 1000 consultas, así que el CSV de una orden admite
// hasta ~997 lotes (≈ 498.000 consumos); una orden real tiene órdenes de magnitud menos.

import {
  BOM_CSV,
  type CeldaCsv,
  type EstadoConsumo,
  excedeTolerancia,
  fechaHoraBogotaCsv,
  filaCsv,
  nombreArchivoCsv,
  redondear6,
  type ResumenMaterial,
  type ResumenMaterialFueraDePlan,
  type ResumenOrden,
  type Unidad,
} from '@catmetal/shared';
import { ErrorApi } from '../errores';
import { registrar } from '../log';
import type { Contexto } from './contexto';
import { buscarOrden, type FilaOrden } from './ordenes';
import { sentenciaLeerTolerancia, toleranciaDeResultado } from './settings';
import { puedeVerOrden } from './visibilidad';

/** Filas de consumo por consulta al exportar el CSV. */
export const LOTE_CSV = 500;

/** Orden visible para los reportes, o 404. */
async function ordenDeReporte(ctx: Contexto, id: string): Promise<FilaOrden> {
  const orden = (await puedeVerOrden(ctx, id)) ? await buscarOrden(ctx.db, id) : null;
  if (orden === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  return orden;
}

/**
 * Cantidad del consumo `c` en la unidad del material `m` (S11/S12), con la regla de `convertir`.
 * Unidades no convertibles (no deberían existir: el registro las rechaza) → NULL, y el costo de
 * ese consumo queda fuera del total en vez de inventarse.
 */
const CANTIDAD_EN_UNIDAD_MATERIAL = `CASE
    WHEN c.unidad = m.unidad THEN c.cantidad
    WHEN c.unidad = 'kg' AND m.unidad = 'g' THEN round(c.cantidad * 1000.0, 6)
    WHEN c.unidad = 'l' AND m.unidad = 'ml' THEN round(c.cantidad * 1000.0, 6)
    WHEN c.unidad = 'g' AND m.unidad = 'kg' THEN round(c.cantidad / 1000.0, 6)
    WHEN c.unidad = 'ml' AND m.unidad = 'l' THEN round(c.cantidad / 1000.0, 6)
  END`;

/** Costo del consumo en pesos (redondeado, S12). */
const COSTO_CONSUMO = `round((${CANTIDAD_EN_UNIDAD_MATERIAL}) * c.costo_unitario_cop_snapshot)`;

interface FilaPlaneado {
  material_id: string;
  codigo: string;
  nombre: string;
  unidad: Unidad;
  cantidad_planeada: number;
  consumido: number;
  costo: number;
  registros: number;
}

interface FilaFueraDePlan {
  material_id: string;
  codigo: string;
  nombre: string;
  unidad: Unidad;
  consumido: number;
  costo: number;
  registros: number;
}

interface FilaTotales {
  no_rechazados: number;
  pendientes: number;
  aprobados: number;
  rechazados: number;
  novedades_abiertas: number;
  novedades_faltantes: number;
}

/** `consumido / planeada × 100` con 2 decimales (`planeada > 0` por CHECK). */
function porcentaje(consumido: number, planeada: number): number {
  return Math.round((consumido / planeada) * 10_000) / 100;
}

/** `GET /reports/orders/:id/summary`. */
export async function resumenOrden(ctx: Contexto, id: string): Promise<ResumenOrden> {
  const orden = await ordenDeReporte(ctx, id);
  const [planeados, fuera, totales, tolerancia] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT p.material_id, m.codigo, m.nombre, p.unidad, p.cantidad_planeada,
           total(c.cantidad_en_unidad_plan) AS consumido,
           total(${COSTO_CONSUMO}) AS costo,
           count(c.id) AS registros
         FROM order_planned_materials AS p
         JOIN materials AS m ON m.id = p.material_id
         LEFT JOIN consumptions AS c
           ON c.order_id = p.order_id AND c.material_id = p.material_id
          AND c.estado <> 'rechazado'
         WHERE p.order_id = ?
         GROUP BY p.material_id, m.codigo, m.nombre, p.unidad, p.cantidad_planeada
         ORDER BY m.codigo, p.material_id`,
      )
      .bind(id),
    ctx.db
      .prepare(
        `SELECT c.material_id, m.codigo, m.nombre, m.unidad,
           total(c.cantidad_en_unidad_plan) AS consumido,
           total(${COSTO_CONSUMO}) AS costo,
           count(*) AS registros
         FROM consumptions AS c JOIN materials AS m ON m.id = c.material_id
         WHERE c.order_id = ? AND c.estado <> 'rechazado'
           AND NOT EXISTS (SELECT 1 FROM order_planned_materials AS p
                           WHERE p.order_id = c.order_id AND p.material_id = c.material_id)
         GROUP BY c.material_id, m.codigo, m.nombre, m.unidad
         ORDER BY m.codigo, c.material_id`,
      )
      .bind(id),
    ctx.db
      .prepare(
        `SELECT
           total(c.estado <> 'rechazado') AS no_rechazados,
           total(c.estado = 'pendiente') AS pendientes,
           total(c.estado = 'aprobado') AS aprobados,
           total(c.estado = 'rechazado') AS rechazados,
           total(c.estado = 'pendiente' AND (c.requiere_novedad = 1
             OR EXISTS (SELECT 1 FROM incidents AS i WHERE i.consumption_id = c.id)))
             AS novedades_abiertas,
           total(c.estado = 'pendiente' AND c.requiere_novedad = 1
             AND NOT EXISTS (SELECT 1 FROM incidents AS i WHERE i.consumption_id = c.id))
             AS novedades_faltantes
         FROM consumptions AS c WHERE c.order_id = ?`,
      )
      .bind(id),
    sentenciaLeerTolerancia(ctx.db),
  ]);
  const toleranciaPct = toleranciaDeResultado(tolerancia);
  const materiales: ResumenMaterial[] = ((planeados?.results ?? []) as FilaPlaneado[]).map(
    (fila) => {
      const consumido = redondear6(fila.consumido);
      return {
        material_id: fila.material_id,
        codigo: fila.codigo,
        nombre: fila.nombre,
        unidad: fila.unidad,
        cantidad_planeada: fila.cantidad_planeada,
        consumido,
        porcentaje: porcentaje(consumido, fila.cantidad_planeada),
        costo_cop: Math.round(fila.costo),
        registros: fila.registros,
        excede_tolerancia: excedeTolerancia({
          planeada: fila.cantidad_planeada,
          consumidaAcumulada: consumido,
          toleranciaPct,
        }),
      };
    },
  );
  const fueraDePlan: ResumenMaterialFueraDePlan[] = (
    (fuera?.results ?? []) as FilaFueraDePlan[]
  ).map((fila) => ({
    material_id: fila.material_id,
    codigo: fila.codigo,
    nombre: fila.nombre,
    unidad: fila.unidad,
    consumido: redondear6(fila.consumido),
    costo_cop: Math.round(fila.costo),
    registros: fila.registros,
  }));
  const t = (totales?.results[0] ?? {}) as Partial<FilaTotales>;
  const entero = (valor: number | undefined): number => Math.round(valor ?? 0);
  const costoTotal = [...materiales, ...fueraDePlan].reduce((suma, m) => suma + m.costo_cop, 0);
  return {
    order_id: orden.id,
    codigo: orden.codigo,
    linea: orden.linea,
    estado: orden.estado,
    fecha_inicio: orden.fecha_inicio,
    fecha_fin: orden.fecha_fin,
    tolerancia_pct: toleranciaPct,
    materiales,
    materiales_fuera_de_plan: fueraDePlan,
    totales: {
      materiales_consumidos: entero(t.no_rechazados),
      costo_total_cop: costoTotal,
      novedades_abiertas: entero(t.novedades_abiertas),
      novedades_faltantes: entero(t.novedades_faltantes),
      pendientes: entero(t.pendientes),
      aprobados: entero(t.aprobados),
      rechazados: entero(t.rechazados),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

export const ENCABEZADO_CSV = [
  'Orden',
  'Id consumo',
  'Fecha y hora de registro (Bogotá)',
  'Supervisor',
  'Código material',
  'Material',
  'Cantidad',
  'Unidad',
  'Cantidad en unidad del plan',
  'Unidad del plan',
  'Lote',
  'Costo unitario congelado (COP)',
  'Costo del consumo (COP)',
  'Estado',
  'Registro tardío',
  'Requiere novedad',
  'Con novedad',
  'Validado por',
  'Fecha de validación (Bogotá)',
  'Motivo de rechazo',
  'Corrige a',
] as const;

const ETIQUETA_ESTADO: Readonly<Record<EstadoConsumo, string>> = {
  pendiente: 'Pendiente',
  aprobado: 'Aprobado',
  rechazado: 'Rechazado',
};

interface FilaCsvConsumo {
  id: string;
  client_created_at: string;
  supervisor: string;
  material_codigo: string;
  material_nombre: string;
  cantidad: number;
  unidad: Unidad;
  cantidad_en_unidad_plan: number;
  unidad_plan: Unidad;
  lote: string;
  costo_unitario_cop_snapshot: number;
  costo: number | null;
  estado: EstadoConsumo;
  registro_tardio: number;
  requiere_novedad: number;
  con_novedad: number;
  validado_por: string | null;
  validado_at: string | null;
  motivo: string | null;
  corrige_a: string | null;
}

/**
 * Un lote de consumos de la orden con `id > cursor`, en orden de id (UUID v7: cronológico). La
 * validación es la única que puede tener un consumo (los triggers exigen `pendiente` para validar);
 * aun así se toma la más reciente para no duplicar filas.
 */
function sentenciaLoteCsv(db: D1Database, orderId: string, cursor: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT c.id, c.client_created_at, us.nombre AS supervisor,
         m.codigo AS material_codigo, m.nombre AS material_nombre,
         c.cantidad, c.unidad, c.cantidad_en_unidad_plan,
         COALESCE(p.unidad, m.unidad) AS unidad_plan,
         c.lote, c.costo_unitario_cop_snapshot, ${COSTO_CONSUMO} AS costo,
         c.estado, c.registro_tardio, c.requiere_novedad,
         EXISTS (SELECT 1 FROM incidents AS i WHERE i.consumption_id = c.id) AS con_novedad,
         uv.nombre AS validado_por, v.server_received_at AS validado_at, v.motivo, c.corrige_a
       FROM consumptions AS c
       JOIN materials AS m ON m.id = c.material_id
       JOIN users AS us ON us.id = c.registrado_por
       LEFT JOIN order_planned_materials AS p
         ON p.order_id = c.order_id AND p.material_id = c.material_id
       LEFT JOIN validations AS v ON v.id = (
         SELECT v2.id FROM validations AS v2 WHERE v2.consumption_id = c.id
         ORDER BY v2.server_received_at DESC, v2.id DESC LIMIT 1)
       LEFT JOIN users AS uv ON uv.id = v.validado_por
       WHERE c.order_id = ? AND c.id > ?
       ORDER BY c.id
       LIMIT ?`,
    )
    .bind(orderId, cursor, LOTE_CSV);
}

function celdas(codigoOrden: string, fila: FilaCsvConsumo): CeldaCsv[] {
  return [
    codigoOrden,
    fila.id,
    fechaHoraBogotaCsv(fila.client_created_at),
    fila.supervisor,
    fila.material_codigo,
    fila.material_nombre,
    fila.cantidad,
    fila.unidad,
    fila.cantidad_en_unidad_plan,
    fila.unidad_plan,
    fila.lote,
    fila.costo_unitario_cop_snapshot,
    fila.costo,
    ETIQUETA_ESTADO[fila.estado],
    fila.registro_tardio === 1,
    fila.requiere_novedad === 1,
    fila.con_novedad === 1,
    fila.validado_por,
    fechaHoraBogotaCsv(fila.validado_at),
    fila.motivo,
    fila.corrige_a,
  ];
}

export interface ExportacionCsv {
  nombreArchivo: string;
  cuerpo: ReadableStream<Uint8Array>;
}

/**
 * `GET /reports/orders/:id/export.csv`. Verifica permisos y lee el PRIMER lote antes de responder
 * (un error ahí es un error JSON normal); los lotes siguientes se leen a medida que el cliente
 * consume la respuesta. Si falla un lote posterior, la descarga se corta (queda registrado en el
 * log) en lugar de entregar un archivo que parezca completo.
 */
export async function exportarCsv(ctx: Contexto, id: string): Promise<ExportacionCsv> {
  const orden = await ordenDeReporte(ctx, id);
  const codificador = new TextEncoder();
  const primero = await sentenciaLoteCsv(ctx.db, id, '').all<FilaCsvConsumo>();
  // Lote ya leído y aún no escrito (el primero); después se lee uno nuevo en cada `pull`.
  let pendiente: FilaCsvConsumo[] | null = primero.results;
  let cursor = '';

  const cuerpo = new ReadableStream<Uint8Array>({
    start(controlador) {
      controlador.enqueue(codificador.encode(BOM_CSV + filaCsv(ENCABEZADO_CSV)));
    },
    async pull(controlador) {
      try {
        const lote: FilaCsvConsumo[] =
          pendiente ?? (await sentenciaLoteCsv(ctx.db, id, cursor).all<FilaCsvConsumo>()).results;
        pendiente = null;
        const ultima = lote.at(-1);
        if (ultima !== undefined) {
          controlador.enqueue(
            codificador.encode(lote.map((fila) => filaCsv(celdas(orden.codigo, fila))).join('')),
          );
          cursor = ultima.id;
        }
        if (lote.length < LOTE_CSV) {
          controlador.close();
        }
      } catch (error) {
        registrar('error', 'exportacion_csv_fallida', {
          error: error instanceof Error ? error.name : 'desconocido',
        });
        controlador.error(error);
      }
    },
  });
  return { nombreArchivo: nombreArchivoCsv(orden.codigo), cuerpo };
}

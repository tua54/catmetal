// Consumos de materia prima (docs/spec.md S3, S4, S7, S11, S12, §6; docs/plan-fase-2.md "Registro
// de consumo", "Unidades", "Costo", "Tolerancia", "Edición" y "Corrección"; ADR 0010; revisión H4).
//
// Los comandos `registrarConsumo` y `editarConsumo` leen, validan y devuelven un plan (no ejecutan
// nada). La sentencia principal va condicionada a TODO lo que se leyó y de lo que depende el
// resultado: estado de la orden, asignación del supervisor, material activo con el costo leído
// (snapshot S12) y el acumulado del material en la orden (tolerancia S7). Si otra petición cambió
// algo entretanto, la principal no aplica y `ejecutarConReintento` vuelve a leer y a armar el plan
// (máximo 3 intentos): así dos supervisores que registran a la vez nunca se saltan la tolerancia.
//
// Visibilidad: un supervisor que registra en una orden que no tiene asignada recibe 404
// `NO_ENCONTRADO`, igual que si no existiera (no se revela su existencia).

import {
  type Consumo,
  type ConsumoDetallado,
  convertir,
  type CrearConsumo,
  type EditarConsumo,
  type EstadoConsumo,
  type Evidencia,
  excedeTolerancia,
  LIMITE_PAGINA_DEFECTO,
  type ListaConsumos,
  type MimeEvidencia,
  type Novedad,
  type PaginacionQuery,
  sonConvertibles,
  tienePermiso,
  type Unidad,
  type Validacion,
} from '@catmetal/shared';
import { type CondicionSql, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import type { Contexto } from './contexto';
import { buscarMaterial, type FilaMaterial } from './materiales';
import { buscarOrden } from './ordenes';
import { ejecutarPlan, type PlanDeEscritura } from './plan';
import { sentenciaLeerTolerancia, toleranciaDeResultado } from './settings';
import { puedeVerConsumo, puedeVerOrden } from './visibilidad';

/** Intentos de un comando cuya sentencia principal no aplicó por una carrera (revisión H4). */
export const MAX_INTENTOS = 3;

/** Diferencia máxima entre el acumulado leído y el actual para considerarlo el mismo (coma flotante). */
const EPSILON_ACUMULADO = 0.000001;

export const COLUMNAS_CONSUMO =
  'id, order_id, material_id, cantidad, unidad, cantidad_en_unidad_plan, lote, costo_unitario_cop_snapshot, registrado_por, device_id, client_created_at, server_received_at, estado, corrige_a, registro_tardio, requiere_novedad, version, created_at, updated_at';

export interface FilaConsumo {
  id: string;
  order_id: string;
  material_id: string;
  cantidad: number;
  unidad: Unidad;
  cantidad_en_unidad_plan: number;
  lote: string;
  costo_unitario_cop_snapshot: number;
  registrado_por: string;
  device_id: string;
  client_created_at: string;
  server_received_at: string;
  estado: EstadoConsumo;
  corrige_a: string | null;
  registro_tardio: number;
  requiere_novedad: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export function consumoDe(fila: FilaConsumo): Consumo {
  return {
    ...fila,
    registro_tardio: fila.registro_tardio === 1,
    requiere_novedad: fila.requiere_novedad === 1,
  };
}

export async function buscarConsumo(db: D1Database, id: string): Promise<FilaConsumo | null> {
  return db
    .prepare(`SELECT ${COLUMNAS_CONSUMO} FROM consumptions WHERE id = ?`)
    .bind(id)
    .first<FilaConsumo>();
}

/**
 * Ejecuta un comando con reintento (revisión H4): si la sentencia principal no aplicó porque algo
 * cambió entre la lectura y la escritura, vuelve a llamar a `comando` (que relee) hasta
 * `MAX_INTENTOS` veces. Cualquier otro error (regla de negocio, restricción) se propaga sin
 * reintentar. `adicionales` se agrega al final de cada batch (uso de `/sync/push`).
 */
export async function ejecutarConReintento<R>(
  db: D1Database,
  comando: () => Promise<PlanDeEscritura<R>>,
  adicionales: readonly D1PreparedStatement[] = [],
): Promise<R> {
  for (let intento = 1; ; intento += 1) {
    const plan = await comando();
    try {
      return await ejecutarPlan(db, plan, adicionales);
    } catch (error) {
      if (intento >= MAX_INTENTOS || plan.siNoAplica === undefined || error !== plan.siNoAplica) {
        throw error;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cálculo contra el plan (S7, S11) y su guarda
// ---------------------------------------------------------------------------------------------

interface Acumulado {
  n: number;
  total: number;
}

interface CalculoContraPlan {
  cantidadEnUnidadPlan: number;
  requiereNovedad: boolean;
  /** Acumulado leído de los OTROS consumos no rechazados del material (null si no está en el plan). */
  acumulado: Acumulado | null;
}

/**
 * Convierte la cantidad a la unidad del plan del material en la orden y decide `requiere_novedad`
 * con `excedeTolerancia` sobre el acumulado no rechazado más la cantidad nueva. Si el material no
 * está en el plan (P10), la cantidad queda en la unidad del material y `requiere_novedad = 1`.
 * `excluir` es el consumo que se está editando (su valor anterior no cuenta).
 */
async function calcularContraPlan(
  db: D1Database,
  datos: {
    orderId: string;
    material: FilaMaterial;
    cantidad: number;
    unidad: Unidad;
    excluir: string | null;
  },
): Promise<CalculoContraPlan> {
  const [plan, acumulado, tolerancia] = await db.batch([
    db
      .prepare(
        'SELECT cantidad_planeada, unidad FROM order_planned_materials WHERE order_id = ? AND material_id = ?',
      )
      .bind(datos.orderId, datos.material.id),
    db
      .prepare(
        `SELECT count(*) AS n, total(cantidad_en_unidad_plan) AS total FROM consumptions
         WHERE order_id = ? AND material_id = ? AND estado <> 'rechazado' AND id IS NOT ?`,
      )
      .bind(datos.orderId, datos.material.id, datos.excluir),
    sentenciaLeerTolerancia(db),
  ]);
  const planeado = plan?.results[0] as { cantidad_planeada: number; unidad: Unidad } | undefined;
  if (planeado === undefined) {
    return {
      cantidadEnUnidadPlan: convertir(datos.cantidad, datos.unidad, datos.material.unidad) ?? 0,
      requiereNovedad: true,
      acumulado: null,
    };
  }
  const leido = (acumulado?.results[0] as Acumulado | undefined) ?? { n: 0, total: 0 };
  // El plan se creó con una unidad convertible a la del material, y la del consumo también lo es.
  const cantidadEnUnidadPlan = convertir(datos.cantidad, datos.unidad, planeado.unidad) ?? 0;
  return {
    cantidadEnUnidadPlan,
    requiereNovedad: excedeTolerancia({
      planeada: planeado.cantidad_planeada,
      consumidaAcumulada: leido.total + cantidadEnUnidadPlan,
      toleranciaPct: toleranciaDeResultado(tolerancia),
    }),
    acumulado: leido,
  };
}

/** Guarda: el acumulado de los otros consumos no rechazados sigue siendo el leído. */
function guardaAcumulado(
  orderId: string,
  materialId: string,
  excluir: string | null,
  acumulado: Acumulado | null,
): CondicionSql {
  if (acumulado === null) {
    return { sql: '1 = 1', parametros: [] };
  }
  const filtro = `FROM consumptions AS otro WHERE otro.order_id = ? AND otro.material_id = ?
    AND otro.estado <> 'rechazado' AND otro.id IS NOT ?`;
  return {
    sql: `(SELECT count(*) ${filtro}) = ? AND abs((SELECT total(otro.cantidad_en_unidad_plan) ${filtro}) - ?) < ${String(EPSILON_ACUMULADO)}`,
    parametros: [
      orderId,
      materialId,
      excluir,
      acumulado.n,
      orderId,
      materialId,
      excluir,
      acumulado.total,
    ],
  };
}

/** Guarda: el material sigue activo y con el costo leído (snapshot S12). */
function guardaMaterial(material: FilaMaterial): CondicionSql {
  return {
    sql: 'EXISTS (SELECT 1 FROM materials AS mat WHERE mat.id = ? AND mat.activo = 1 AND mat.costo_unitario_cop = ?)',
    parametros: [material.id, material.costo_unitario_cop],
  };
}

function exigirMaterialUsable(
  material: FilaMaterial | null,
  unidad: Unidad,
  campo: string,
): FilaMaterial {
  if (material === null) {
    throw new ErrorApi('VALIDACION', [{ campo, mensaje: 'El material no existe.' }]);
  }
  if (material.activo !== 1) {
    throw new ErrorApi('MATERIAL_INACTIVO', { material_id: material.id });
  }
  if (!sonConvertibles(unidad, material.unidad)) {
    throw new ErrorApi('UNIDAD_INCOMPATIBLE', {
      material_id: material.id,
      unidad,
      unidad_material: material.unidad,
    });
  }
  return material;
}

function unir(...condiciones: CondicionSql[]): CondicionSql {
  return {
    sql: condiciones.map((c) => `(${c.sql})`).join(' AND '),
    parametros: condiciones.flatMap((c) => c.parametros),
  };
}

// ---------------------------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------------------------

/** Corrección (S3, P19): solo de un rechazado de la misma orden, del mismo autor o de un jefe, una vez. */
async function exigirCorreccionValida(ctx: Contexto, entrada: CrearConsumo): Promise<void> {
  if (entrada.corrige_a === undefined || entrada.corrige_a === null) {
    return;
  }
  const original = await buscarConsumo(ctx.db, entrada.corrige_a);
  const yaCorregido =
    original === null
      ? false
      : (await ctx.db
          .prepare('SELECT 1 AS x FROM consumptions WHERE corrige_a = ?')
          .bind(original.id)
          .first()) !== null;
  if (
    original === null ||
    original.estado !== 'rechazado' ||
    original.order_id !== entrada.order_id ||
    (original.registrado_por !== ctx.actor.id && ctx.actor.rol !== 'jefe') ||
    yaCorregido
  ) {
    throw new ErrorApi('CORRECCION_INVALIDA', { corrige_a: entrada.corrige_a });
  }
}

/**
 * `POST /consumptions` y mutación `consumo.crear`. Ver las reglas al inicio del archivo.
 * Devuelve un plan con `siNoAplica` propio: úselo con `ejecutarConReintento`.
 */
export async function registrarConsumo(
  ctx: Contexto,
  entrada: CrearConsumo,
): Promise<PlanDeEscritura<Consumo>> {
  if (!tienePermiso(ctx.actor.rol, 'consumos.registrar')) {
    throw new ErrorApi('PERMISO_DENEGADO');
  }
  const orden = (await puedeVerOrden(ctx, entrada.order_id))
    ? await buscarOrden(ctx.db, entrada.order_id)
    : null;
  if (orden === null) {
    throw new ErrorApi('NO_ENCONTRADO', { campo: 'order_id' });
  }
  if (orden.estado === 'planeada') {
    throw new ErrorApi('ORDEN_NO_EN_PROCESO', { estado: orden.estado });
  }
  if ((await buscarConsumo(ctx.db, entrada.id)) !== null) {
    throw new ErrorApi('ID_DUPLICADO', { entidad: 'consumptions', campos: ['id'] });
  }
  const material = exigirMaterialUsable(
    await buscarMaterial(ctx.db, entrada.material_id),
    entrada.unidad,
    'material_id',
  );
  await exigirCorreccionValida(ctx, entrada);

  const calculo = await calcularContraPlan(ctx.db, {
    orderId: orden.id,
    material,
    cantidad: entrada.cantidad,
    unidad: entrada.unidad,
    excluir: null,
  });
  const fila: FilaConsumo = {
    id: entrada.id,
    order_id: orden.id,
    material_id: material.id,
    cantidad: entrada.cantidad,
    unidad: entrada.unidad,
    cantidad_en_unidad_plan: calculo.cantidadEnUnidadPlan,
    lote: entrada.lote,
    costo_unitario_cop_snapshot: material.costo_unitario_cop,
    registrado_por: ctx.actor.id,
    device_id: ctx.deviceId,
    client_created_at: entrada.client_created_at,
    server_received_at: ctx.ahora,
    estado: 'pendiente',
    corrige_a: entrada.corrige_a ?? null,
    // Registro tardío (§6): la orden ya se cerró; se acepta y queda pendiente de validación.
    registro_tardio: orden.estado === 'en_proceso' ? 0 : 1,
    requiere_novedad: calculo.requiereNovedad ? 1 : 0,
    version: 1,
    created_at: ctx.ahora,
    updated_at: ctx.ahora,
  };

  const guardaOrden: CondicionSql = {
    sql: `o.id = ? AND o.estado = ?${
      ctx.actor.rol === 'supervisor'
        ? ' AND EXISTS (SELECT 1 FROM order_supervisors AS asig WHERE asig.order_id = o.id AND asig.user_id = ? AND asig.activo = 1)'
        : ''
    }`,
    parametros:
      ctx.actor.rol === 'supervisor'
        ? [orden.id, orden.estado, ctx.actor.id]
        : [orden.id, orden.estado],
  };
  const guarda = unir(
    guardaOrden,
    guardaMaterial(material),
    guardaAcumulado(orden.id, material.id, null, calculo.acumulado),
  );
  const valores = COLUMNAS_CONSUMO.split(', ').map((columna) => fila[columna as keyof FilaConsumo]);

  return {
    sentencias: [
      ctx.db
        .prepare(
          `INSERT INTO consumptions (${COLUMNAS_CONSUMO})
           SELECT ${valores.map(() => '?').join(', ')} FROM production_orders AS o WHERE ${guarda.sql}`,
        )
        .bind(...valores, ...guarda.parametros),
      sentenciaAuditoriaCondicional(
        ctx.db,
        {
          entidad: 'consumptions',
          entidad_id: fila.id,
          accion: 'consumo.crear',
          order_id: fila.order_id,
          actor_id: ctx.actor.id,
          device_id: ctx.deviceId,
          despues: { ...fila },
          client_at: entrada.client_created_at,
          server_at: ctx.ahora,
        },
        {
          sql: 'EXISTS (SELECT 1 FROM consumptions WHERE id = ? AND registrado_por = ? AND server_received_at = ?)',
          parametros: [fila.id, ctx.actor.id, ctx.ahora],
        },
      ),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: consumoDe(fila),
    siNoAplica: new ErrorApi('CONFLICTO'),
  };
}

// ---------------------------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------------------------

/**
 * `PATCH /consumptions/:id` y mutación `consumo.editar` (S4, P3): solo el autor con rol supervisor,
 * solo `pendiente` y solo sobre la `version` que conoce el cliente. Recalcula la conversión, el
 * snapshot (si cambia el material) y `requiere_novedad`. La autoría, `client_created_at` y
 * `registro_tardio` nunca cambian (además lo impiden los triggers). Úselo con `ejecutarConReintento`.
 */
export async function editarConsumo(
  ctx: Contexto,
  entrada: EditarConsumo,
): Promise<PlanDeEscritura<Consumo>> {
  if (!tienePermiso(ctx.actor.rol, 'consumos.editar_propio')) {
    throw new ErrorApi('PERMISO_DENEGADO');
  }
  const actual = await buscarConsumo(ctx.db, entrada.id);
  if (actual === null || !(await puedeVerConsumo(ctx, actual))) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  if (actual.registrado_por !== ctx.actor.id) {
    throw new ErrorApi('PERMISO_DENEGADO');
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

  const cambiaMaterial =
    entrada.material_id !== undefined && entrada.material_id !== actual.material_id;
  const unidad = entrada.unidad ?? actual.unidad;
  const cantidad = entrada.cantidad ?? actual.cantidad;
  const leido = await buscarMaterial(ctx.db, entrada.material_id ?? actual.material_id);
  // Si el material no cambia, se conserva aunque se haya desactivado después (snapshot congelado).
  // La FK garantiza que el material actual del consumo existe.
  const material = cambiaMaterial
    ? exigirMaterialUsable(leido, unidad, 'material_id')
    : (leido as FilaMaterial);
  if (!sonConvertibles(unidad, material.unidad)) {
    throw new ErrorApi('UNIDAD_INCOMPATIBLE', {
      material_id: material.id,
      unidad,
      unidad_material: material.unidad,
    });
  }
  const calculo = await calcularContraPlan(ctx.db, {
    orderId: actual.order_id,
    material,
    cantidad,
    unidad,
    excluir: actual.id,
  });
  const nuevo: FilaConsumo = {
    ...actual,
    material_id: material.id,
    cantidad,
    unidad,
    cantidad_en_unidad_plan: calculo.cantidadEnUnidadPlan,
    lote: entrada.lote ?? actual.lote,
    costo_unitario_cop_snapshot: cambiaMaterial
      ? material.costo_unitario_cop
      : actual.costo_unitario_cop_snapshot,
    requiere_novedad: calculo.requiereNovedad ? 1 : 0,
    version: actual.version + 1,
    updated_at: ctx.ahora,
  };
  const guarda = unir(
    cambiaMaterial ? guardaMaterial(material) : { sql: '1 = 1', parametros: [] },
    guardaAcumulado(actual.order_id, material.id, actual.id, calculo.acumulado),
  );
  return {
    sentencias: [
      ctx.db
        .prepare(
          `UPDATE consumptions SET material_id = ?, cantidad = ?, unidad = ?, cantidad_en_unidad_plan = ?,
             lote = ?, costo_unitario_cop_snapshot = ?, requiere_novedad = ?, version = version + 1,
             updated_at = ?
           WHERE id = ? AND version = ? AND estado = 'pendiente' AND registrado_por = ? AND ${guarda.sql}`,
        )
        .bind(
          nuevo.material_id,
          nuevo.cantidad,
          nuevo.unidad,
          nuevo.cantidad_en_unidad_plan,
          nuevo.lote,
          nuevo.costo_unitario_cop_snapshot,
          nuevo.requiere_novedad,
          ctx.ahora,
          actual.id,
          actual.version,
          ctx.actor.id,
          ...guarda.parametros,
        ),
      sentenciaAuditoriaCondicional(
        ctx.db,
        {
          entidad: 'consumptions',
          entidad_id: actual.id,
          accion: 'consumo.editar',
          order_id: actual.order_id,
          actor_id: ctx.actor.id,
          device_id: ctx.deviceId,
          antes: { ...actual },
          despues: { ...nuevo },
          client_at: entrada.client_created_at,
          server_at: ctx.ahora,
        },
        {
          sql: 'EXISTS (SELECT 1 FROM consumptions WHERE id = ? AND version = ? AND updated_at = ?)',
          parametros: [actual.id, nuevo.version, ctx.ahora],
        },
      ),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: consumoDe(nuevo),
    siNoAplica: new ErrorApi('CONFLICTO'),
  };
}

// ---------------------------------------------------------------------------------------------
// Listar los consumos de una orden
// ---------------------------------------------------------------------------------------------

interface FilaEvidencia {
  id: string;
  incident_id: string;
  mime: MimeEvidencia;
  tamano_bytes: number;
  sha256: string;
  subido: number;
  subido_at: string | null;
  created_at: string;
  updated_at: string;
}

export function evidenciaDe(fila: FilaEvidencia): Evidencia {
  return { ...fila, subido: fila.subido === 1 };
}

export const COLUMNAS_EVIDENCIA_PUBLICAS =
  'id, incident_id, mime, tamano_bytes, sha256, subido, subido_at, created_at, updated_at';

/**
 * `GET /orders/:id/consumptions`: cursor por id. Supervisor con la orden asignada (y jefe/admin):
 * todos los consumos (P9); supervisor sin asignación: solo los suyos (ADR 0005 regla 2), y 404 si
 * no tiene ninguno (no se revela la orden). Incluye novedades, metadatos de evidencias, validación
 * y `falta_novedad`.
 */
export async function listarConsumosDeOrden(
  ctx: Contexto,
  orderId: string,
  query: PaginacionQuery,
): Promise<ListaConsumos> {
  const limite = query.limite ?? LIMITE_PAGINA_DEFECTO;
  const veOrden =
    (await puedeVerOrden(ctx, orderId)) && (await buscarOrden(ctx.db, orderId)) !== null;
  const filtro: CondicionSql = veOrden
    ? { sql: '1 = 1', parametros: [] }
    : { sql: 'c.registrado_por = ?', parametros: [ctx.actor.id] };
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNAS_CONSUMO} FROM consumptions AS c
       WHERE c.order_id = ? AND c.id > ? AND ${filtro.sql}
       ORDER BY c.id LIMIT ?`,
    )
    .bind(orderId, query.cursor ?? '', ...filtro.parametros, limite + 1)
    .all<FilaConsumo>();
  if (!veOrden && query.cursor === undefined && results.length === 0) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  const pagina = results.slice(0, limite);
  const ultimo = pagina.at(-1);
  const ids = JSON.stringify(pagina.map((c) => c.id));
  const [novedades, evidencias, validaciones] =
    pagina.length === 0
      ? [undefined, undefined, undefined]
      : await ctx.db.batch([
          ctx.db
            .prepare(
              `SELECT id, consumption_id, tipo, descripcion, registrado_por, client_created_at,
                 server_received_at, created_at, updated_at
               FROM incidents WHERE consumption_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
            )
            .bind(ids),
          ctx.db
            .prepare(
              `SELECT ${COLUMNAS_EVIDENCIA_PUBLICAS.split(', ')
                .map((c) => `e.${c}`)
                .join(', ')}
               FROM evidences AS e JOIN incidents AS i ON i.id = e.incident_id
               WHERE i.consumption_id IN (SELECT value FROM json_each(?)) ORDER BY e.id`,
            )
            .bind(ids),
          ctx.db
            .prepare(
              `SELECT id, consumption_id, decision, motivo, validado_por, client_created_at,
                 server_received_at, created_at, updated_at
               FROM validations WHERE consumption_id IN (SELECT value FROM json_each(?))`,
            )
            .bind(ids),
        ]);
  const evidenciasPorNovedad = new Map<string, Evidencia[]>();
  for (const fila of (evidencias?.results ?? []) as FilaEvidencia[]) {
    const lista = evidenciasPorNovedad.get(fila.incident_id) ?? [];
    lista.push(evidenciaDe(fila));
    evidenciasPorNovedad.set(fila.incident_id, lista);
  }
  const novedadesPorConsumo = new Map<string, ConsumoDetallado['novedades']>();
  for (const fila of (novedades?.results ?? []) as Novedad[]) {
    const lista = novedadesPorConsumo.get(fila.consumption_id) ?? [];
    lista.push({ ...fila, evidencias: evidenciasPorNovedad.get(fila.id) ?? [] });
    novedadesPorConsumo.set(fila.consumption_id, lista);
  }
  const validacionPorConsumo = new Map(
    ((validaciones?.results ?? []) as Validacion[]).map((v) => [v.consumption_id, v]),
  );
  return {
    consumos: pagina.map((fila) => {
      const lista = novedadesPorConsumo.get(fila.id) ?? [];
      return {
        ...consumoDe(fila),
        falta_novedad: fila.requiere_novedad === 1 && lista.length === 0,
        novedades: lista,
        validacion: validacionPorConsumo.get(fila.id) ?? null,
      };
    }),
    siguiente_cursor: results.length > limite && ultimo !== undefined ? ultimo.id : null,
  };
}

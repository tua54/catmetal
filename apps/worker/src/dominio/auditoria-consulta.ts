// Consulta de la auditoría (docs/spec.md §3 "Ver auditoría", §7; docs/plan-fase-2.md tarea 2.4).
//
// - `GET /audit`: jefe y admin (`auditoria.ver_todo`) ven todas las filas; el supervisor solo las
//   que él hizo (`actor_id` = él). No es un error: se filtra. Orden descendente por `seq`.
//   Sin `admin.gestionar`, nadie ve `users`, `devices` ni `refresh_tokens` (ADR 0013).
// - `GET /orders/:id/audit`: línea de tiempo de la orden, cronológica (ascendente por `seq`), con
//   el índice parcial `audit_log_order_id_seq` (ADR 0010). Cada evento lleva actor (nombre y rol),
//   un `tipo` para el color de la UI y una `descripcion` en español generada aquí.
//
// Decisiones (ver el informe de la tarea 2.4):
// - Supervisor en la línea de tiempo ("solo lo propio", §3): ve las filas donde él es actor MÁS las
//   validaciones (aprobación o rechazo) de SUS consumos, porque necesita el motivo del rechazo para
//   crear la corrección (§8, Supervisor 6). La orden debe ser visible: asignación activa o algún
//   consumo propio en ella (ADR 0005 regla 2); si no, 404.
// - La fila de auditoría del consumo que escribe la validación (pendiente → aprobado/rechazado,
//   `version + 1`) no se muestra en la línea de tiempo: repetiría el evento de la validación. Sigue
//   visible en `GET /audit`.
//
// Los filtros se arman con fragmentos SQL fijos del código y parámetros enlazados (nunca texto del
// usuario en el SQL), para que SQLite use el índice adecuado en cada caso:
// `(actor_id, seq)` para el supervisor, `(entidad, entidad_id)` y la PK `seq` para el resto.

import {
  type ActorAuditoria,
  type AuditoriaQuery,
  type EntradaAuditoriaApi,
  type EventoLineaTiempo,
  formatearCantidad,
  LIMITE_AUDITORIA_DEFECTO,
  type LineaTiempoOrden,
  type LineaTiempoQuery,
  type ListaAuditoria,
  type Rol,
  tienePermiso,
  type TipoEventoLineaTiempo,
  type TipoNovedad,
} from '@catmetal/shared';
import type { CondicionSql } from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import type { Contexto } from './contexto';
import { buscarOrden, type FilaOrden } from './ordenes';
import { veTodasLasOrdenes } from './visibilidad';

interface FilaAuditoriaConActor {
  seq: number;
  id: string;
  entidad: string;
  entidad_id: string;
  order_id: string | null;
  accion: string;
  actor_id: string | null;
  actor_nombre: string | null;
  actor_rol: Rol | null;
  device_id: string | null;
  datos_antes: string | null;
  datos_despues: string | null;
  client_at: string | null;
  server_at: string;
  alerta_reloj: number;
}

/** Columnas de `audit_log` (alias `a`) y del actor (alias `u`): nada más de otras tablas. */
const COLUMNAS = `a.seq, a.id, a.entidad, a.entidad_id, a.order_id, a.accion, a.actor_id,
  u.nombre AS actor_nombre, u.rol AS actor_rol, a.device_id, a.datos_antes, a.datos_despues,
  a.client_at, a.server_at, a.alerta_reloj`;

/**
 * ADR 0013 (H-04): las entidades de administración de identidades solo las ve quien tiene
 * `admin.gestionar`. Literal fijo del código en el SQL. Si alguien sin ese permiso pide
 * `?entidad=users` (o devices, refresh_tokens), recibe una lista vacía, igual que el supervisor
 * que filtra por una entidad ajena: se filtra, no es un error, y no revela si hay filas.
 */
const SOLO_NEGOCIO: CondicionSql = {
  sql: `a.entidad NOT IN ('users', 'devices', 'refresh_tokens')`,
  parametros: [],
};

type Datos = Record<string, unknown>;

function parsear(texto: string | null): Datos | null {
  if (texto === null) {
    return null;
  }
  const valor: unknown = JSON.parse(texto);
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Datos)
    : null;
}

function actorDe(fila: FilaAuditoriaConActor): ActorAuditoria | null {
  if (fila.actor_id === null || fila.actor_nombre === null || fila.actor_rol === null) {
    return null;
  }
  return { id: fila.actor_id, nombre: fila.actor_nombre, rol: fila.actor_rol };
}

function entradaApi(fila: FilaAuditoriaConActor): EntradaAuditoriaApi {
  return {
    seq: fila.seq,
    id: fila.id,
    entidad: fila.entidad,
    entidad_id: fila.entidad_id,
    order_id: fila.order_id,
    accion: fila.accion,
    actor: actorDe(fila),
    device_id: fila.device_id,
    datos_antes: parsear(fila.datos_antes),
    datos_despues: parsear(fila.datos_despues),
    client_at: fila.client_at,
    server_at: fila.server_at,
    alerta_reloj: fila.alerta_reloj === 1,
  };
}

/** Une condiciones con AND (cada una es un fragmento fijo del código con sus parámetros). */
function unir(condiciones: readonly CondicionSql[]): CondicionSql {
  return {
    sql: condiciones.map((c) => `(${c.sql})`).join(' AND '),
    parametros: condiciones.flatMap((c) => c.parametros),
  };
}

function paginar<T>(
  filas: readonly T[],
  limite: number,
  seq: (fila: T) => number,
): { pagina: T[]; siguiente: number | null } {
  const pagina = filas.slice(0, limite);
  const ultima = pagina.at(-1);
  return {
    pagina,
    siguiente: filas.length > limite && ultima !== undefined ? seq(ultima) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// GET /audit
// ---------------------------------------------------------------------------------------------

export async function listarAuditoria(
  ctx: Contexto,
  query: AuditoriaQuery,
): Promise<ListaAuditoria> {
  const limite = query.limite ?? LIMITE_AUDITORIA_DEFECTO;
  const condiciones: CondicionSql[] = [];
  if (!tienePermiso(ctx.actor.rol, 'auditoria.ver_todo')) {
    // "Solo lo propio" (§3): filas donde el supervisor es el actor.
    condiciones.push({ sql: 'a.actor_id = ?', parametros: [ctx.actor.id] });
  }
  if (!tienePermiso(ctx.actor.rol, 'admin.gestionar')) {
    condiciones.push(SOLO_NEGOCIO);
  }
  if (query.cursor !== undefined) {
    condiciones.push({ sql: 'a.seq < ?', parametros: [query.cursor] });
  }
  if (query.entidad !== undefined) {
    condiciones.push({ sql: 'a.entidad = ?', parametros: [query.entidad] });
  }
  if (query.entidad_id !== undefined) {
    condiciones.push({ sql: 'a.entidad_id = ?', parametros: [query.entidad_id] });
  }
  if (query.desde !== undefined) {
    condiciones.push({ sql: 'a.server_at >= ?', parametros: [query.desde] });
  }
  if (query.hasta !== undefined) {
    condiciones.push({ sql: 'a.server_at <= ?', parametros: [query.hasta] });
  }
  const filtro = unir(condiciones.length === 0 ? [{ sql: '1 = 1', parametros: [] }] : condiciones);
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNAS} FROM audit_log AS a LEFT JOIN users AS u ON u.id = a.actor_id
       WHERE ${filtro.sql} ORDER BY a.seq DESC LIMIT ?`,
    )
    .bind(...filtro.parametros, limite + 1)
    .all<FilaAuditoriaConActor>();
  const { pagina, siguiente } = paginar(results, limite, (f) => f.seq);
  return { entradas: pagina.map(entradaApi), siguiente_cursor: siguiente };
}

// ---------------------------------------------------------------------------------------------
// GET /orders/:id/audit
// ---------------------------------------------------------------------------------------------

/**
 * Orden visible en la línea de tiempo, o 404: jefe y admin cualquiera que exista; el supervisor si
 * tiene asignación activa o algún consumo propio en ella (ADR 0005 regla 2).
 */
async function ordenDeLineaTiempo(ctx: Contexto, orderId: string): Promise<FilaOrden> {
  if (!veTodasLasOrdenes(ctx)) {
    const visible = await ctx.db
      .prepare(
        `SELECT 1 AS visible WHERE
           EXISTS (SELECT 1 FROM order_supervisors
                   WHERE order_id = ?1 AND user_id = ?2 AND activo = 1)
           OR EXISTS (SELECT 1 FROM consumptions WHERE order_id = ?1 AND registrado_por = ?2)`,
      )
      .bind(orderId, ctx.actor.id)
      .first<{ visible: number }>();
    if (visible === null) {
      throw new ErrorApi('NO_ENCONTRADO');
    }
  }
  const orden = await buscarOrden(ctx.db, orderId);
  if (orden === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  return orden;
}

/** Fila del consumo escrita por una validación: repite el evento de la validación (ver arriba). */
const NO_ES_EFECTO_DE_VALIDACION = `NOT (a.entidad = 'consumptions' AND a.datos_antes IS NOT NULL
  AND a.datos_despues IS NOT NULL
  AND json_extract(a.datos_antes, '$.estado') = 'pendiente'
  AND json_extract(a.datos_despues, '$.estado') IN ('aprobado', 'rechazado'))`;

export async function lineaTiempoOrden(
  ctx: Contexto,
  orderId: string,
  query: LineaTiempoQuery,
): Promise<LineaTiempoOrden> {
  const orden = await ordenDeLineaTiempo(ctx, orderId);
  const limite = query.limite ?? LIMITE_AUDITORIA_DEFECTO;
  const condiciones: CondicionSql[] = [
    { sql: 'a.order_id = ?', parametros: [orderId] },
    { sql: 'a.seq > ?', parametros: [query.cursor ?? 0] },
    { sql: NO_ES_EFECTO_DE_VALIDACION, parametros: [] },
  ];
  if (!tienePermiso(ctx.actor.rol, 'admin.gestionar')) {
    // Defensa en profundidad: hoy esas filas no llevan `order_id`, pero el filtro no depende de ello.
    condiciones.push(SOLO_NEGOCIO);
  }
  if (!tienePermiso(ctx.actor.rol, 'auditoria.ver_todo')) {
    condiciones.push({
      sql: `a.actor_id = ? OR (a.entidad = 'validations' AND EXISTS (
              SELECT 1 FROM validations AS v JOIN consumptions AS c ON c.id = v.consumption_id
              WHERE v.id = a.entidad_id AND c.registrado_por = ?))`,
      parametros: [ctx.actor.id, ctx.actor.id],
    });
  }
  const filtro = unir(condiciones);
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNAS} FROM audit_log AS a LEFT JOIN users AS u ON u.id = a.actor_id
       WHERE ${filtro.sql} ORDER BY a.seq LIMIT ?`,
    )
    .bind(...filtro.parametros, limite + 1)
    .all<FilaAuditoriaConActor>();
  const { pagina, siguiente } = paginar(results, limite, (f) => f.seq);
  const referencias = await leerReferencias(ctx.db, pagina);
  return {
    order_id: orden.id,
    codigo: orden.codigo,
    eventos: pagina.map((fila) => eventoLineaTiempo(fila, referencias, orden.codigo)),
    siguiente_cursor: siguiente,
  };
}

// ---------------------------------------------------------------------------------------------
// Descripciones
// ---------------------------------------------------------------------------------------------

interface ConsumoReferido {
  id: string;
  material_id: string;
  material_nombre: string;
  cantidad: number;
  unidad: string;
  con_novedad: number;
}

/** Datos actuales que las descripciones necesitan y que no están en la fila de auditoría. */
export interface Referencias {
  consumos: ReadonlyMap<string, ConsumoReferido>;
  /** Novedad → consumo. */
  novedades: ReadonlyMap<string, string>;
  materiales: ReadonlyMap<string, string>;
  usuarios: ReadonlyMap<string, string>;
}

function texto(datos: Datos | null, clave: string): string | null {
  const valor = datos?.[clave];
  return typeof valor === 'string' ? valor : null;
}

function numero(datos: Datos | null, clave: string): number | null {
  const valor = datos?.[clave];
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * Lee en UN batch (4 sentencias, 1–2 parámetros cada una con `json_each`, muy por debajo del
 * límite de 100) los consumos, novedades, materiales y usuarios que nombra la página.
 */
async function leerReferencias(
  db: D1Database,
  filas: readonly FilaAuditoriaConActor[],
): Promise<Referencias> {
  const consumos = new Set<string>();
  const novedades = new Set<string>();
  const materiales = new Set<string>();
  const usuarios = new Set<string>();
  for (const fila of filas) {
    const datos = parsear(fila.datos_despues) ?? parsear(fila.datos_antes);
    const consumo = texto(datos, 'consumption_id');
    const novedad = texto(datos, 'incident_id');
    const material = texto(datos, 'material_id');
    const usuario = texto(datos, 'user_id');
    if (fila.entidad === 'consumptions') {
      consumos.add(fila.entidad_id);
    }
    if (consumo !== null) {
      consumos.add(consumo);
    }
    if (novedad !== null) {
      novedades.add(novedad);
    }
    if (material !== null) {
      materiales.add(material);
    }
    if (usuario !== null) {
      usuarios.add(usuario);
    }
  }
  if (consumos.size + novedades.size + materiales.size + usuarios.size === 0) {
    return {
      consumos: new Map(),
      novedades: new Map(),
      materiales: new Map(),
      usuarios: new Map(),
    };
  }
  const [filasConsumos, filasNovedades, filasMateriales, filasUsuarios] = await db.batch([
    db
      .prepare(
        `SELECT c.id, c.material_id, m.nombre AS material_nombre, c.cantidad, c.unidad,
           EXISTS (SELECT 1 FROM incidents AS i WHERE i.consumption_id = c.id) AS con_novedad
         FROM consumptions AS c JOIN materials AS m ON m.id = c.material_id
         WHERE c.id IN (SELECT value FROM json_each(?1))
            OR c.id IN (SELECT i.consumption_id FROM incidents AS i
                        WHERE i.id IN (SELECT value FROM json_each(?2)))`,
      )
      .bind(JSON.stringify([...consumos]), JSON.stringify([...novedades])),
    db
      .prepare(
        'SELECT id, consumption_id FROM incidents WHERE id IN (SELECT value FROM json_each(?))',
      )
      .bind(JSON.stringify([...novedades])),
    db
      .prepare('SELECT id, nombre FROM materials WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify([...materiales])),
    db
      .prepare('SELECT id, nombre FROM users WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify([...usuarios])),
  ]);
  const lista = <T>(resultado: D1Result | undefined): T[] => (resultado?.results ?? []) as T[];
  return {
    consumos: new Map(lista<ConsumoReferido>(filasConsumos).map((c) => [c.id, c])),
    novedades: new Map(
      lista<{ id: string; consumption_id: string }>(filasNovedades).map((n) => [
        n.id,
        n.consumption_id,
      ]),
    ),
    materiales: new Map(
      lista<{ id: string; nombre: string }>(filasMateriales).map((m) => [m.id, m.nombre]),
    ),
    usuarios: new Map(
      lista<{ id: string; nombre: string }>(filasUsuarios).map((u) => [u.id, u.nombre]),
    ),
  };
}

const ETIQUETA_NOVEDAD: Readonly<Record<TipoNovedad, string>> = {
  reproceso: 'Reproceso',
  merma: 'Merma',
  dano: 'Daño',
  error_registro: 'Error de registro',
  otro: 'Otro',
};

const MAX_TEXTO_LIBRE = 160;

function recortar(valor: string): string {
  return valor.length > MAX_TEXTO_LIBRE ? `${valor.slice(0, MAX_TEXTO_LIBRE - 1)}…` : valor;
}

function cantidadConUnidad(cantidad: number | null, unidad: string | null): string {
  return cantidad === null ? '' : `${formatearCantidad(cantidad)} ${unidad ?? ''}`.trim();
}

interface Descripcion {
  tipo: TipoEventoLineaTiempo;
  descripcion: string;
  consumption_id: string | null;
}

function describirOrden(antes: Datos | null, despues: Datos | null, codigo: string): Descripcion {
  const estado = texto(despues, 'estado');
  let descripcion: string;
  if (antes === null) {
    descripcion = `Orden ${codigo} creada`;
  } else if (estado === texto(antes, 'estado')) {
    descripcion = `Orden ${codigo} actualizada`;
  } else if (estado === 'en_proceso') {
    descripcion = `Orden ${codigo} iniciada`;
  } else if (estado === 'finalizada') {
    const pendientes = numero(despues, 'pendientes') ?? 0;
    const forzada = despues?.force === true && pendientes > 0;
    descripcion = forzada
      ? `Orden ${codigo} finalizada con ${String(pendientes)} consumo(s) pendiente(s) (forzada)`
      : `Orden ${codigo} finalizada`;
  } else if (estado === 'cancelada') {
    descripcion = `Orden ${codigo} cancelada`;
  } else {
    descripcion = `Orden ${codigo} actualizada`;
  }
  return { tipo: 'sistema', descripcion, consumption_id: null };
}

function describirConsumo(
  fila: FilaAuditoriaConActor,
  antes: Datos | null,
  despues: Datos | null,
  ref: Referencias,
): Descripcion {
  const consumo = ref.consumos.get(fila.entidad_id);
  const materialId = texto(despues, 'material_id') ?? consumo?.material_id ?? null;
  const material =
    (materialId === null ? undefined : ref.materiales.get(materialId)) ??
    consumo?.material_nombre ??
    'material';
  const cantidad = cantidadConUnidad(numero(despues, 'cantidad'), texto(despues, 'unidad'));
  const base = { consumption_id: fila.entidad_id };
  if (antes !== null) {
    const estado = texto(despues, 'estado');
    if (estado !== null && estado !== texto(antes, 'estado')) {
      return {
        ...base,
        tipo: estado === 'rechazado' ? 'rechazo' : 'validacion',
        descripcion: `Consumo de ${material} ${estado}`,
      };
    }
    const anterior = cantidadConUnidad(numero(antes, 'cantidad'), texto(antes, 'unidad'));
    const cambio = anterior !== cantidad && anterior !== '' ? `: ${anterior} → ${cantidad}` : '';
    return { ...base, tipo: 'registro', descripcion: `Editó el consumo de ${material}${cambio}` };
  }
  const conNovedad = consumo?.con_novedad === 1;
  const requiere = despues?.requiere_novedad === true;
  const partes = [
    texto(despues, 'corrige_a') === null ? 'Registró' : 'Registró corrección:',
    cantidad === '' ? 'consumo' : cantidad,
    `de ${material}`,
  ];
  let descripcion = partes.join(' ');
  if (conNovedad) {
    descripcion += ' + novedad';
  } else if (requiere) {
    descripcion += ' (supera la tolerancia: falta novedad)';
  }
  if (despues?.registro_tardio === true) {
    descripcion += ' (registro tardío)';
  }
  return { ...base, tipo: conNovedad || requiere ? 'novedad' : 'registro', descripcion };
}

function materialDelConsumo(consumoId: string | null, ref: Referencias): string {
  const consumo = consumoId === null ? undefined : ref.consumos.get(consumoId);
  return consumo === undefined ? 'material' : consumo.material_nombre;
}

/** Descripción y tipo de una fila de la línea de tiempo (función pura, sin acceso a la base). */
export function describirEvento(
  fila: FilaAuditoriaConActor,
  ref: Referencias,
  codigoOrden: string,
): Descripcion {
  const antes = parsear(fila.datos_antes);
  const despues = parsear(fila.datos_despues);
  switch (fila.entidad) {
    case 'production_orders':
      return describirOrden(antes, despues, texto(despues, 'codigo') ?? codigoOrden);
    case 'order_supervisors': {
      const userId = texto(despues, 'user_id');
      const nombre = (userId === null ? undefined : ref.usuarios.get(userId)) ?? 'un supervisor';
      return {
        tipo: 'sistema',
        descripcion:
          despues?.activo === false ? `Quitó la asignación de ${nombre}` : `Asignó a ${nombre}`,
        consumption_id: null,
      };
    }
    case 'order_planned_materials': {
      const materialId = texto(despues, 'material_id');
      const material =
        (materialId === null ? undefined : ref.materiales.get(materialId)) ?? 'material';
      const cantidad = cantidadConUnidad(
        numero(despues, 'cantidad_planeada'),
        texto(despues, 'unidad'),
      );
      return {
        tipo: 'sistema',
        descripcion: `Planeó ${cantidad === '' ? 'consumo' : cantidad} de ${material}`,
        consumption_id: null,
      };
    }
    case 'consumptions':
      return describirConsumo(fila, antes, despues, ref);
    case 'incidents': {
      const consumoId = texto(despues, 'consumption_id');
      const tipoNovedad = texto(despues, 'tipo') as TipoNovedad | null;
      const etiqueta =
        tipoNovedad !== null && Object.hasOwn(ETIQUETA_NOVEDAD, tipoNovedad)
          ? ETIQUETA_NOVEDAD[tipoNovedad]
          : 'Novedad';
      const detalle = texto(despues, 'descripcion');
      return {
        tipo: 'novedad',
        descripcion: `Registró novedad (${etiqueta}) en el consumo de ${materialDelConsumo(consumoId, ref)}${detalle === null ? '' : `: ${recortar(detalle)}`}`,
        consumption_id: consumoId,
      };
    }
    case 'evidences': {
      const novedadId = texto(despues, 'incident_id');
      const consumoId = novedadId === null ? null : (ref.novedades.get(novedadId) ?? null);
      const subida = despues?.subido === true;
      return {
        tipo: 'novedad',
        descripcion: subida
          ? `Subió la foto de evidencia de la novedad de ${materialDelConsumo(consumoId, ref)}`
          : `Adjuntó una foto de evidencia a la novedad de ${materialDelConsumo(consumoId, ref)} (pendiente de subir)`,
        consumption_id: consumoId,
      };
    }
    case 'validations': {
      const consumoId = texto(despues, 'consumption_id');
      const material = materialDelConsumo(consumoId, ref);
      if (texto(despues, 'decision') === 'rechazado') {
        const motivo = texto(despues, 'motivo');
        return {
          tipo: 'rechazo',
          descripcion: `Rechazó consumo de ${material}${motivo === null ? '' : `: ${recortar(motivo)}`}`,
          consumption_id: consumoId,
        };
      }
      return {
        tipo: 'validacion',
        descripcion: `Validó consumo de ${material}`,
        consumption_id: consumoId,
      };
    }
    default:
      return {
        tipo: 'sistema',
        descripcion: `${fila.accion} (${fila.entidad})`,
        consumption_id: null,
      };
  }
}

function eventoLineaTiempo(
  fila: FilaAuditoriaConActor,
  ref: Referencias,
  codigoOrden: string,
): EventoLineaTiempo {
  const { tipo, descripcion, consumption_id } = describirEvento(fila, ref, codigoOrden);
  return {
    seq: fila.seq,
    id: fila.id,
    entidad: fila.entidad,
    entidad_id: fila.entidad_id,
    accion: fila.accion,
    tipo,
    descripcion,
    consumption_id,
    actor: actorDe(fila),
    device_id: fila.device_id,
    client_at: fila.client_at,
    server_at: fila.server_at,
    alerta_reloj: fila.alerta_reloj === 1,
  };
}

export type { FilaAuditoriaConActor };

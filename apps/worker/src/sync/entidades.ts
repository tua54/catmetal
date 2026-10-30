// Entidades sincronizables: cómo se leen de D1, cómo se convierten en `datos` (la misma forma que
// la API REST) y quién puede verlas (docs/spec.md §3; ADR 0005 reglas 2 y 5). Lo comparten
// `/sync/pull` (estado actual por ids, visibilidad aplicada en JS fila por fila) y
// `/sync/snapshot` (estado actual paginado, visibilidad en el `WHERE`).
//
// Reglas de visibilidad (con el estado ACTUAL: rol y asignaciones activas):
// - `settings` y `materials`: todos los roles (catálogo y tolerancia, necesarios offline).
// - `users`: solo `id, nombre, rol, activo` (nunca correo, hash, intentos ni bloqueo). Jefe y admin
//   ven todos; el supervisor se ve a sí mismo y a los usuarios con rol jefe o admin (para mostrar
//   quién validó o creó una orden). Los nombres de los demás supervisores de sus órdenes viajan en
//   `order_supervisors.nombre`.
// - `production_orders`, `order_planned_materials`, `order_supervisors`: jefe y admin todo; el
//   supervisor, las órdenes con asignación activa.
// - `consumptions`, `incidents`, `evidences`, `validations`: jefe y admin todo; el supervisor, lo
//   de sus órdenes asignadas y SIEMPRE lo de los consumos que él registró.
// - `devices`, `refresh_tokens`, `sync_mutations` y `audit_log` nunca se sincronizan.
//
// Ids compuestos (`packages/shared/src/snapshot.ts`): `order_supervisors` → `<order_id>:<user_id>`,
// `order_planned_materials` → `<order_id>:<material_id>`, `settings` → la `clave`.

import type { EntidadSync, Rol } from '@catmetal/shared';
import { COLUMNAS_CONSUMO, COLUMNAS_EVIDENCIA_PUBLICAS } from '../dominio/consumos';
import type { Contexto } from '../dominio/contexto';
import { COLUMNAS_MATERIAL } from '../dominio/materiales';
import { COLUMNAS_ORDEN } from '../dominio/ordenes';
import { veTodasLasOrdenes } from '../dominio/visibilidad';

export type Fila = Record<string, unknown>;
export type Datos = Record<string, unknown>;

/** De qué depende que una fila sea visible. */
export type Ambito =
  | { tipo: 'global' }
  | { tipo: 'usuario'; id: string; rol: Rol }
  | { tipo: 'orden'; orderId: string }
  | { tipo: 'consumo'; orderId: string; registradoPor: string };

export interface DescriptorEntidad {
  entidad: EntidadSync;
  /** `SELECT … FROM …` (con alias fijos), sin `WHERE`. */
  desde: string;
  /** Columnas de la clave, en orden (una o dos). Son nombres del código, nunca datos del usuario. */
  clave: readonly [string] | readonly [string, string];
  /** Columna de la orden para el snapshot de alcance `orden` (`null`: la entidad no es de una orden). */
  columnaOrden: string | null;
  /** Tipo de visibilidad (para el `WHERE` del snapshot). */
  visibilidad: Ambito['tipo'];
  id: (fila: Fila) => string;
  datos: (fila: Fila) => Datos;
  ambito: (fila: Fila) => Ambito;
}

const texto = (valor: unknown): string => (typeof valor === 'string' ? valor : String(valor));
const booleano = (valor: unknown): boolean => valor === 1 || valor === true;

function prefijar(alias: string, columnas: string): string {
  return columnas
    .split(', ')
    .map((columna) => `${alias}.${columna}`)
    .join(', ');
}

function elegir(fila: Fila, columnas: string, booleanas: readonly string[] = []): Datos {
  return Object.fromEntries(
    columnas
      .split(', ')
      .map((columna) => [
        columna,
        booleanas.includes(columna) ? booleano(fila[columna]) : fila[columna],
      ]),
  );
}

/** Ámbito de una fila hija de un consumo (`vis_order_id`, `vis_registrado_por` del JOIN). */
function ambitoDeConsumo(fila: Fila): Ambito {
  return {
    tipo: 'consumo',
    orderId: texto(fila.vis_order_id),
    registradoPor: texto(fila.vis_registrado_por),
  };
}

const COLUMNAS_NOVEDAD =
  'id, consumption_id, tipo, descripcion, registrado_por, client_created_at, server_received_at, created_at, updated_at';
const COLUMNAS_VALIDACION =
  'id, consumption_id, decision, motivo, validado_por, client_created_at, server_received_at, created_at, updated_at';
const COLUMNAS_USUARIO = 'id, nombre, rol, activo';
const COLUMNAS_PLANEADO = 'order_id, material_id, cantidad_planeada, unidad';
const COLUMNAS_ASIGNACION =
  'order_id, user_id, nombre, asignado_por, activo, created_at, updated_at';
const COLUMNAS_SETTING = 'clave, valor, actualizado_por, created_at, updated_at';

function valorJson(valor: unknown): unknown {
  try {
    return JSON.parse(texto(valor)) as unknown;
  } catch {
    return valor;
  }
}

/**
 * Entidades en el orden en que las entrega el snapshot (primero lo que las demás referencian).
 */
export const DESCRIPTORES: readonly DescriptorEntidad[] = [
  {
    entidad: 'settings',
    desde: `SELECT ${prefijar('st', COLUMNAS_SETTING)} FROM settings AS st`,
    clave: ['st.clave'],
    columnaOrden: null,
    visibilidad: 'global',
    id: (f) => texto(f.clave),
    datos: (f) => ({ ...elegir(f, COLUMNAS_SETTING), valor: valorJson(f.valor) }),
    ambito: () => ({ tipo: 'global' }),
  },
  {
    entidad: 'users',
    desde: `SELECT ${prefijar('u', COLUMNAS_USUARIO)} FROM users AS u`,
    clave: ['u.id'],
    columnaOrden: null,
    visibilidad: 'usuario',
    id: (f) => texto(f.id),
    datos: (f) => elegir(f, COLUMNAS_USUARIO, ['activo']),
    ambito: (f) => ({ tipo: 'usuario', id: texto(f.id), rol: f.rol as Rol }),
  },
  {
    entidad: 'materials',
    desde: `SELECT ${prefijar('m', COLUMNAS_MATERIAL)} FROM materials AS m`,
    clave: ['m.id'],
    columnaOrden: null,
    visibilidad: 'global',
    id: (f) => texto(f.id),
    datos: (f) => elegir(f, COLUMNAS_MATERIAL, ['activo']),
    ambito: () => ({ tipo: 'global' }),
  },
  {
    entidad: 'production_orders',
    desde: `SELECT ${prefijar('o', COLUMNAS_ORDEN)} FROM production_orders AS o`,
    clave: ['o.id'],
    columnaOrden: 'o.id',
    visibilidad: 'orden',
    id: (f) => texto(f.id),
    datos: (f) => elegir(f, COLUMNAS_ORDEN),
    ambito: (f) => ({ tipo: 'orden', orderId: texto(f.id) }),
  },
  {
    entidad: 'order_planned_materials',
    desde: `SELECT ${prefijar('p', COLUMNAS_PLANEADO)} FROM order_planned_materials AS p`,
    clave: ['p.order_id', 'p.material_id'],
    columnaOrden: 'p.order_id',
    visibilidad: 'orden',
    id: (f) => `${texto(f.order_id)}:${texto(f.material_id)}`,
    datos: (f) => elegir(f, COLUMNAS_PLANEADO),
    ambito: (f) => ({ tipo: 'orden', orderId: texto(f.order_id) }),
  },
  {
    entidad: 'order_supervisors',
    desde: `SELECT s.order_id, s.user_id, u.nombre, s.asignado_por, s.activo, s.created_at,
        s.updated_at
      FROM order_supervisors AS s JOIN users AS u ON u.id = s.user_id`,
    clave: ['s.order_id', 's.user_id'],
    columnaOrden: 's.order_id',
    visibilidad: 'orden',
    id: (f) => `${texto(f.order_id)}:${texto(f.user_id)}`,
    datos: (f) => elegir(f, COLUMNAS_ASIGNACION, ['activo']),
    ambito: (f) => ({ tipo: 'orden', orderId: texto(f.order_id) }),
  },
  {
    entidad: 'consumptions',
    desde: `SELECT ${prefijar('c', COLUMNAS_CONSUMO)}, c.order_id AS vis_order_id,
        c.registrado_por AS vis_registrado_por
      FROM consumptions AS c`,
    clave: ['c.id'],
    columnaOrden: 'c.order_id',
    visibilidad: 'consumo',
    id: (f) => texto(f.id),
    datos: (f) => elegir(f, COLUMNAS_CONSUMO, ['registro_tardio', 'requiere_novedad']),
    ambito: ambitoDeConsumo,
  },
  {
    entidad: 'incidents',
    desde: `SELECT ${prefijar('i', COLUMNAS_NOVEDAD)}, c.order_id AS vis_order_id,
        c.registrado_por AS vis_registrado_por
      FROM incidents AS i JOIN consumptions AS c ON c.id = i.consumption_id`,
    clave: ['i.id'],
    columnaOrden: 'c.order_id',
    visibilidad: 'consumo',
    id: (f) => texto(f.id),
    datos: (f) => elegir(f, COLUMNAS_NOVEDAD),
    ambito: ambitoDeConsumo,
  },
  {
    entidad: 'evidences',
    // Sin `storage_key`: es interno y nunca se expone.
    desde: `SELECT ${prefijar('e', COLUMNAS_EVIDENCIA_PUBLICAS)}, c.order_id AS vis_order_id,
        c.registrado_por AS vis_registrado_por
      FROM evidences AS e JOIN incidents AS i ON i.id = e.incident_id
      JOIN consumptions AS c ON c.id = i.consumption_id`,
    clave: ['e.id'],
    columnaOrden: 'c.order_id',
    visibilidad: 'consumo',
    id: (f) => texto(f.id),
    datos: (f) => elegir(f, COLUMNAS_EVIDENCIA_PUBLICAS, ['subido']),
    ambito: ambitoDeConsumo,
  },
  {
    entidad: 'validations',
    desde: `SELECT ${prefijar('v', COLUMNAS_VALIDACION)}, c.order_id AS vis_order_id,
        c.registrado_por AS vis_registrado_por
      FROM validations AS v JOIN consumptions AS c ON c.id = v.consumption_id`,
    clave: ['v.id'],
    columnaOrden: 'c.order_id',
    visibilidad: 'consumo',
    id: (f) => texto(f.id),
    datos: (f) => elegir(f, COLUMNAS_VALIDACION),
    ambito: ambitoDeConsumo,
  },
];

const POR_ENTIDAD: ReadonlyMap<string, DescriptorEntidad> = new Map(
  DESCRIPTORES.map((d) => [d.entidad, d]),
);

export function descriptorDe(entidad: string): DescriptorEntidad | undefined {
  return POR_ENTIDAD.get(entidad);
}

// ---------------------------------------------------------------------------------------------
// Visibilidad en memoria (pull)
// ---------------------------------------------------------------------------------------------

export interface Visibilidad {
  actorId: string;
  /** Jefe y admin: todo lo de negocio. */
  todas: boolean;
  /** Órdenes con asignación ACTIVA del usuario. */
  asignadas: ReadonlySet<string>;
  /** Órdenes con una asignación INACTIVA del usuario (pudo verlas antes: se revocan). */
  exAsignadas: ReadonlySet<string>;
}

/** Visibilidad a partir de las asignaciones del usuario (`order_id`, `activo`). */
export function visibilidadDe(
  ctx: Contexto,
  asignaciones: readonly { order_id: string; activo: number }[],
): Visibilidad {
  return {
    actorId: ctx.actor.id,
    todas: veTodasLasOrdenes(ctx),
    asignadas: new Set(asignaciones.filter((a) => a.activo === 1).map((a) => a.order_id)),
    exAsignadas: new Set(asignaciones.filter((a) => a.activo !== 1).map((a) => a.order_id)),
  };
}

const ROLES_VISIBLES_PARA_TODOS: readonly Rol[] = ['jefe', 'admin'];

export function esVisible(vis: Visibilidad, ambito: Ambito): boolean {
  switch (ambito.tipo) {
    case 'global':
      return true;
    case 'usuario':
      return (
        vis.todas || ambito.id === vis.actorId || ROLES_VISIBLES_PARA_TODOS.includes(ambito.rol)
      );
    case 'orden':
      return vis.todas || vis.asignadas.has(ambito.orderId);
    case 'consumo':
      return vis.todas || ambito.registradoPor === vis.actorId || vis.asignadas.has(ambito.orderId);
  }
}

/**
 * Indica si una fila NO visible ahora pudo serlo antes para este usuario (entonces se envía
 * `revocar`): datos de una orden que tuvo asignada. Lo que nunca pudo ver se omite en silencio.
 */
export function pudoSerVisible(vis: Visibilidad, ambito: Ambito): boolean {
  switch (ambito.tipo) {
    case 'orden':
    case 'consumo':
      return vis.exAsignadas.has(ambito.orderId);
    default:
      return false;
  }
}

export function esRolVisibleParaTodos(rol: unknown): boolean {
  return ROLES_VISIBLES_PARA_TODOS.includes(rol as Rol);
}

// ---------------------------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------------------------

/** Lectura del estado actual de una lista de ids de la entidad (un solo parámetro JSON). */
export function sentenciaPorIds(
  db: D1Database,
  descriptor: DescriptorEntidad,
  ids: readonly string[],
): D1PreparedStatement {
  const [primera, segunda] = descriptor.clave;
  const filtro =
    segunda === undefined
      ? `${primera} IN (SELECT value FROM json_each(?))`
      : `(${primera}, ${segunda}) IN (SELECT substr(value, 1, instr(value, ':') - 1),
           substr(value, instr(value, ':') + 1) FROM json_each(?))`;
  return db.prepare(`${descriptor.desde} WHERE ${filtro}`).bind(JSON.stringify(ids));
}

/** `settings.sync_epoca` (ADR 0009). */
export function sentenciaEpoca(db: D1Database): D1PreparedStatement {
  return db.prepare("SELECT valor FROM settings WHERE clave = 'sync_epoca'");
}

/** Época como texto (el valor es un JSON con un UUID). */
export function epocaDe(resultado: D1Result | undefined): string {
  const fila = resultado?.results[0] as { valor?: unknown } | undefined;
  const valor = valorJson(fila?.valor);
  // La migración 0002 siempre crea la fila. Sin ella no se puede sincronizar con seguridad
  // (el cliente no detectaría una restauración): error interno, nunca una época inventada.
  if (typeof valor !== 'string' || valor === '') {
    throw new Error('Falta settings.sync_epoca');
  }
  return valor;
}

// `GET /api/v1/sync/pull?cursor=` (docs/spec.md §6; ADR 0005, reglas 1–6 y 9; ADR 0010 punto 3).
//
// 1. En UN batch: la ventana `seq > cursor ORDER BY seq LIMIT 1000` de `audit_log` (primario, sin
//    filtrar), la época y las asignaciones del usuario (activas e inactivas).
// 2. En OTRO batch: el estado ACTUAL de cada entidad de la ventana, una sentencia por tabla con
//    `json_each(?)` (un parámetro por sentencia).
// 3. Recorrido en JS, fila por fila y en orden de `seq`: la visibilidad se aplica aquí con el estado
//    actual (nunca en SQL, para saber cuál fue el último `seq` revisado). Se deduplica por
//    (entidad, id). Al llegar a 200 entidades distintas se detiene; una fila cuyos cambios no caben
//    se deja para el siguiente pull. El nuevo cursor es el `seq` de la última fila REVISADA.
// 4. Eventos de visibilidad del propio usuario: su asignación activa a una orden → `hidratar`
//    (`production_orders`, id) + la asignación; inactiva → `revocar` de la orden y de la asignación
//    (el cliente borra la orden y lo ajeno de ella, conserva lo propio). Cambio de rol o
//    reactivación del propio usuario → `reiniciar` (`users`, id).
// 5. Entidad no visible ahora: `revocar` si pudo verla antes (es de una orden que tuvo asignada, o
//    es un usuario que dejó de ser jefe/admin); si nunca pudo verla, se omite en silencio.

import {
  type CambioSync,
  MAX_CAMBIOS_PULL,
  MAX_FILAS_REVISADAS_PULL,
  type SyncPullResponse,
  type TipoCambioSync,
} from '@catmetal/shared';
import type { Contexto } from '../dominio/contexto';
import {
  descriptorDe,
  type Datos,
  epocaDe,
  esRolVisibleParaTodos,
  esVisible,
  type Fila,
  pudoSerVisible,
  sentenciaEpoca,
  sentenciaPorIds,
  type Visibilidad,
  visibilidadDe,
} from './entidades';

interface FilaVentana {
  seq: number;
  entidad: string;
  entidad_id: string;
  accion: string;
  order_id: string | null;
  /** Solo en filas de `users` (para detectar cambio de rol o reactivación). */
  antes: string | null;
  despues: string | null;
}

interface Propuesto {
  tipo: TipoCambioSync;
  entidad: string;
  id: string;
  datos: Datos | null;
}

/** Prioridad al deduplicar: un evento de visibilidad reemplaza a un `upsert` de la misma clave. */
const PRIORIDAD: Readonly<Record<TipoCambioSync, number>> = {
  upsert: 0,
  hidratar: 1,
  revocar: 1,
  reiniciar: 2,
};

const clave = (entidad: string, id: string): string => `${entidad}\u0000${id}`;

function objetoJson(texto: string | null): Record<string, unknown> | null {
  if (texto === null) {
    return null;
  }
  try {
    const valor: unknown = JSON.parse(texto);
    return typeof valor === 'object' && valor !== null ? (valor as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Cambio de rol o reactivación según la fila de auditoría del propio usuario. */
function cambiaAlcance(fila: FilaVentana): boolean {
  const antes = objetoJson(fila.antes);
  const despues = objetoJson(fila.despues);
  if (antes === null || despues === null) {
    return false;
  }
  const cambiaRol = 'rol' in antes && 'rol' in despues && antes.rol !== despues.rol;
  const reactivado = antes.activo === false && despues.activo === true;
  return cambiaRol || reactivado;
}

type Estados = ReadonlyMap<string, Fila>;

/** Cambios que produce una fila de la ventana (vacío si no le interesa al usuario). */
function evaluar(fila: FilaVentana, estados: Estados, vis: Visibilidad): Propuesto[] {
  const descriptor = descriptorDe(fila.entidad);
  if (descriptor === undefined) {
    return [];
  }
  const actual = estados.get(clave(fila.entidad, fila.entidad_id));
  if (actual === undefined) {
    return [];
  }
  const id = fila.entidad_id;
  const upsert: Propuesto = {
    tipo: 'upsert',
    entidad: fila.entidad,
    id,
    datos: descriptor.datos(actual),
  };
  const revocar: Propuesto = { tipo: 'revocar', entidad: fila.entidad, id, datos: null };

  if (fila.entidad === 'users' && id === vis.actorId) {
    return cambiaAlcance(fila)
      ? [{ tipo: 'reiniciar', entidad: 'users', id, datos: null }]
      : [upsert];
  }
  if (fila.entidad === 'order_supervisors' && !vis.todas && actual.user_id === vis.actorId) {
    const orderId = String(actual.order_id);
    return actual.activo === 1
      ? [{ tipo: 'hidratar', entidad: 'production_orders', id: orderId, datos: null }, upsert]
      : [{ tipo: 'revocar', entidad: 'production_orders', id: orderId, datos: null }, revocar];
  }
  const ambito = descriptor.ambito(actual);
  if (esVisible(vis, ambito)) {
    return [upsert];
  }
  if (fila.entidad === 'users') {
    // Dejó de ser jefe/admin: el supervisor lo tenía en su lista de nombres.
    const antes = objetoJson(fila.antes);
    return antes !== null && esRolVisibleParaTodos(antes.rol) ? [revocar] : [];
  }
  return pudoSerVisible(vis, ambito) ? [revocar] : [];
}

/** Estado actual de las entidades de la ventana, en un solo batch (un `json_each` por tabla). */
async function leerEstados(db: D1Database, filas: readonly FilaVentana[]): Promise<Estados> {
  const idsPorEntidad = new Map<string, Set<string>>();
  for (const fila of filas) {
    if (descriptorDe(fila.entidad) === undefined) {
      continue;
    }
    const ids = idsPorEntidad.get(fila.entidad) ?? new Set<string>();
    ids.add(fila.entidad_id);
    idsPorEntidad.set(fila.entidad, ids);
  }
  const consultas = [...idsPorEntidad].flatMap(([entidad, ids]) => {
    const descriptor = descriptorDe(entidad);
    return descriptor === undefined ? [] : [{ descriptor, ids: [...ids] }];
  });
  const estados = new Map<string, Fila>();
  if (consultas.length === 0) {
    return estados;
  }
  const resultados = await db.batch(
    consultas.map(({ descriptor, ids }) => sentenciaPorIds(db, descriptor, ids)),
  );
  consultas.forEach(({ descriptor }, i) => {
    for (const fila of (resultados[i]?.results ?? []) as Fila[]) {
      estados.set(clave(descriptor.entidad, descriptor.id(fila)), fila);
    }
  });
  return estados;
}

export async function pull(ctx: Contexto, cursor: number): Promise<SyncPullResponse> {
  const { db } = ctx;
  const [ventana, epoca, asignaciones] = await db.batch([
    db
      .prepare(
        `SELECT seq, entidad, entidad_id, accion, order_id,
           CASE WHEN entidad = 'users' THEN datos_antes END AS antes,
           CASE WHEN entidad = 'users' THEN datos_despues END AS despues
         FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .bind(cursor, MAX_FILAS_REVISADAS_PULL),
    sentenciaEpoca(db),
    db
      .prepare('SELECT order_id, activo FROM order_supervisors WHERE user_id = ?')
      .bind(ctx.actor.id),
  ]);
  const filas = (ventana?.results ?? []) as FilaVentana[];
  const vis = visibilidadDe(
    ctx,
    (asignaciones?.results ?? []) as { order_id: string; activo: number }[],
  );
  const estados = await leerEstados(db, filas);

  const cambios = new Map<string, CambioSync>();
  let nuevoCursor = cursor;
  let porCupo = false;
  for (const fila of filas) {
    const propuestos = evaluar(fila, estados, vis);
    const nuevas = new Set(
      propuestos.map((p) => clave(p.entidad, p.id)).filter((k) => !cambios.has(k)),
    ).size;
    if (cambios.size + nuevas > MAX_CAMBIOS_PULL) {
      // Esta fila no cabe: queda para el siguiente pull (el cursor no la incluye).
      porCupo = true;
      break;
    }
    for (const p of propuestos) {
      const k = clave(p.entidad, p.id);
      const previo = cambios.get(k);
      if (previo === undefined || PRIORIDAD[p.tipo] >= PRIORIDAD[previo.tipo]) {
        cambios.set(k, {
          seq: fila.seq,
          tipo: p.tipo,
          entidad: p.entidad,
          id: p.id,
          datos: p.datos,
        });
      } else {
        previo.seq = fila.seq;
      }
    }
    nuevoCursor = fila.seq;
    if (cambios.size >= MAX_CAMBIOS_PULL) {
      porCupo = true;
      break;
    }
  }

  return {
    epoca: epocaDe(epoca),
    cursor: nuevoCursor,
    hay_mas: porCupo || filas.length === MAX_FILAS_REVISADAS_PULL,
    cambios: [...cambios.values()],
  };
}

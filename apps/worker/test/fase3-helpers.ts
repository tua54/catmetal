// Utilidades de las pruebas de la Fase 3 (sincronización): mutaciones, push, pull y snapshot contra
// el Worker real con sesiones reales y la D1 local real (sin mocks).
import {
  type ResultadoMutacion,
  type SnapshotResponse,
  type SyncPullResponse,
  uuidv7,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { app } from '../src/app';
import { BASE, ORIGEN } from './auth-helpers';
import { api } from './fase2-helpers';
import { insertar } from './fixtures-db';

export interface MutacionPrueba {
  mutation_id: string;
  tipo: string;
  client_created_at: string;
  payload: Record<string, unknown>;
}

export function mutacion(
  tipo: string,
  payload: Record<string, unknown>,
  extra: Partial<MutacionPrueba> = {},
): MutacionPrueba {
  return {
    mutation_id: uuidv7(),
    tipo,
    client_created_at: new Date().toISOString(),
    payload,
    ...extra,
  };
}

export function crearConsumo(
  orderId: string,
  materialId: string,
  extra: Record<string, unknown> = {},
): MutacionPrueba {
  return mutacion('consumo.crear', {
    id: uuidv7(),
    order_id: orderId,
    material_id: materialId,
    cantidad: 10,
    unidad: 'kg',
    lote: 'L-2026-001',
    client_created_at: new Date().toISOString(),
    ...extra,
  });
}

export function editarConsumoMut(
  consumoId: string,
  version: number,
  extra: Record<string, unknown> = {},
): MutacionPrueba {
  return mutacion('consumo.editar', {
    id: consumoId,
    version,
    cantidad: 12,
    client_created_at: new Date().toISOString(),
    ...extra,
  });
}

export function crearNovedadMut(consumoId: string): MutacionPrueba {
  return mutacion('novedad.crear', {
    id: uuidv7(),
    consumption_id: consumoId,
    tipo: 'merma',
    descripcion: 'Se derramó arena al cargar la mezcladora',
    client_created_at: new Date().toISOString(),
    evidencias: [{ id: uuidv7(), mime: 'image/jpeg', tamano_bytes: 1234, sha256: 'a'.repeat(64) }],
  });
}

export function decidirMut(
  decision: 'aprobar' | 'rechazar',
  consumoId: string,
  version: number,
): MutacionPrueba {
  return mutacion(`consumo.${decision}`, {
    id: uuidv7(),
    consumption_id: consumoId,
    version,
    client_created_at: new Date().toISOString(),
    ...(decision === 'rechazar' ? { motivo: 'Cantidad no coincide con el lote' } : {}),
  });
}

export function push(token: string | undefined, userId: string, mutaciones: unknown[]) {
  return api('/sync/push', { token, body: { user_id: userId, mutaciones } });
}

export async function pushOk(
  token: string,
  userId: string,
  mutaciones: unknown[],
): Promise<ResultadoMutacion[]> {
  const respuesta = await push(token, userId, mutaciones);
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  return (await respuesta.json<{ resultados: ResultadoMutacion[] }>()).resultados;
}

export async function pullOk(token: string, cursor: number): Promise<SyncPullResponse> {
  const respuesta = await api(`/sync/pull?cursor=${String(cursor)}`, { token });
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  return respuesta.json<SyncPullResponse>();
}

/** Pull en bucle mientras `hay_mas` (como el motor del cliente). */
export async function pullTodo(
  token: string,
  cursor: number,
): Promise<{ cursor: number; cambios: SyncPullResponse['cambios']; paginas: number }> {
  const cambios: SyncPullResponse['cambios'] = [];
  let actual = cursor;
  for (let paginas = 1; paginas <= 50; paginas += 1) {
    const r = await pullOk(token, actual);
    cambios.push(...r.cambios);
    actual = r.cursor;
    if (!r.hay_mas) {
      return { cursor: actual, cambios, paginas };
    }
  }
  throw new Error('pull sin fin');
}

export function snapshotDe(token: string | undefined, query: string): Promise<Response> {
  return api(`/sync/snapshot?${query}`, { token });
}

export async function snapshotOk(token: string, query: string): Promise<SnapshotResponse> {
  const respuesta = await snapshotDe(token, query);
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  return respuesta.json<SnapshotResponse>();
}

/** Todas las páginas de un snapshot. */
export async function snapshotCompleto(
  token: string,
  query: string,
): Promise<{ paginas: SnapshotResponse[]; entidades: SnapshotResponse['entidades'] }> {
  const paginas: SnapshotResponse[] = [];
  let pagina: string | null = null;
  do {
    const r = await snapshotOk(
      token,
      pagina === null ? query : `${query}&pagina=${encodeURIComponent(pagina)}`,
    );
    paginas.push(r);
    pagina = r.siguiente_pagina;
  } while (pagina !== null && paginas.length < 100);
  return { paginas, entidades: paginas.flatMap((p) => p.entidades) };
}

export async function filaSync(mutationId: string) {
  return env.DB.prepare(
    'SELECT mutation_id, user_id, device_id, tipo, resultado, respuesta_json, payload_json FROM sync_mutations WHERE mutation_id = ?',
  )
    .bind(mutationId)
    .first<{
      mutation_id: string;
      user_id: string;
      device_id: string;
      tipo: string;
      resultado: string;
      respuesta_json: string;
      payload_json: string | null;
    }>();
}

export async function contar(tabla: string, where: string, ...params: unknown[]): Promise<number> {
  const fila = await env.DB.prepare(`SELECT count(*) AS n FROM ${tabla} WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  return fila?.n ?? 0;
}

/** Fila de auditoría escrita directamente (para llenar la ventana del pull rápido). */
export function filaAuditoria(
  entidad: string,
  entidadId: string,
  orderId: string | null = null,
): Record<string, string | number | null> {
  const t = new Date().toISOString();
  return {
    id: uuidv7(),
    entidad,
    entidad_id: entidadId,
    accion: 'prueba.relleno',
    order_id: orderId,
    actor_id: null,
    device_id: null,
    datos_antes: null,
    datos_despues: null,
    client_at: null,
    server_at: t,
    alerta_reloj: 0,
    created_at: t,
    updated_at: t,
  };
}

/** Inserta filas de auditoría en lotes (cada sentencia con 14 parámetros). */
export async function rellenarAuditoria(filas: Record<string, string | number | null>[]) {
  for (let i = 0; i < filas.length; i += 50) {
    await env.DB.batch(
      filas.slice(i, i + 50).map((f) => {
        const columnas = Object.keys(f);
        return env.DB.prepare(
          `INSERT INTO audit_log (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
        ).bind(...Object.values(f));
      }),
    );
  }
}

export { insertar };

// ---------------------------------------------------------------------------------------------
// Conteo de consultas a D1 (proxy que delega en la D1 REAL: no es un mock)
// ---------------------------------------------------------------------------------------------

export interface Conteo {
  /** Sentencias preparadas. */
  preparadas: number;
  /** Llamadas que llegan a D1: `first`/`all`/`run`/`raw` de una sentencia y cada `batch`. */
  llamadas: number;
  /** Sentencias ejecutadas (sueltas + las de cada batch). */
  ejecutadas: number;
  /** Máximo de parámetros enlazados en una sentencia. */
  maxParametros: number;
  /** Máximo de marcadores `?` en el SQL de una sentencia. */
  maxMarcadores: number;
}

function marcadores(sql: string): number {
  // `?` y `?NNN` (los numerados repetidos cuentan una vez).
  const numerados = new Set(sql.match(/\?\d+/g) ?? []);
  const anonimos = (sql.replace(/\?\d+/g, '').match(/\?/g) ?? []).length;
  return numerados.size + anonimos;
}

const METODOS_EJECUCION = ['first', 'all', 'run', 'raw'] as const;

/** `env.DB` envuelto: cuenta y delega cada llamada en la D1 local real. */
export function dbConConteo(): { db: D1Database; conteo: Conteo } {
  const real = env.DB;
  const conteo: Conteo = {
    preparadas: 0,
    llamadas: 0,
    ejecutadas: 0,
    maxParametros: 0,
    maxMarcadores: 0,
  };
  const instrumentar = (sentencia: D1PreparedStatement): D1PreparedStatement => {
    const bind = sentencia.bind.bind(sentencia);
    Object.defineProperty(sentencia, 'bind', {
      value: (...valores: unknown[]) => {
        conteo.maxParametros = Math.max(conteo.maxParametros, valores.length);
        return instrumentar(bind(...valores));
      },
    });
    for (const metodo of METODOS_EJECUCION) {
      const original = (sentencia[metodo] as (...a: unknown[]) => unknown).bind(sentencia);
      Object.defineProperty(sentencia, metodo, {
        value: (...a: unknown[]) => {
          conteo.llamadas += 1;
          conteo.ejecutadas += 1;
          return original(...a);
        },
      });
    }
    return sentencia;
  };
  const db = new Proxy(real, {
    get(objetivo, propiedad) {
      if (propiedad === 'prepare') {
        return (sql: string) => {
          conteo.preparadas += 1;
          conteo.maxMarcadores = Math.max(conteo.maxMarcadores, marcadores(sql));
          return instrumentar(objetivo.prepare(sql));
        };
      }
      if (propiedad === 'batch') {
        return (sentencias: D1PreparedStatement[]) => {
          conteo.llamadas += 1;
          conteo.ejecutadas += sentencias.length;
          return objetivo.batch(sentencias);
        };
      }
      const valor: unknown = Reflect.get(objetivo, propiedad);
      return typeof valor === 'function'
        ? (valor as (...a: unknown[]) => unknown).bind(objetivo)
        : valor;
    },
  });
  return { db, conteo };
}

/** Llama a la app con otra D1 (el proxy de conteo) y el resto del `env` real. */
export async function llamarConDb(
  db: D1Database,
  ruta: string,
  opciones: { token: string; body?: unknown },
): Promise<Response> {
  const headers = new Headers({ Origin: ORIGEN, Authorization: `Bearer ${opciones.token}` });
  if (opciones.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return app.request(
    `${BASE}/api/v1${ruta}`,
    {
      method: opciones.body === undefined ? 'GET' : 'POST',
      headers,
      body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
    },
    { ...env, DB: db },
  );
}

// ---------------------------------------------------------------------------------------------
// Barrera para carreras deterministas (delega en la D1 REAL: no es un mock)
// ---------------------------------------------------------------------------------------------

/**
 * `env.DB` envuelto: las escrituras cuyo SQL contiene `marca` esperan hasta que `participantes`
 * peticiones llegan a ese punto y entonces se ejecutan todas contra la D1 real (que las serializa).
 * Solo espera la primera ronda; después la barrera deja pasar todo. Así dos pushes concurrentes
 * leen el mismo estado antes de que cualquiera escriba: la carrera real que se quiere probar.
 */
export function dbConBarrera(participantes: number, marca: string): D1Database {
  const real = env.DB;
  const sqlDe = new WeakMap<object, string>();
  let esperando = 0;
  let soltar: () => void = () => undefined;
  const abierta = new Promise<void>((resolver) => {
    soltar = resolver;
  });
  let rondaTerminada = false;
  const esperar = async (): Promise<void> => {
    if (rondaTerminada) {
      return;
    }
    esperando += 1;
    if (esperando >= participantes) {
      rondaTerminada = true;
      soltar();
    }
    await abierta;
  };
  const instrumentar = (sentencia: D1PreparedStatement, sql: string): D1PreparedStatement => {
    sqlDe.set(sentencia, sql);
    const bind = sentencia.bind.bind(sentencia);
    const run = sentencia.run.bind(sentencia);
    Object.defineProperty(sentencia, 'bind', {
      value: (...valores: unknown[]) => instrumentar(bind(...valores), sql),
    });
    Object.defineProperty(sentencia, 'run', {
      value: async () => {
        if (sql.includes(marca)) {
          await esperar();
        }
        return run();
      },
    });
    return sentencia;
  };
  return new Proxy(real, {
    get(objetivo, propiedad) {
      if (propiedad === 'prepare') {
        return (sql: string) => instrumentar(objetivo.prepare(sql), sql);
      }
      if (propiedad === 'batch') {
        return async (sentencias: D1PreparedStatement[]) => {
          if (sentencias.some((s) => (sqlDe.get(s) ?? '').includes(marca))) {
            await esperar();
          }
          return objetivo.batch(sentencias);
        };
      }
      const valor: unknown = Reflect.get(objetivo, propiedad);
      return typeof valor === 'function'
        ? (valor as (...a: unknown[]) => unknown).bind(objetivo)
        : valor;
    },
  });
}

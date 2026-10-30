// Snapshot `inicial` en un área temporal y reemplazo atómico del estado sincronizado (ADR 0022;
// correcciones v1.1, M5 y M6).
//
// 1. El motor guarda cada página en `snapshot_entidades` / `snapshot_progreso` (fuera de
//    `tablasDeDatos()`): los datos vivos NO se tocan mientras baja el snapshot. Si la red se cae, el
//    supervisor sigue con sus órdenes y materiales y puede registrar offline; la próxima sync reanuda
//    con el token guardado.
// 2. Con la última página guardada, `completarSnapshot` reemplaza el estado de la partición en UNA
//    transacción: catálogos, entidades con la regla `autoridad` (el servidor manda sobre todo lo que no
//    esté pendiente), limpieza de lo que el servidor ya no tiene, cursor y época. O todo o nada.
//
// Cuota agotada (A7, ADR 0022 Enmienda 1): si guardar una página o el reemplazo falla con
// `QuotaExceededError`, se descarta el área temporal del usuario y se relanza el error. El estado vivo
// no se toca (el reemplazo es una sola transacción: si se aborta, no aplicó nada). El motor reintenta
// con espera y avisa.
//
// Solo se toca la partición del usuario: nunca se leen ni escriben filas de otro usuario de la tablet.

import Dexie from 'dexie';
import { ahoraIso, type SnapshotResponse } from '@catmetal/shared';
import { aplicarUpsert, metaInicial, type EntidadSync } from './aplicar-cambios';
import { claveEntidad, db, rangoDe, tablasDeDatos, tablasDeSnapshot } from './db';
import { entidadTieneCola, evidenciaProtegida, recalcular } from './derivar';
import {
  borrarConsumoConHijos,
  borrarNovedadConFotos,
  consumoProtegido,
  novedadProtegida,
  reencolarAplicadas,
  type EntidadAfectada,
} from './entidades';
import type { EntidadSnapshotLocal, OrdenLocal, ProgresoSnapshot, TablaMutable } from './tipos';

/** Una descarga más vieja que esto no se reanuda: se empieza de cero (acota el área temporal). */
export const MAX_EDAD_SNAPSHOT_MS = 24 * 60 * 60 * 1000;

/** Entidades del snapshot por tabla de catálogo (se reemplazan completas). */
const CATALOGOS = [
  'production_orders',
  'order_planned_materials',
  'order_supervisors',
  'materials',
  'settings',
  'users',
] as const;

/**
 * Entidades de negocio, en el orden en que se aplican: los hijos ANTES que su consumo, para que la
 * vista del consumo se derive una sola vez con sus validaciones y novedades ya escritas.
 */
const NEGOCIO: Readonly<Record<string, TablaMutable>> = {
  incidents: 'novedades',
  evidences: 'evidencias',
  validations: 'validaciones',
  consumptions: 'consumos',
};

/** Entidades que se guardan en el área temporal; las desconocidas se ignoran (como en el pull). */
const CONOCIDAS: ReadonlySet<string> = new Set([...CATALOGOS, ...Object.keys(NEGOCIO)]);

/** Tamaño de los bloques con que se recorre el área temporal en el reemplazo. */
const BLOQUE = 500;

export interface ResultadoPaginaSnapshot {
  /** `epoca_distinta`: la página es de otra época que las anteriores; no se guardó nada. */
  resultado: 'guardada' | 'epoca_distinta';
  /** Ya se guardó la última página. */
  completo: boolean;
}

export interface ResultadoCompletarSnapshot {
  /** Se hizo el reemplazo (había un snapshot completo). */
  reemplazado: boolean;
  /** El reemplazo cambió la época de `meta`: hay que reenviar las mutaciones reencoladas. */
  epoca_cambiada: boolean;
  aplicados: number;
  ignorados: number;
}

/** Nombres con que IndexedDB (y Dexie, que conserva el nombre) informa la cuota agotada. */
const NOMBRES_CUOTA: ReadonlySet<string> = new Set([
  'QuotaExceededError',
  // Firefox antiguo.
  'NS_ERROR_DOM_QUOTA_REACHED',
]);

/**
 * ¿El error es (o envuelve) una cuota de almacenamiento agotada? Reconoce el `DOMException` de
 * IndexedDB, `Dexie.QuotaExceededError` y los envoltorios de Dexie: `AbortError` de la transacción
 * (`inner`), `BulkError` (`failures`) y `cause`. La profundidad está acotada.
 */
export function esCuotaAgotada(error: unknown, profundidad = 0): boolean {
  if (profundidad > 5 || typeof error !== 'object' || error === null) {
    return false;
  }
  const e = error as { name?: unknown; inner?: unknown; cause?: unknown; failures?: unknown };
  if (typeof e.name === 'string' && NOMBRES_CUOTA.has(e.name)) {
    return true;
  }
  if (esCuotaAgotada(e.inner, profundidad + 1) || esCuotaAgotada(e.cause, profundidad + 1)) {
    return true;
  }
  return Array.isArray(e.failures) && e.failures.some((f) => esCuotaAgotada(f, profundidad + 1));
}

/**
 * A7: ejecuta una escritura del snapshot; si falla por cuota agotada, descarta el área temporal del
 * usuario (libera espacio y evita reanudar una descarga que no cabe) y relanza el error original.
 * Corre FUERA de la transacción que falló: esa ya se abortó sin aplicar nada.
 */
async function descartandoSiNoCabe<T>(userId: string, escribir: () => Promise<T>): Promise<T> {
  try {
    return await escribir();
  } catch (error) {
    if (esCuotaAgotada(error)) {
      try {
        await descartarSnapshot(userId);
      } catch {
        // Lo que importa es el error de cuota; el motor vuelve a descartar al reintentar.
      }
    }
    throw error;
  }
}

/** Progreso del snapshot `inicial` del usuario, si hay uno a medias o completo sin reemplazar. */
export async function leerProgresoSnapshot(userId: string): Promise<ProgresoSnapshot | undefined> {
  return db.snapshot_progreso.get(userId);
}

/** ¿Se puede reanudar (o reemplazar) la descarga guardada? Si no, hay que empezar de cero. */
export function progresoVigente(progreso: ProgresoSnapshot, ahora: Date = new Date()): boolean {
  if (progreso.completo) {
    return true;
  }
  const edad = ahora.getTime() - new Date(progreso.iniciado_at).getTime();
  return progreso.siguiente_pagina !== null && edad >= 0 && edad < MAX_EDAD_SNAPSHOT_MS;
}

/** Borra el área temporal del usuario (para empezar de cero). Dentro de una transacción o sola. */
export async function borrarAreaTemporal(userId: string): Promise<void> {
  await db.snapshot_entidades
    .where(':id')
    .between(...rangoDe(userId))
    .delete();
  await db.snapshot_progreso.delete(userId);
}

/** Descarta la descarga guardada del usuario. No toca los datos vivos. */
export async function descartarSnapshot(userId: string): Promise<void> {
  await db.transaction('rw', tablasDeSnapshot(), () => borrarAreaTemporal(userId));
}

/**
 * Guarda una página del snapshot `inicial` en el área temporal, en UNA transacción. La primera
 * página (sin progreso) fija la época y el cursor. Una página de otra época no se guarda. Con la
 * cuota agotada, descarta el área temporal y relanza (A7).
 */
export async function guardarPaginaSnapshot(
  userId: string,
  respuesta: SnapshotResponse,
  ahora: string = ahoraIso(),
): Promise<ResultadoPaginaSnapshot> {
  return descartandoSiNoCabe(userId, () => guardarPagina(userId, respuesta, ahora));
}

function guardarPagina(
  userId: string,
  respuesta: SnapshotResponse,
  ahora: string,
): Promise<ResultadoPaginaSnapshot> {
  return db.transaction('rw', tablasDeSnapshot(), async () => {
    const previo = await db.snapshot_progreso.get(userId);
    if (previo !== undefined && previo.epoca !== respuesta.epoca) {
      return { resultado: 'epoca_distinta', completo: false };
    }
    if (previo?.completo === true) {
      return { resultado: 'guardada', completo: true };
    }
    const filas: EntidadSnapshotLocal[] = respuesta.entidades
      .filter((e) => CONOCIDAS.has(e.entidad))
      .map((e) => ({ user_id: userId, entidad: e.entidad, id: e.id, datos: e.datos }));
    await db.snapshot_entidades.bulkPut(filas);
    const completo = respuesta.siguiente_pagina === null;
    await db.snapshot_progreso.put({
      user_id: userId,
      alcance: 'inicial',
      epoca: previo?.epoca ?? respuesta.epoca,
      cursor: previo?.cursor ?? respuesta.cursor,
      iniciado_at: previo?.iniciado_at ?? ahora,
      siguiente_pagina: respuesta.siguiente_pagina,
      paginas: (previo?.paginas ?? 0) + 1,
      completo,
      actualizado_at: ahora,
    });
    return { resultado: 'guardada', completo };
  });
}

/** Recorre las filas del área temporal de una entidad por bloques (keyset), sin cargarlas todas. */
async function recorrerEntidad(
  userId: string,
  entidad: string,
  alBloque: (filas: EntidadSnapshotLocal[]) => Promise<void>,
): Promise<void> {
  let desde: unknown[] = [userId, entidad, Dexie.minKey];
  let incluirDesde = true;
  const hasta = [userId, entidad, Dexie.maxKey];
  for (;;) {
    const filas = await db.snapshot_entidades
      .where(':id')
      .between(desde, hasta, incluirDesde, true)
      .limit(BLOQUE)
      .toArray();
    if (filas.length === 0) {
      return;
    }
    await alBloque(filas);
    const ultima = filas[filas.length - 1]!;
    desde = [userId, entidad, ultima.id];
    incluirDesde = false;
    if (filas.length < BLOQUE) {
      return;
    }
  }
}

/**
 * Entidad con mutaciones en cola que el snapshot NO devolvió: su `servidor` es de antes del reinicio
 * (no comparable) y su `servidor_diferido` también. Se marca obsoleto para que la respuesta del
 * reenvío lo reemplace sin comparar versiones (ADR 0022, punto 5).
 */
function obsoletoSiCola<T>(
  fila: { servidor: T | null },
  enCola: boolean,
): { servidor_obsoleto?: boolean; servidor_diferido?: null } {
  return enCola && fila.servidor !== null
    ? { servidor_obsoleto: true, servidor_diferido: null }
    : {};
}

/** Claves `user_id|tabla|id` confirmadas por mutaciones propias aplicadas desde `desde`. */
async function confirmadasDesde(userId: string, desde: string): Promise<Set<string>> {
  const aplicadas = await db.outbox
    .where('[user_id+estado+seq_local]')
    .between(...rangoDe(userId, 'aplicada'))
    .filter((m) => m.aplicada_at !== null && m.aplicada_at >= desde)
    .toArray();
  return new Set(aplicadas.flatMap((m) => m.claves));
}

/**
 * Reemplaza el estado sincronizado de la partición con el snapshot completo del área temporal, en
 * UNA transacción (ADR 0022, punto 4). Si no hay un snapshot completo, no hace nada. Si algo falla,
 * IndexedDB aborta y queda todo como antes (datos vivos, `meta` y área temporal). Con la cuota
 * agotada, además se descarta el área temporal y se relanza (A7): los datos vivos siguen intactos.
 */
export async function completarSnapshot(
  userId: string,
  opciones: { ahora?: string } = {},
): Promise<ResultadoCompletarSnapshot> {
  const ahora = opciones.ahora ?? ahoraIso();
  return descartandoSiNoCabe(userId, () => reemplazar(userId, ahora));
}

function reemplazar(userId: string, ahora: string): Promise<ResultadoCompletarSnapshot> {
  return db.transaction('rw', [...tablasDeDatos(), ...tablasDeSnapshot()], async () => {
    const progreso = await db.snapshot_progreso.get(userId);
    if (progreso === undefined || !progreso.completo) {
      return { reemplazado: false, epoca_cambiada: false, aplicados: 0, ignorados: 0 };
    }
    const meta = (await db.meta.get(userId)) ?? metaInicial(userId);
    const rango = rangoDe(userId);
    const afectadas: EntidadAfectada[] = [];

    // 1. Época: si la que se confirma es otra, se reencolan las aplicadas (idempotente: puede que ya
    //    se hiciera al detectarla en el pull).
    const epocaCambiada = meta.epoca !== null && meta.epoca !== progreso.epoca;
    if (epocaCambiada) {
      afectadas.push(...(await reencolarAplicadas(userId, ahora)).afectadas);
    }
    // Entidades que un push de una sync posterior confirmó mientras la descarga estaba a medias
    // (solo pasa en la misma época: con otra, el push recibe EPOCA_CAMBIADA). Son comparables por
    // versión con el snapshot y nunca se borran ni se marcan perdidas aquí; el pull las confirma.
    const confirmadas = await confirmadasDesde(userId, progreso.iniciado_at);

    // 2. Catálogos: se reemplazan completos.
    const ordenesPrevias = new Map<string, OrdenLocal>(
      (
        await db.ordenes
          .where(':id')
          .between(...rango)
          .toArray()
      ).map((o) => [o.id, o]),
    );
    for (const tabla of [
      db.ordenes,
      db.planeados,
      db.asignaciones,
      db.materiales,
      db.settings,
      db.usuarios,
    ]) {
      await tabla
        .where(':id')
        .between(...rango)
        .delete();
    }
    let aplicados = 0;
    let ignorados = 0;
    const vistos = new Set<string>();
    const aplicar = async (fila: EntidadSync, tabla: TablaMutable | null): Promise<void> => {
      const confirmada = tabla !== null && confirmadas.has(claveEntidad(userId, tabla, fila.id));
      const r = await aplicarUpsert(userId, fila, ahora, confirmada ? 'pull' : 'autoridad');
      if (r === null) {
        ignorados += 1;
        return;
      }
      aplicados += 1;
      for (const a of r) {
        vistos.add(claveEntidad(userId, a.tabla, a.id));
      }
      afectadas.push(...r);
    };
    for (const entidad of CATALOGOS) {
      await recorrerEntidad(userId, entidad, async (filas) => {
        for (const fila of filas) {
          await aplicar(fila, null);
        }
      });
    }

    // 3. Entidades de negocio que llegaron: el servidor manda (`autoridad`).
    for (const [entidad, tabla] of Object.entries(NEGOCIO)) {
      await recorrerEntidad(userId, entidad, async (filas) => {
        for (const fila of filas) {
          await aplicar(fila, tabla);
        }
      });
    }

    // 4. Lo que el servidor ya no tiene.
    const conservar = (tabla: TablaMutable, id: string): boolean => {
      const clave = claveEntidad(userId, tabla, id);
      return vistos.has(clave) || confirmadas.has(clave);
    };
    const consumos = await db.consumos
      .where(':id')
      .between(...rango)
      .toArray();
    const ordenesConservadas = new Set<string>();
    for (const c of consumos) {
      if (conservar('consumos', c.id)) {
        ordenesConservadas.add(c.order_id);
        continue;
      }
      const enCola = await entidadTieneCola(userId, 'consumos', c.id);
      if (c.registrado_por === userId) {
        // Lo propio NUNCA se borra (ADR 0016, M1). Sin cola, el servidor ya no lo tiene: se marca
        // perdido (la UI ofrece reenviarlo). Con cola, la mutación lo vuelve a crear.
        await db.consumos.put({
          ...c,
          ...obsoletoSiCola(c, enCola),
          verificar_en_snapshot: false,
          perdido_en_restauracion: !enCola,
        });
        ordenesConservadas.add(c.order_id);
      } else if (await consumoProtegido(userId, c, false)) {
        await db.consumos.put({ ...c, ...obsoletoSiCola(c, enCola) });
        ordenesConservadas.add(c.order_id);
      } else {
        await borrarConsumoConHijos(userId, c.id);
      }
    }

    // Validaciones que el servidor ya no tiene (sin cola): fuera, aunque su consumo se conserve (M6).
    const validaciones = await db.validaciones
      .where(':id')
      .between(...rango)
      .toArray();
    for (const v of validaciones) {
      if (conservar('validaciones', v.id)) {
        continue;
      }
      if (await entidadTieneCola(userId, 'validaciones', v.id)) {
        await db.validaciones.put({ ...v, ...obsoletoSiCola(v, true) });
      } else {
        await db.validaciones.delete([userId, v.id]);
        afectadas.push({ tabla: 'consumos', id: v.consumption_id });
      }
    }

    // Novedades: se conservan las protegidas y las propias cuyo consumo sigue (dato de planta).
    const novedadesConservadas = new Set<string>();
    const novedades = await db.novedades
      .where(':id')
      .between(...rango)
      .toArray();
    for (const n of novedades) {
      if (conservar('novedades', n.id)) {
        continue;
      }
      const consumoSigue = (await db.consumos.get([userId, n.consumption_id])) !== undefined;
      if ((await novedadProtegida(userId, n.id)) || (n.registrado_por === userId && consumoSigue)) {
        const enCola = await entidadTieneCola(userId, 'novedades', n.id);
        if (enCola) {
          await db.novedades.put({ ...n, ...obsoletoSiCola(n, true) });
        }
        novedadesConservadas.add(n.id);
      } else {
        await borrarNovedadConFotos(userId, n.id);
        afectadas.push({ tabla: 'consumos', id: n.consumption_id });
      }
    }

    // Evidencias: se conservan las que tienen bytes por subir y las de novedades conservadas.
    const evidencias = await db.evidencias
      .where(':id')
      .between(...rango)
      .toArray();
    for (const e of evidencias) {
      if (
        !conservar('evidencias', e.id) &&
        !evidenciaProtegida(e) &&
        !novedadesConservadas.has(e.incident_id)
      ) {
        await db.evidencias.delete([userId, e.id]);
      }
    }

    // Órdenes que ya no llegan pero de las que se conservan consumos: se muestran como revocadas.
    for (const orderId of ordenesConservadas) {
      const previa = ordenesPrevias.get(orderId);
      if (previa !== undefined && (await db.ordenes.get([userId, orderId])) === undefined) {
        await db.ordenes.put({ ...previa, revocada: true });
      }
    }

    // 5. Vista local, cursor y época (solo aquí, junto con el reemplazo), y limpieza del área.
    await recalcular(userId, afectadas);
    await db.meta.put({
      ...meta,
      cursor: progreso.cursor,
      epoca: progreso.epoca,
      ultimo_sync_at: ahora,
      requiere_snapshot: false,
      motivo_snapshot: null,
      hidrataciones: [],
    });
    await borrarAreaTemporal(userId);
    return { reemplazado: true, epoca_cambiada: epocaCambiada, aplicados, ignorados };
  });
}

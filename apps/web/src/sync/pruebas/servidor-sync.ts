// Servidor de sincronización simulado (solo la red se simula; IndexedDB es la real de
// fake-indexeddb). Implementa el contrato de shared:
// - `POST /sync/push`: sobre `{ user_id, mutaciones }`; 403 `AUTOR_NO_COINCIDE` si `user_id ≠ sub`;
//   resultados por `indice`; idempotencia por `mutation_id` ligada al usuario; dependencia rechazada;
//   un error transitorio detiene el lote y las siguientes quedan sin resultado; una colisión de id
//   (mutation_id de otro usuario o entidad que ya existe) responde `conflicto` `ID_DUPLICADO` sin
//   `servidor` (B3).
// - `GET /sync/pull?cursor=`: `audit_log` por `seq`, estado actual, `hay_mas`, cursor = último revisado.
// - `GET /sync/snapshot`: estado actual paginado; cursor = `MAX(seq)` al pedir la primera página.
// - `PUT /evidences/:id`: sha256 del cuerpo; 404 `EVIDENCIA_DESCONOCIDA`; 409 si ya se subió otra.
// El token es `tok-<user_id>`.

import {
  crearError,
  ESTADO_HTTP_POR_CODIGO,
  leerMutationId,
  MENSAJES_ERROR,
  mutacionSchema,
  type CambioSync,
  type CodigoError,
  type Consumo,
  type Evidencia,
  type Mutacion,
  type Novedad,
  type ResultadoMutacion,
  type Validacion,
} from '@catmetal/shared';
import { urlDe } from '../../auth/pruebas/servidor-falso';

type Datos = Record<string, unknown>;

export interface PeticionSync {
  metodo: string;
  ruta: string;
  query: URLSearchParams;
  user_id: string | null;
  cuerpo: unknown;
}

interface Registro {
  seq: number;
  tipo: CambioSync['tipo'];
  entidad: string;
  id: string;
  datos: Datos | null;
}

export interface ServidorSync {
  fetch: typeof fetch;
  peticiones: PeticionSync[];
  epoca: string;
  tamPull: number;
  tamSnapshot: number;
  /** Rechaza mutaciones según una regla (devuelve el código o `null`). */
  reglaRechazo: ((m: Mutacion) => CodigoError | null) | null;
  /** Próximos N push responden 503. */
  push503: number;
  /** Próximos N push se aplican pero la respuesta se pierde (la red falla al responder). */
  perderRespuestaPush: number;
  /** En el próximo push, se detiene (error transitorio) al llegar a este índice. */
  transitorioEnIndice: number | null;
  /** Próximos N PUT de evidencias responden 404 EVIDENCIA_DESCONOCIDA. */
  evidenciaDesconocida: number;
  /** Próximos PUT de evidencias responden este error permanente. */
  errorEvidencia: CodigoError | null;
  /** Gancho antes de responder una petición (para cambiar la sesión a mitad de camino). */
  alRecibir: ((p: PeticionSync) => void) | null;
  /** Órdenes cuyo snapshot de alcance `orden` responde 404 (desasignadas). */
  ordenesNoVisibles: Set<string>;
  /**
   * La N-ésima petición de snapshot `inicial` (contando desde que se asigna) falla por red
   * (`TypeError`) sin responder; después vuelve a `null`.
   */
  fallarSnapshotEnPagina: number | null;
  /** Próximas N peticiones de snapshot con `pagina` responden 400 `VALIDACION` (token inválido). */
  rechazarPaginaSnapshot: number;
  /** `epoca` recibida en cada push (`null` si no vino). */
  epocasRecibidas: (string | null)[];
  seq(): number;
  entidades(entidad: string): Datos[];
  pushes(): PeticionSync[];
  /** Mutaciones recibidas en cada push, en orden. */
  mutacionesPorPush(): string[][];
  /** Escribe una entidad y su fila de auditoría (`registrar: false` = sin auditoría). */
  upsert(entidad: string, id: string, datos: Datos, registrar?: boolean): void;
  agregarCambio(tipo: CambioSync['tipo'], entidad: string, id: string): void;
  fotosSubidas(): string[];
  /** Restauración con Time Travel: época nueva y se pierde lo escrito por mutaciones. */
  restaurar(epocaNueva: string): void;
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(code: CodigoError): Response {
  return json(crearError(code), ESTADO_HTTP_POR_CODIGO[code]);
}

/** Colisión de clave primaria (B3): conflicto SIN `servidor` (no se filtra la fila ajena). */
function colisionDeId(): Omit<ResultadoMutacion, 'indice' | 'mutation_id'> {
  return { resultado: 'conflicto', code: 'ID_DUPLICADO', message: MENSAJES_ERROR.ID_DUPLICADO };
}

async function sha256(datos: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function crearServidorSync(): ServidorSync {
  const peticiones: PeticionSync[] = [];
  const estado = new Map<string, { entidad: string; id: string; datos: Datos }>();
  const log: Registro[] = [];
  const mutaciones = new Map<
    string,
    { user_id: string; resultado: Omit<ResultadoMutacion, 'indice'> }
  >();
  const creacionesRechazadas = new Set<string>();
  const fotos = new Map<string, string>();
  let seq = 0;

  const clave = (entidad: string, id: string): string => `${entidad}:${id}`;
  const ahora = (): string => new Date().toISOString();

  function upsert(entidad: string, id: string, datos: Datos, registrar = true): void {
    estado.set(clave(entidad, id), { entidad, id, datos });
    if (registrar) {
      seq += 1;
      log.push({ seq, tipo: 'upsert', entidad, id, datos: null });
    }
  }

  function aplicar(m: Mutacion, userId: string): Omit<ResultadoMutacion, 'indice'> {
    const rechazo = servidor.reglaRechazo?.(m) ?? null;
    const consumoId =
      m.tipo === 'consumo.crear' || m.tipo === 'consumo.editar'
        ? m.payload.id
        : m.payload.consumption_id;
    if (m.tipo !== 'consumo.crear' && creacionesRechazadas.has(consumoId)) {
      return { mutation_id: m.mutation_id, resultado: 'rechazada', code: 'DEPENDENCIA_RECHAZADA' };
    }
    if (rechazo !== null) {
      if (m.tipo === 'consumo.crear') {
        creacionesRechazadas.add(consumoId);
      }
      return {
        mutation_id: m.mutation_id,
        resultado: 'rechazada',
        code: rechazo,
        message: 'Rechazada.',
      };
    }
    const actual = estado.get(clave('consumptions', consumoId))?.datos as Consumo | undefined;
    if (colisiona(m)) {
      return { mutation_id: m.mutation_id, ...colisionDeId() };
    }
    switch (m.tipo) {
      case 'consumo.crear': {
        const p = m.payload;
        const c: Consumo = {
          id: p.id,
          order_id: p.order_id,
          material_id: p.material_id,
          cantidad: p.cantidad,
          unidad: p.unidad,
          cantidad_en_unidad_plan: p.cantidad,
          lote: p.lote,
          costo_unitario_cop_snapshot: 0,
          registrado_por: userId,
          device_id: 'dispositivo',
          client_created_at: p.client_created_at,
          server_received_at: ahora(),
          estado: 'pendiente',
          corrige_a: p.corrige_a ?? null,
          registro_tardio: false,
          requiere_novedad: false,
          version: 1,
          created_at: ahora(),
          updated_at: ahora(),
        };
        upsert('consumptions', c.id, { ...c });
        return { mutation_id: m.mutation_id, resultado: 'aplicada', servidor: { ...c } };
      }
      case 'consumo.editar': {
        if (actual === undefined) {
          return { mutation_id: m.mutation_id, resultado: 'rechazada', code: 'NO_ENCONTRADO' };
        }
        if (actual.estado !== 'pendiente') {
          return {
            mutation_id: m.mutation_id,
            resultado: 'rechazada',
            code: 'CONSUMO_NO_PENDIENTE',
            servidor: { ...actual },
          };
        }
        if (actual.version !== m.payload.version) {
          return {
            mutation_id: m.mutation_id,
            resultado: 'conflicto',
            code: 'CONFLICTO',
            servidor: { ...actual },
          };
        }
        const p = m.payload;
        const cambios = {
          material_id: p.material_id ?? actual.material_id,
          cantidad: p.cantidad ?? actual.cantidad,
          unidad: p.unidad ?? actual.unidad,
          lote: p.lote ?? actual.lote,
        };
        const c: Consumo = {
          ...actual,
          ...cambios,
          version: actual.version + 1,
          updated_at: ahora(),
        };
        upsert('consumptions', c.id, { ...c });
        return { mutation_id: m.mutation_id, resultado: 'aplicada', servidor: { ...c } };
      }
      case 'novedad.crear': {
        if (actual === undefined) {
          return { mutation_id: m.mutation_id, resultado: 'rechazada', code: 'NO_ENCONTRADO' };
        }
        const { evidencias: metas, ...p } = m.payload;
        const n: Novedad = {
          ...p,
          registrado_por: userId,
          server_received_at: ahora(),
          created_at: ahora(),
          updated_at: ahora(),
        };
        upsert('incidents', n.id, { ...n });
        const evidencias: Evidencia[] = metas.map((e) => ({
          ...e,
          incident_id: n.id,
          subido: false,
          subido_at: null,
          created_at: ahora(),
          updated_at: ahora(),
        }));
        for (const e of evidencias) {
          upsert('evidences', e.id, { ...e });
        }
        return {
          mutation_id: m.mutation_id,
          resultado: 'aplicada',
          servidor: { ...n, evidencias },
        };
      }
      default: {
        if (actual === undefined) {
          return { mutation_id: m.mutation_id, resultado: 'rechazada', code: 'NO_ENCONTRADO' };
        }
        if (actual.estado !== 'pendiente') {
          return {
            mutation_id: m.mutation_id,
            resultado: 'rechazada',
            code: 'CONSUMO_NO_PENDIENTE',
            servidor: { ...actual },
          };
        }
        const decision = m.tipo === 'consumo.aprobar' ? 'aprobado' : 'rechazado';
        const v: Validacion = {
          id: m.payload.id,
          consumption_id: actual.id,
          decision,
          motivo: 'motivo' in m.payload ? m.payload.motivo : null,
          validado_por: userId,
          client_created_at: m.payload.client_created_at,
          server_received_at: ahora(),
          created_at: ahora(),
          updated_at: ahora(),
        };
        const c: Consumo = { ...actual, estado: decision, version: actual.version + 1 };
        upsert('validations', v.id, { ...v });
        upsert('consumptions', c.id, { ...c });
        return {
          mutation_id: m.mutation_id,
          resultado: 'aplicada',
          servidor: { consumo: c, validacion: v },
        };
      }
    }
  }

  /**
   * Como el real (B3, commit f8b5c1b): el id que crea la mutación ya existe en el servidor (de otra
   * persona, o propio con otra clave natural). El reintento propio de la MISMA mutación no llega
   * aquí: lo responde la idempotencia por `mutation_id`.
   */
  function colisiona(m: Mutacion): boolean {
    switch (m.tipo) {
      case 'consumo.crear':
        return estado.has(clave('consumptions', m.payload.id));
      case 'novedad.crear':
        return (
          estado.has(clave('incidents', m.payload.id)) ||
          m.payload.evidencias.some((e) => estado.has(clave('evidences', e.id)))
        );
      case 'consumo.aprobar':
      case 'consumo.rechazar':
        return estado.has(clave('validations', m.payload.id));
      default:
        return false;
    }
  }

  function push(userId: string, cuerpo: unknown): Response {
    const sobre = cuerpo as { user_id?: unknown; epoca?: unknown; mutaciones?: unknown };
    if (sobre.user_id !== userId) {
      return error('AUTOR_NO_COINCIDE');
    }
    servidor.epocasRecibidas.push(typeof sobre.epoca === 'string' ? sobre.epoca : null);
    // ADR 0016 (A1): época vieja → 409 sin procesar ni guardar nada. Sin época se procesa.
    if (sobre.epoca !== undefined && sobre.epoca !== servidor.epoca) {
      return error('EPOCA_CAMBIADA');
    }
    if (!Array.isArray(sobre.mutaciones) || sobre.mutaciones.length > 25) {
      return error('VALIDACION');
    }
    if (servidor.push503 > 0) {
      servidor.push503 -= 1;
      return json(crearError('ERROR_INTERNO'), 503);
    }
    const resultados: ResultadoMutacion[] = [];
    for (const [indice, cruda] of (sobre.mutaciones as unknown[]).entries()) {
      const id = leerMutationId(cruda);
      if (id === null) {
        resultados.push({ indice, resultado: 'rechazada', code: 'VALIDACION' });
        continue;
      }
      if (servidor.transitorioEnIndice === indice) {
        // Error transitorio (D1 sobrecargada): se detiene; las siguientes quedan sin resultado.
        servidor.transitorioEnIndice = null;
        break;
      }
      const guardada = mutaciones.get(id);
      if (guardada !== undefined) {
        resultados.push(
          guardada.user_id === userId
            ? { ...guardada.resultado, indice }
            : { indice, mutation_id: id, ...colisionDeId() },
        );
        continue;
      }
      const leida = mutacionSchema.safeParse(cruda);
      const resultado = leida.success
        ? aplicar(leida.data, userId)
        : { mutation_id: id, resultado: 'rechazada' as const, code: 'VALIDACION' as const };
      mutaciones.set(id, { user_id: userId, resultado });
      resultados.push({ ...resultado, indice });
    }
    return json({ resultados });
  }

  function pull(query: URLSearchParams): Response {
    const cursor = Number(query.get('cursor') ?? '0');
    const ventana = log.filter((r) => r.seq > cursor);
    const pagina = ventana.slice(0, servidor.tamPull);
    const cambios: CambioSync[] = pagina.map((r) => ({
      seq: r.seq,
      tipo: r.tipo,
      entidad: r.entidad,
      id: r.id,
      datos: r.tipo === 'upsert' ? (estado.get(clave(r.entidad, r.id))?.datos ?? null) : null,
    }));
    return json({
      epoca: servidor.epoca,
      cursor: pagina.at(-1)?.seq ?? cursor,
      hay_mas: ventana.length > pagina.length,
      cambios,
    });
  }

  function snapshot(query: URLSearchParams): Response {
    const alcance = query.get('alcance');
    const orderId = query.get('order_id');
    if (alcance === 'orden' && servidor.ordenesNoVisibles.has(orderId ?? '')) {
      // Como el real: la orden ya no es visible para quien pide (desasignada) → 404.
      return error('NO_ENCONTRADO');
    }
    const token = query.get('pagina');
    const [desde, cursor] = token === null ? [0, seq] : token.slice(1).split('_').map(Number);
    const todas = [...estado.values()].filter(
      (e) =>
        alcance === 'inicial' ||
        (e.entidad === 'production_orders' && e.id === orderId) ||
        e.datos.order_id === orderId,
    );
    const pagina = todas.slice(desde, (desde ?? 0) + servidor.tamSnapshot);
    const siguiente = (desde ?? 0) + servidor.tamSnapshot;
    return json({
      epoca: servidor.epoca,
      cursor,
      entidades: pagina,
      siguiente_pagina: siguiente < todas.length ? `p${siguiente}_${cursor}` : null,
    });
  }

  async function subirFoto(id: string, cuerpo: unknown): Promise<Response> {
    const e = estado.get(clave('evidences', id))?.datos as Evidencia | undefined;
    if (e === undefined || servidor.evidenciaDesconocida > 0) {
      servidor.evidenciaDesconocida = Math.max(0, servidor.evidenciaDesconocida - 1);
      return error('EVIDENCIA_DESCONOCIDA');
    }
    if (servidor.errorEvidencia !== null) {
      return error(servidor.errorEvidencia);
    }
    const sha = await sha256(cuerpo as ArrayBuffer);
    const previa = fotos.get(id);
    if (previa !== undefined) {
      return previa === sha ? json({ ...e }) : error('EVIDENCIA_YA_SUBIDA');
    }
    if (sha !== e.sha256) {
      return error('VALIDACION');
    }
    fotos.set(id, sha);
    const subida = { ...e, subido: true, subido_at: ahora() };
    upsert('evidences', id, { ...subida });
    return json(subida);
  }

  const servidor: ServidorSync = {
    peticiones,
    epoca: 'epoca-1',
    tamPull: 200,
    tamSnapshot: 500,
    reglaRechazo: null,
    push503: 0,
    perderRespuestaPush: 0,
    transitorioEnIndice: null,
    evidenciaDesconocida: 0,
    errorEvidencia: null,
    alRecibir: null,
    ordenesNoVisibles: new Set(),
    fallarSnapshotEnPagina: null,
    rechazarPaginaSnapshot: 0,
    epocasRecibidas: [],
    seq: () => seq,
    entidades: (entidad) =>
      [...estado.values()].filter((e) => e.entidad === entidad).map((e) => e.datos),
    pushes: () => peticiones.filter((p) => p.ruta === '/api/v1/sync/push'),
    mutacionesPorPush: () =>
      servidor
        .pushes()
        .map((p) =>
          ((p.cuerpo as { mutaciones?: { mutation_id: string }[] }).mutaciones ?? []).map(
            (m) => m.mutation_id,
          ),
        ),
    upsert,
    agregarCambio(tipo, entidad, id) {
      seq += 1;
      log.push({ seq, tipo, entidad, id, datos: null });
    },
    fotosSubidas: () => [...fotos.keys()],
    restaurar(epocaNueva) {
      servidor.epoca = epocaNueva;
      mutaciones.clear();
      fotos.clear();
      for (const [k, v] of estado) {
        if (['consumptions', 'incidents', 'evidences', 'validations'].includes(v.entidad)) {
          estado.delete(k);
        }
      }
    },
    fetch: async (entrada, init) => {
      const url = new URL(urlDe(entrada), 'http://localhost');
      const bearer = new Headers(init?.headers).get('Authorization');
      const userId = /^Bearer tok-(.+)$/.exec(bearer ?? '')?.[1] ?? null;
      const metodo = init?.method ?? 'GET';
      const peticion: PeticionSync = {
        metodo,
        ruta: url.pathname,
        query: url.searchParams,
        user_id: userId,
        cuerpo: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
      };
      peticiones.push(peticion);
      servidor.alRecibir?.(peticion);
      if (userId === null || userId === 'invalido') {
        return error('NO_AUTENTICADO');
      }
      if (metodo === 'POST' && url.pathname === '/api/v1/sync/push') {
        const respuesta = push(userId, peticion.cuerpo);
        if (servidor.perderRespuestaPush > 0) {
          servidor.perderRespuestaPush -= 1;
          throw new TypeError('Failed to fetch');
        }
        return respuesta;
      }
      if (metodo === 'GET' && url.pathname === '/api/v1/sync/pull') {
        return pull(url.searchParams);
      }
      if (metodo === 'GET' && url.pathname === '/api/v1/sync/snapshot') {
        if (
          url.searchParams.get('alcance') === 'inicial' &&
          servidor.fallarSnapshotEnPagina !== null
        ) {
          servidor.fallarSnapshotEnPagina -= 1;
          if (servidor.fallarSnapshotEnPagina <= 0) {
            servidor.fallarSnapshotEnPagina = null;
            throw new TypeError('Failed to fetch');
          }
        }
        if (url.searchParams.has('pagina') && servidor.rechazarPaginaSnapshot > 0) {
          servidor.rechazarPaginaSnapshot -= 1;
          return error('VALIDACION');
        }
        return snapshot(url.searchParams);
      }
      const foto = /^\/api\/v1\/evidences\/(.+)$/.exec(url.pathname);
      if (metodo === 'PUT' && foto?.[1] !== undefined) {
        return subirFoto(foto[1], init?.body);
      }
      return error('NO_ENCONTRADO');
    },
  };
  return servidor;
}

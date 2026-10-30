// Apoyo de las pruebas de la Fase 5 (jefe y admin): usuarios nuevos por API, llamadas autenticadas
// y lectura de la auditoría.
//
// Cada archivo de prueba crea sus propios usuarios (por API, como admin): así ningún correo del seed
// acumula inicios de sesión y el límite del login (5 por minuto y correo, ADR 0008) no interviene.

import { randomBytes } from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { ConsumoDetallado } from '../../packages/shared/src/tipos';
import type { EventoLineaTiempo, LineaTiempoOrden } from '../../packages/shared/src/reportes';
import {
  ENCABEZADOS_ORIGEN,
  getCrudoComoJefe,
  iniciarSesionApi,
  uuidV7,
  type SesionApi,
} from './api';
import { ADMIN, CONTRASENA, JEFE, type UsuarioSeed } from './usuarios';

/** Materiales del seed (scripts/seed.mjs: `019a3000-0002-7000-8000-<n>`, n = posición en la lista). */
export const MATERIAL = {
  arena: { id: '019a3000-0002-7000-8000-000000000001', nombre: 'Arena sílice' },
  inoculante: { id: '019a3000-0002-7000-8000-000000000008', nombre: 'Inoculante' },
  nodulizante: { id: '019a3000-0002-7000-8000-000000000009', nombre: 'Nodulizante FeSiMg' },
} as const;

export const ORDEN_0588 = { id: '019a3000-0003-7000-8000-000000000002', codigo: 'OP-2026-0588' };

const sesiones = new Map<string, SesionApi>();

/** Sesión de API de un usuario (se reutiliza mientras el token no esté por vencer). */
export async function sesionDe(
  request: APIRequestContext,
  usuario: UsuarioSeed,
): Promise<SesionApi> {
  const previa = sesiones.get(usuario.email);
  if (previa !== undefined && Date.now() < previa.renovarEn) {
    return previa;
  }
  const nueva = await iniciarSesionApi(request, usuario);
  sesiones.set(usuario.email, nueva);
  return nueva;
}

/** Llamada autenticada a la API como `usuario` (con `Origin`, que exigen las mutaciones). */
export async function llamarApi(
  request: APIRequestContext,
  usuario: UsuarioSeed,
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH',
  ruta: string,
  data?: unknown,
): Promise<APIResponse> {
  const sesion = usuario.email === JEFE.email ? null : await sesionDe(request, usuario);
  if (sesion === null) {
    if (metodo !== 'GET') {
      throw new Error(
        'Use llamarApi con un jefe nuevo para las mutaciones: el del seed es solo de lectura.',
      );
    }
    return await getCrudoComoJefe(request, ruta);
  }
  return await request.fetch(`/api/v1${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${sesion.accessToken}`, ...ENCABEZADOS_ORIGEN },
    ...(data === undefined ? {} : { data }),
  });
}

/** Igual que `llamarApi` pero exige un estado 2xx y devuelve el JSON. */
export async function llamarApiOk<T>(
  request: APIRequestContext,
  usuario: UsuarioSeed,
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH',
  ruta: string,
  data?: unknown,
): Promise<T> {
  const respuesta = await llamarApi(request, usuario, metodo, ruta, data);
  if (!respuesta.ok()) {
    throw new Error(
      `${metodo} ${ruta} como ${usuario.email}: HTTP ${respuesta.status()} ${await respuesta.text()}`,
    );
  }
  return (await respuesta.json()) as T;
}

/** Cuerpo de error de la API (`packages/shared/src/errores.ts`). */
export async function codigoDeError(respuesta: APIResponse): Promise<string | undefined> {
  const cuerpo = (await respuesta.json()) as { code?: string };
  return cuerpo.code;
}

export type RolNuevo = 'supervisor' | 'jefe' | 'admin';

const INICIO: Record<RolNuevo, string> = {
  supervisor: '/supervisor',
  jefe: '/jefe',
  admin: '/admin',
};
const NOMBRES: Record<RolNuevo, string> = {
  supervisor: 'Supervisor',
  jefe: 'Jefe',
  admin: 'Admin',
};

/** Crea un usuario activo (como admin, por API) con la contraseña de prueba E2E. */
export async function crearUsuarioPorApi(
  request: APIRequestContext,
  rol: RolNuevo,
  etiqueta: string,
): Promise<UsuarioSeed> {
  const sufijo = randomBytes(3).toString('hex');
  // El nombre incluye una etiqueta sin tildes ni espacios dobles: se busca tal cual en la interfaz.
  const nombre = `${NOMBRES[rol]} ${etiqueta} ${sufijo}`;
  const email = `${rol}.${etiqueta.toLowerCase()}.${sufijo}@catmetal.test`;
  const creado = await llamarApiOk<{ id: string }>(request, ADMIN, 'POST', '/users', {
    nombre,
    email,
    rol,
    password: CONTRASENA,
  });
  return { id: creado.id, email, nombre, rol, inicio: INICIO[rol] };
}

/** Inicia la orden (la deja en proceso) si todavía está planeada. Lo hace un jefe nuevo (no el del seed). */
export async function iniciarOrdenPorApi(
  request: APIRequestContext,
  jefe: UsuarioSeed,
  ordenId: string,
): Promise<void> {
  const orden = await llamarApiOk<{ estado: string }>(request, jefe, 'GET', `/orders/${ordenId}`);
  if (orden.estado === 'planeada') {
    await llamarApiOk(request, jefe, 'POST', `/orders/${ordenId}/start`);
  }
}

/** Agrega supervisores a la lista de una orden (el endpoint reemplaza la lista completa). */
export async function asignarSupervisoresPorApi(
  request: APIRequestContext,
  ordenId: string,
  nuevos: readonly UsuarioSeed[],
): Promise<void> {
  const detalle = await llamarApiOk<{ supervisores: { user_id: string }[] }>(
    request,
    ADMIN,
    'GET',
    `/orders/${ordenId}`,
  );
  const ids = new Set(detalle.supervisores.map((s) => s.user_id));
  for (const usuario of nuevos) {
    ids.add(usuario.id);
  }
  await llamarApiOk(request, ADMIN, 'PUT', `/orders/${ordenId}/supervisors`, {
    supervisores: [...ids],
  });
}

/** Registra un consumo por la API (`POST /consumptions`) como `usuario`. Devuelve el consumo creado. */
export async function registrarConsumoPorApi(
  request: APIRequestContext,
  usuario: UsuarioSeed,
  datos: { ordenId: string; materialId: string; cantidad: number; unidad: string; lote: string },
): Promise<APIResponse> {
  return await llamarApi(request, usuario, 'POST', '/consumptions', {
    id: uuidV7(),
    order_id: datos.ordenId,
    material_id: datos.materialId,
    cantidad: datos.cantidad,
    unidad: datos.unidad,
    lote: datos.lote,
    client_created_at: new Date().toISOString(),
  });
}

/** Cuerpo de `POST /consumptions/:id/approve`. */
export function cuerpoAprobar(version: number): Record<string, unknown> {
  return { id: uuidV7(), version, client_created_at: new Date().toISOString() };
}

/** Todos los eventos de la línea de tiempo de una orden (`GET /orders/:id/audit`), en orden. */
export async function lineaDeTiempo(
  request: APIRequestContext,
  ordenId: string,
): Promise<EventoLineaTiempo[]> {
  const eventos: EventoLineaTiempo[] = [];
  let cursor: number | null = null;
  do {
    const consulta: string = cursor === null ? '' : `?cursor=${cursor}`;
    const pagina: LineaTiempoOrden = await llamarApiOk<LineaTiempoOrden>(
      request,
      JEFE,
      'GET',
      `/orders/${ordenId}/audit${consulta}`,
    );
    eventos.push(...pagina.eventos);
    cursor = pagina.siguiente_cursor;
  } while (cursor !== null);
  return eventos;
}

export type { ConsumoDetallado };

// Utilidades de las pruebas de la Fase 2: sesiones reales por rol, llamadas a la API y fixtures de
// negocio con SQL directo sobre la D1 local real (sin mocks).
import { type Rol, type Unidad, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { Contexto } from '../src/dominio/contexto';
import { peticion } from './auth-helpers';
import { ahora, crearDispositivo, crearUsuario, insertar } from './fixtures-db';
import { sesionReal, type SesionDeRol } from './permisos-helpers';

export type { SesionDeRol };

/** Sesión real (login por la API) de un usuario nuevo del rol. */
export async function sesion(rol: Rol): Promise<SesionDeRol> {
  return sesionReal(rol);
}

export interface Llamada {
  token?: string;
  method?: string;
  body?: unknown;
}

/** Llama a `/api/v1<ruta>` con el Worker real. */
export async function api(ruta: string, opciones: Llamada = {}): Promise<Response> {
  return peticion(`/api/v1${ruta}`, opciones);
}

/** Cuerpo de error con el formato único. */
export interface CuerpoError {
  code: string;
  message: string;
  details?: unknown;
}

export async function esperarError(
  respuesta: Response,
  estado: number,
  code: string,
): Promise<CuerpoError> {
  const cuerpo = await respuesta.json<CuerpoError>();
  expect({ estado: respuesta.status, code: cuerpo.code }).toEqual({ estado, code });
  expect(typeof cuerpo.message).toBe('string');
  return cuerpo;
}

/** Contexto de dominio para llamar a los comandos directamente (pruebas de carreras). */
export async function contextoDe(rol: Rol = 'admin'): Promise<Contexto> {
  const id = await crearUsuario(rol);
  const deviceId = await crearDispositivo(id);
  return { db: env.DB, actor: { id, rol }, deviceId, ahora: ahora(), alertaReloj: false };
}

// ---------------------------------------------------------------------------------------------
// Fixtures de negocio
// ---------------------------------------------------------------------------------------------

export async function nuevoMaterial(
  extra: { unidad?: Unidad; activo?: number; costo?: number; nombre?: string } = {},
): Promise<string> {
  const id = uuidv7();
  const t = ahora();
  await insertar('materials', {
    id,
    codigo: `MAT-${id}`,
    nombre: extra.nombre ?? `Material ${id.slice(-6)}`,
    unidad: extra.unidad ?? 'kg',
    costo_unitario_cop: extra.costo ?? 1500,
    activo: extra.activo ?? 1,
    created_at: t,
    updated_at: t,
  });
  return id;
}

let consecutivoOrden = 0;

/** Código único con el formato `OP-AAAA-NNNN` (la parte aleatoria evita choques entre archivos). */
export function codigoOrden(): string {
  consecutivoOrden += 1;
  const anio = 2000 + Math.floor(Math.random() * 1000);
  return `OP-${String(anio)}-${String(consecutivoOrden % 10_000).padStart(4, '0')}`;
}

export async function nuevaOrden(
  creadaPor: string,
  estado: 'planeada' | 'en_proceso' | 'finalizada' | 'cancelada' = 'en_proceso',
): Promise<string> {
  const id = uuidv7();
  const t = ahora();
  await insertar('production_orders', {
    id,
    codigo: `OP-T-${id}`,
    linea: 'Moldeo',
    estado,
    fecha_inicio: estado === 'planeada' ? null : t,
    creada_por: creadaPor,
    created_at: t,
    updated_at: t,
  });
  return id;
}

export async function planear(
  orderId: string,
  materialId: string,
  cantidad: number,
  unidad: Unidad = 'kg',
): Promise<void> {
  const t = ahora();
  await insertar('order_planned_materials', {
    order_id: orderId,
    material_id: materialId,
    cantidad_planeada: cantidad,
    unidad,
    created_at: t,
    updated_at: t,
  });
}

export async function asignar(
  orderId: string,
  userId: string,
  asignadoPor: string,
  activo = 1,
): Promise<void> {
  const t = ahora();
  await insertar('order_supervisors', {
    order_id: orderId,
    user_id: userId,
    asignado_por: asignadoPor,
    activo,
    created_at: t,
    updated_at: t,
  });
}

export interface ConsumoFixture {
  orderId: string;
  materialId: string;
  registradoPor: string;
  deviceId: string;
  cantidad: number;
  unidad?: Unidad;
  cantidadPlan?: number;
}

export async function nuevoConsumo(datos: ConsumoFixture): Promise<string> {
  const id = uuidv7();
  const t = ahora();
  await insertar('consumptions', {
    id,
    order_id: datos.orderId,
    material_id: datos.materialId,
    cantidad: datos.cantidad,
    unidad: datos.unidad ?? 'kg',
    cantidad_en_unidad_plan: datos.cantidadPlan ?? datos.cantidad,
    lote: 'L-001',
    costo_unitario_cop_snapshot: 1500,
    registrado_por: datos.registradoPor,
    device_id: datos.deviceId,
    client_created_at: t,
    server_received_at: t,
    created_at: t,
    updated_at: t,
  });
  return id;
}

/** Supervisor y dispositivo creados por SQL (sin login) para registrar consumos de prueba. */
export async function supervisorConDispositivo(): Promise<{ id: string; deviceId: string }> {
  const id = await crearUsuario('supervisor');
  return { id, deviceId: await crearDispositivo(id) };
}

// ---------------------------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------------------------

export interface FilaAuditoriaPrueba {
  seq: number;
  entidad: string;
  entidad_id: string;
  accion: string;
  order_id: string | null;
  actor_id: string | null;
  device_id: string | null;
  datos_antes: string | null;
  datos_despues: string | null;
}

export async function ultimoSeq(): Promise<number> {
  const fila = await env.DB.prepare('SELECT COALESCE(max(seq), 0) AS seq FROM audit_log').first<{
    seq: number;
  }>();
  return fila?.seq ?? 0;
}

/** Filas de auditoría escritas después de `seq` (las pruebas de un archivo corren en serie). */
export async function auditoriaDesde(seq: number): Promise<FilaAuditoriaPrueba[]> {
  const { results } = await env.DB.prepare(
    `SELECT seq, entidad, entidad_id, accion, order_id, actor_id, device_id, datos_antes, datos_despues
     FROM audit_log WHERE seq > ? ORDER BY seq`,
  )
    .bind(seq)
    .all<FilaAuditoriaPrueba>();
  return results;
}

export function json(texto: string | null): Record<string, unknown> | null {
  return texto === null ? null : (JSON.parse(texto) as Record<string, unknown>);
}

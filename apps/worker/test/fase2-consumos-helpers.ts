// Utilidades de las pruebas de consumos, novedades y evidencias (tarea 2.2). D1 y R2 locales reales.
import { type Consumo, type NovedadConEvidencias, type Unidad, uuidv7 } from '@catmetal/shared';
import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { sha256Hex } from '../src/dominio/evidencias';
import { BASE, ORIGEN } from './auth-helpers';
import {
  api,
  asignar,
  nuevaOrden,
  nuevoMaterial,
  planear,
  type SesionDeRol,
} from './fase2-helpers';

export function cuerpoConsumo(
  orderId: string,
  materialId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: uuidv7(),
    order_id: orderId,
    material_id: materialId,
    cantidad: 10,
    unidad: 'kg',
    lote: 'L-2026-001',
    client_created_at: new Date().toISOString(),
    ...extra,
  };
}

export function registrar(token: string | undefined, body: unknown): Promise<Response> {
  return api('/consumptions', { token, body });
}

export async function registrarOk(token: string, body: Record<string, unknown>): Promise<Consumo> {
  const respuesta = await registrar(token, body);
  expect(respuesta.status, await respuesta.clone().text()).toBe(201);
  return respuesta.json<Consumo>();
}

export function editar(token: string | undefined, id: string, body: unknown): Promise<Response> {
  return api(`/consumptions/${id}`, { method: 'PATCH', token, body });
}

export function cuerpoNovedad(
  consumoId: string,
  evidencias: { id?: string; mime: string; bytes: Uint8Array; sha256: string }[] = [],
): Record<string, unknown> {
  return {
    id: uuidv7(),
    consumption_id: consumoId,
    tipo: 'merma',
    descripcion: 'Se derramó arena al cargar la mezcladora',
    client_created_at: new Date().toISOString(),
    evidencias: evidencias.map((e) => ({
      id: e.id ?? uuidv7(),
      mime: e.mime,
      tamano_bytes: e.bytes.byteLength,
      sha256: e.sha256,
    })),
  };
}

export function novedad(token: string | undefined, consumoId: string, body: unknown) {
  return api(`/consumptions/${consumoId}/incident`, { token, body });
}

export async function novedadOk(
  token: string,
  consumoId: string,
  body: Record<string, unknown>,
): Promise<NovedadConEvidencias> {
  const respuesta = await novedad(token, consumoId, body);
  expect(respuesta.status, await respuesta.clone().text()).toBe(201);
  return respuesta.json<NovedadConEvidencias>();
}

/** Escenario: orden en proceso con un material planeado y el supervisor asignado. */
export async function escenarioOrden(
  jefe: SesionDeRol,
  supervisor: SesionDeRol,
  plan: { cantidad?: number; unidadPlan?: Unidad; unidadMaterial?: Unidad; costo?: number } = {},
  estado: 'planeada' | 'en_proceso' | 'finalizada' | 'cancelada' = 'en_proceso',
): Promise<{ orden: string; material: string }> {
  const orden = await nuevaOrden(jefe.usuario.id, estado);
  const material = await nuevoMaterial({
    unidad: plan.unidadMaterial ?? 'kg',
    costo: plan.costo ?? 1500,
  });
  await planear(
    orden,
    material,
    plan.cantidad ?? 100,
    plan.unidadPlan ?? plan.unidadMaterial ?? 'kg',
  );
  await asignar(orden, supervisor.usuario.id, jefe.usuario.id);
  return { orden, material };
}

// ---------------------------------------------------------------------------------------------
// Archivos de prueba
// ---------------------------------------------------------------------------------------------

function conRelleno(cabecera: number[], tamano = 256): Uint8Array {
  const bytes = new Uint8Array(tamano);
  // getRandomValues admite como máximo 64 KiB por llamada.
  for (let i = 0; i < tamano; i += 65_536) {
    crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, tamano)));
  }
  bytes.set(cabecera, 0);
  return bytes;
}

export function jpeg(tamano?: number): Uint8Array {
  return conRelleno([0xff, 0xd8, 0xff, 0xe0], tamano);
}

export function png(tamano?: number): Uint8Array {
  return conRelleno([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], tamano);
}

export function webp(tamano?: number): Uint8Array {
  // "RIFF" + 4 bytes de tamaño + "WEBP".
  return conRelleno([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], tamano);
}

export interface Archivo {
  id: string;
  mime: string;
  bytes: Uint8Array;
  sha256: string;
}

export async function archivo(mime: string, bytes: Uint8Array): Promise<Archivo> {
  return { id: uuidv7(), mime, bytes, sha256: await sha256Hex(bytes) };
}

/** `PUT /api/v1/evidences/:id` con el cuerpo binario crudo. */
export async function subir(
  token: string | undefined,
  id: string,
  cuerpo: BodyInit,
  contentType: string | null,
): Promise<Response> {
  const headers = new Headers({ Origin: ORIGEN });
  if (contentType !== null) {
    headers.set('Content-Type', contentType);
  }
  if (token !== undefined) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return exports.default.fetch(
    new Request(`${BASE}/api/v1/evidences/${id}`, { method: 'PUT', headers, body: cuerpo }),
  );
}

export async function descargar(token: string | undefined, id: string): Promise<Response> {
  return api(`/evidences/${id}`, { token });
}

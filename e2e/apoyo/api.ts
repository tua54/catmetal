// Consultas directas a la API (sin pasar por la UI) para verificar datos desde las pruebas.
//
// Límite de login: 5 intentos por minuto y por correo (Rate Limiting, ADR 0008). Por eso el token del
// jefe se reutiliza mientras no esté por vencer, en lugar de iniciar sesión en cada consulta.

import { randomBytes } from 'node:crypto';
// Solo tipos del contrato de la API (raíz no depende de @catmetal/shared; no hay código de ejecución).
import type { ConsumoDetallado, ListaConsumos } from '../../packages/shared/src/tipos';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { ORIGEN_E2E } from '../../scripts/e2e-config.mjs';
import { CONTRASENA, JEFE, type UsuarioSeed } from './usuarios';

/** UUID v7 (RFC 9562) para `device_id`: lo exige el esquema del login. */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SesionApi {
  readonly accessToken: string;
  readonly deviceId: string;
  /** Instante (ms) a partir del cual conviene renovar el token. */
  readonly renovarEn: number;
}

/** Encabezados de una mutación: el Worker exige `Origin` igual al origen de la petición (CSRF). */
export const ENCABEZADOS_ORIGEN = { Origin: ORIGEN_E2E } as const;

/** Login por API. Devuelve el access token (la cookie de refresco queda en el contexto `request`). */
export async function iniciarSesionApi(
  request: APIRequestContext,
  usuario: UsuarioSeed,
  contrasena: string = CONTRASENA,
): Promise<SesionApi> {
  const deviceId = uuidV7();
  const respuesta = await request.post('/api/v1/auth/login', {
    headers: ENCABEZADOS_ORIGEN,
    data: { email: usuario.email, password: contrasena, device_id: deviceId },
  });
  if (!respuesta.ok()) {
    throw new Error(`Login por API de ${usuario.email}: HTTP ${respuesta.status()}`);
  }
  const cuerpo = (await respuesta.json()) as { access_token: string; expira_en: number };
  return {
    accessToken: cuerpo.access_token,
    deviceId,
    renovarEn: Date.now() + Math.max(cuerpo.expira_en - 60, 30) * 1000,
  };
}

let sesionJefe: SesionApi | null = null;

/** Variables que `global-setup.ts` deja en el entorno: el token del jefe se pide una sola vez por ejecución. */
export const ENV_TOKEN_JEFE = 'E2E_TOKEN_JEFE';
export const ENV_TOKEN_JEFE_RENOVAR_EN = 'E2E_TOKEN_JEFE_RENOVAR_EN';

function sesionJefeDelEntorno(): SesionApi | null {
  const accessToken = process.env[ENV_TOKEN_JEFE];
  const renovarEn = Number(process.env[ENV_TOKEN_JEFE_RENOVAR_EN]);
  if (!accessToken || !Number.isFinite(renovarEn)) {
    return null;
  }
  return { accessToken, deviceId: '', renovarEn };
}

/** GET autenticado como jefe (rol con acceso de lectura a órdenes, consumos y evidencias). */
export async function getCrudoComoJefe(
  request: APIRequestContext,
  ruta: string,
): Promise<APIResponse> {
  sesionJefe ??= sesionJefeDelEntorno();
  if (sesionJefe === null || Date.now() >= sesionJefe.renovarEn) {
    sesionJefe = await iniciarSesionApi(request, JEFE);
  }
  return await request.get(`/api/v1${ruta}`, {
    headers: { Authorization: `Bearer ${sesionJefe.accessToken}` },
  });
}

/** GET como jefe que espera 200 y devuelve el JSON. */
export async function getComoJefe<T>(request: APIRequestContext, ruta: string): Promise<T> {
  const respuesta = await getCrudoComoJefe(request, ruta);
  if (!respuesta.ok()) {
    throw new Error(`GET ${ruta} como jefe: HTTP ${respuesta.status()}`);
  }
  return (await respuesta.json()) as T;
}

/** Consumos de una orden vistos por el jefe (todas las páginas). */
export async function consumosDeOrden(
  request: APIRequestContext,
  ordenId: string,
): Promise<ConsumoDetallado[]> {
  const todos: ConsumoDetallado[] = [];
  let cursor: string | null = null;
  do {
    const consulta: string = cursor === null ? '' : `?cursor=${cursor}`;
    const pagina: ListaConsumos = await getComoJefe<ListaConsumos>(
      request,
      `/orders/${ordenId}/consumptions${consulta}`,
    );
    todos.push(...pagina.consumos);
    cursor = pagina.siguiente_cursor;
  } while (cursor !== null);
  return todos;
}

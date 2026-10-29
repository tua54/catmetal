// Utilidades para las pruebas de autenticación contra el Worker real (exports.default.fetch) y la
// D1 local real. Los usuarios se crean con el `hashearContrasena` del Worker.
import { type Perfil, type RespuestaSesion, type Rol, uuidv7 } from '@catmetal/shared';
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { hashearContrasena } from '../src/auth/contrasenas';

export const BASE = 'https://catmetal.test';
export const ORIGEN = BASE;

export interface UsuarioPrueba {
  id: string;
  email: string;
  password: string;
  rol: Rol;
}

export async function crearUsuarioConClave(
  rol: Rol = 'supervisor',
  extra: { activo?: number } = {},
): Promise<UsuarioPrueba> {
  const id = uuidv7();
  const email = `u-${id}@catmetal.test`;
  const password = `Clave-${crypto.randomUUID()}`;
  const ahora = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, nombre, email, password_hash, rol, activo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      `Persona ${rol}`,
      email,
      await hashearContrasena(password),
      rol,
      extra.activo ?? 1,
      ahora,
      ahora,
    )
    .run();
  return { id, email, password, rol };
}

export interface OpcionesPeticion {
  method?: string;
  body?: unknown;
  token?: string;
  cookie?: string;
  /** `null` = sin cabecera Origin. Por defecto, el propio origen. */
  origen?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

export async function peticion(ruta: string, opciones: OpcionesPeticion = {}): Promise<Response> {
  const headers = new Headers(opciones.headers);
  const origen = opciones.origen === undefined ? ORIGEN : opciones.origen;
  if (origen !== null) {
    headers.set('Origin', origen);
  }
  if (opciones.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (opciones.token !== undefined) {
    headers.set('Authorization', `Bearer ${opciones.token}`);
  }
  if (opciones.cookie !== undefined) {
    headers.set('Cookie', `mp_refresh=${opciones.cookie}`);
  }
  if (opciones.ip !== undefined) {
    headers.set('cf-connecting-ip', opciones.ip);
  }
  return exports.default.fetch(
    new Request(`${BASE}${ruta}`, {
      method: opciones.method ?? (opciones.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
    }),
  );
}

export interface CookieLeida {
  valor: string;
  atributos: string[];
}

/** Lee la cookie `mp_refresh` de la respuesta (valor y atributos). */
export function cookieRefresh(respuesta: Response): CookieLeida | null {
  const cabecera = respuesta.headers.get('Set-Cookie');
  if (cabecera === null || !cabecera.startsWith('mp_refresh=')) {
    return null;
  }
  const [par = '', ...atributos] = cabecera.split(';').map((parte) => parte.trim());
  return { valor: par.slice('mp_refresh='.length), atributos };
}

export interface SesionPrueba {
  respuesta: Response;
  cuerpo: RespuestaSesion;
  refresh: string;
  deviceId: string;
}

export async function iniciarSesion(
  usuario: Pick<UsuarioPrueba, 'email' | 'password'>,
  opciones: { deviceId?: string; ip?: string; instalacionId?: string } = {},
): Promise<SesionPrueba> {
  const deviceId = opciones.deviceId ?? uuidv7();
  const respuesta = await peticion('/api/v1/auth/login', {
    body: {
      email: usuario.email,
      password: usuario.password,
      device_id: deviceId,
      device_nombre: 'Tablet de planta',
      ...(opciones.instalacionId === undefined ? {} : { instalacion_id: opciones.instalacionId }),
    },
    ip: opciones.ip,
    headers: { 'User-Agent': 'Prueba/1.0' },
  });
  expect(respuesta.status, 'login').toBe(200);
  const cuerpo = await respuesta.json<RespuestaSesion>();
  const cookie = cookieRefresh(respuesta);
  expect(cookie).not.toBeNull();
  return { respuesta, cuerpo, refresh: cookie?.valor ?? '', deviceId: cuerpo.device_id };
}

export async function refrescar(refresh: string): Promise<Response> {
  return peticion('/api/v1/auth/refresh', { method: 'POST', cookie: refresh });
}

export async function perfil(token: string): Promise<Response> {
  return peticion('/api/v1/auth/me', { token });
}

export type { Perfil };

/**
 * Ningún `datos_antes`/`datos_despues` de la auditoría contiene secretos: hashes, tokens,
 * contraseñas ni los secretos del Worker. Se buscan los valores literales.
 */
export async function esperarAuditoriaSinSecretos(valores: readonly string[]): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(datos_antes, '') || ' ' || COALESCE(datos_despues, '') AS texto FROM audit_log`,
  ).all<{ texto: string }>();
  expect(results.length).toBeGreaterThan(0);
  const { results: hashes } = await env.DB.prepare(
    `SELECT password_hash AS valor FROM users UNION ALL SELECT token_hash FROM refresh_tokens`,
  ).all<{ valor: string }>();
  const prohibidos = [
    ...valores,
    ...hashes.map((h) => h.valor),
    env.JWT_SECRET,
    env.REFRESH_SECRET,
    'password_hash',
    'token_hash',
  ].filter((v) => v.length > 0);
  for (const { texto } of results) {
    for (const prohibido of prohibidos) {
      expect(
        texto.includes(prohibido),
        `la auditoría contiene un secreto: ${prohibido.slice(0, 8)}…`,
      ).toBe(false);
    }
  }
}

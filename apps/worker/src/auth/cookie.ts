// Cookie del refresh token (ADR 0008 punto 4):
// `mp_refresh`, HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000.

import { REFRESH_TOKEN_TTL_S } from '@catmetal/shared';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const NOMBRE_COOKIE_REFRESH = 'mp_refresh';
export const RUTA_COOKIE_REFRESH = '/api/v1/auth';

const OPCIONES = {
  path: RUTA_COOKIE_REFRESH,
  secure: true,
  httpOnly: true,
  sameSite: 'Strict',
} as const;

export function leerCookieRefresh(c: Context): string | undefined {
  const valor = getCookie(c, NOMBRE_COOKIE_REFRESH);
  return valor === undefined || valor === '' ? undefined : valor;
}

export function ponerCookieRefresh(c: Context, token: string): void {
  setCookie(c, NOMBRE_COOKIE_REFRESH, token, { ...OPCIONES, maxAge: REFRESH_TOKEN_TTL_S });
}

/** Borra la cookie con el mismo Path (Max-Age=0). */
export function borrarCookieRefresh(c: Context): void {
  deleteCookie(c, NOMBRE_COOKIE_REFRESH, OPCIONES);
}

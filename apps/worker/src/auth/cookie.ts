// Cookie del refresh token (ADR 0008 punto 4):
// `mp_refresh`, HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=<vida restante>.
// En el login la vida restante es de 30 días (2592000 s); en una rotación, lo que le quede a la
// familia (B1, docs/spec.md §5 v2.1): la cookie nunca dura más que el token que lleva.

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

/** `vidaRestanteS`: segundos que le quedan al token (`expira_at` − hora de emisión). */
export function ponerCookieRefresh(c: Context, token: string, vidaRestanteS: number): void {
  setCookie(c, NOMBRE_COOKIE_REFRESH, token, {
    ...OPCIONES,
    maxAge: Math.max(0, Math.floor(vidaRestanteS)),
  });
}

/** Borra la cookie con el mismo Path (Max-Age=0). */
export function borrarCookieRefresh(c: Context): void {
  deleteCookie(c, NOMBRE_COOKIE_REFRESH, OPCIONES);
}

// Access tokens (JWT HS256) y refresh tokens (ADR 0007 y 0008).
//
// - Access token: 15 min, claims `sub` (usuario), `did` (dispositivo) y `fam` (familia de refresh).
//   No lleva rol: el rol se lee de D1 en cada petición (ADR 0008 punto 1).
// - Refresh token: 32 bytes aleatorios en base64url. En D1 solo se guarda
//   HMAC-SHA256(REFRESH_SECRET, token) en hex minúsculas.

import { ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S } from '@catmetal/shared';
import { jwtVerify, SignJWT } from 'jose';
import { aBase64Url, aHex, bytesAleatorios } from './codificacion';

export const EMISOR_JWT = 'catmetal-mp';
export const AUDIENCIA_JWT = 'catmetal-mp-api';
const ALGORITMO = 'HS256';
const codificador = new TextEncoder();

export interface ClaimsAcceso {
  sub: string;
  did: string;
  fam: string;
}

export async function emitirAccessToken(secreto: string, claims: ClaimsAcceso): Promise<string> {
  return new SignJWT({ did: claims.did, fam: claims.fam })
    .setProtectedHeader({ alg: ALGORITMO, typ: 'JWT' })
    .setIssuer(EMISOR_JWT)
    .setAudience(AUDIENCIA_JWT)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${String(ACCESS_TOKEN_TTL_S)}s`)
    .sign(codificador.encode(secreto));
}

/** Verifica firma, algoritmo, emisor, audiencia y vencimiento. Devuelve `null` si no es válido. */
export async function verificarAccessToken(
  secreto: string,
  token: string,
): Promise<ClaimsAcceso | null> {
  try {
    const { payload } = await jwtVerify(token, codificador.encode(secreto), {
      algorithms: [ALGORITMO],
      issuer: EMISOR_JWT,
      audience: AUDIENCIA_JWT,
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    const { sub, did, fam } = payload;
    if (typeof sub !== 'string' || typeof did !== 'string' || typeof fam !== 'string') {
      return null;
    }
    return { sub, did, fam };
  } catch {
    return null;
  }
}

/** Token opaco nuevo (32 bytes aleatorios, base64url). */
export function generarRefreshToken(): string {
  return aBase64Url(bytesAleatorios(32));
}

/** `token_hash` = HMAC-SHA256(REFRESH_SECRET, token) en hex minúsculas. */
export async function hashRefreshToken(secreto: string, token: string): Promise<string> {
  const clave = await crypto.subtle.importKey(
    'raw',
    codificador.encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const firma = await crypto.subtle.sign('HMAC', clave, codificador.encode(token));
  return aHex(new Uint8Array(firma));
}

/** Vencimiento de un refresh token emitido ahora. */
export function vencimientoRefresh(ahoraMs: number): string {
  return new Date(ahoraMs + REFRESH_TOKEN_TTL_S * 1000).toISOString();
}

/**
 * Vencimiento ABSOLUTO de una familia de refresh (docs/spec.md §5 v2.1, B1): 30 días desde el login
 * con contraseña (`created_at` del primer token de la familia). Las rotaciones no lo extienden.
 */
export function vencimientoFamilia(familiaInicio: string): string {
  return vencimientoRefresh(Date.parse(familiaInicio));
}

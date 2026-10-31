// Cookie de dispositivo conocido `mp_dispositivo` (ADR 0018, M1; OWASP "device cookies").
//
// - Atributos: HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=34560000 (400 días).
// - Valor: hasta 16 entradas separadas por `~`, una por usuario de la tablet, la más reciente primero.
//   Cada entrada es `v1.<user_id>.<emitida_dia>.<nonce>.<firma>`: `emitida_dia` en días desde
//   1970-01-01 (UTC), `nonce` de 16 bytes en base64url y `firma` = HMAC-SHA-256 del resto de la
//   entrada, truncado a 128 bits y en base64url, con una clave derivada de REFRESH_SECRET.
// - La cookie NO da acceso: solo elige el cupo de login (el del dispositivo conocido). Una entrada
//   inválida, vencida o de otro usuario se ignora y el intento cuenta como de un origen desconocido.
// - Se emite tras un login con la contraseña correcta y tras un refresh exitoso (A8, ADR 0018
//   enmienda 2: ver `valorTrasRefresh`). El logout, los refresh fallidos y la detección de
//   reutilización nunca la tocan.

import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { aBase64Url, bytesAleatorios } from './codificacion';
import { RUTA_COOKIE_REFRESH } from './cookie';

export const NOMBRE_COOKIE_DISPOSITIVO = 'mp_dispositivo';
/** 400 días: el máximo que admiten los navegadores (RFC 6265bis) y Hono. */
export const MAX_EDAD_COOKIE_DISPOSITIVO_S = 34_560_000;
export const MAX_DIAS_ENTRADA_DISPOSITIVO = 400;
export const MAX_ENTRADAS_DISPOSITIVO = 16;
/** Tope por valor de `mp_dispositivo` (lo que pase de aquí se ignora entero). */
export const MAX_BYTES_VALOR_DISPOSITIVO = 4096;
/**
 * Tope de apariciones de `mp_dispositivo` que se revisan en la cabecera Cookie. Se leen todas (no
 * solo la primera) porque un subdominio hermano podría plantar otra con `Domain=` y un Path más
 * largo, que el navegador envía antes que la legítima.
 */
export const MAX_APARICIONES_DISPOSITIVO = 8;

const VERSION = 'v1';
const SEPARADOR_ENTRADAS = '~';
const ETIQUETA_FIRMA = 'mp-dispositivo-v1';
/** Etiqueta (info de HKDF) de la clave del nonce determinista por familia (S-v12-01). */
const ETIQUETA_NONCE_FAMILIA = 'mp-dispositivo-familia-v1';
const DIA_MS = 86_400_000;
const PATRON_ENTRADA =
  /^v1\.([A-Za-z0-9-]{1,64})\.(\d{1,7})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;

const codificador = new TextEncoder();

/** Entrada ya verificada (firma correcta y no vencida). */
export interface EntradaDispositivo {
  texto: string;
  userId: string;
  emitidaDia: number;
  nonce: string;
}

// ---------------------------------------------------------------------------------------------
// HMAC con claves derivadas de REFRESH_SECRET (una por etiqueta: firma de la cookie, IP)
// ---------------------------------------------------------------------------------------------
//
// S-05 (docs/auditoria/seguridad-correcciones.md): las claves se derivan con HKDF-SHA-256 (RFC 5869)
// y la etiqueta como `info`, no con HMAC(REFRESH_SECRET, etiqueta): así no comparten primitivo ni
// clave con `hashRefreshToken` (HMAC-SHA-256 directo con REFRESH_SECRET). Sal vacía (RFC 5869
// §3.1: el secreto ya es aleatorio y de alta entropía).

const clavesDerivadas = new Map<string, Promise<CryptoKey>>();
const SAL_VACIA = new Uint8Array(0);

async function derivarClave(secreto: string, etiqueta: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', codificador.encode(secreto), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SAL_VACIA, info: codificador.encode(etiqueta) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

function claveDerivada(secreto: string, etiqueta: string): Promise<CryptoKey> {
  const clave = `${etiqueta}\u0000${secreto}`;
  let promesa = clavesDerivadas.get(clave);
  if (promesa === undefined) {
    promesa = derivarClave(secreto, etiqueta);
    // Un isolate solo ve uno o dos secretos (rotación): el mapa no crece sin límite en la práctica.
    clavesDerivadas.set(clave, promesa);
  }
  return promesa;
}

/** HMAC-SHA-256 con la clave derivada de `secreto` y `etiqueta`, truncado a 128 bits. */
export async function hmacTruncado(
  secreto: string,
  etiqueta: string,
  mensaje: string,
): Promise<Uint8Array> {
  const clave = await claveDerivada(secreto, etiqueta);
  const firma = await crypto.subtle.sign('HMAC', clave, codificador.encode(mensaje));
  return new Uint8Array(firma).slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------------------------

export function diaUtc(ahoraMs: number): number {
  return Math.floor(ahoraMs / DIA_MS);
}

/** Entrada firmada para `userId` con el día y el nonce dados (las pruebas la usan para falsificar). */
export async function firmarEntrada(
  secreto: string,
  userId: string,
  emitidaDia: number,
  nonce: string,
): Promise<string> {
  const cuerpo = `${VERSION}.${userId}.${String(emitidaDia)}.${nonce}`;
  const firma = await hmacTruncado(secreto, ETIQUETA_FIRMA, cuerpo);
  return `${cuerpo}.${aBase64Url(firma)}`;
}

/** Entrada nueva para `userId`, emitida hoy, con un nonce aleatorio. */
export async function nuevaEntrada(
  secreto: string,
  userId: string,
  ahoraMs: number,
): Promise<EntradaDispositivo> {
  const emitidaDia = diaUtc(ahoraMs);
  const nonce = aBase64Url(bytesAleatorios(16));
  const texto = await firmarEntrada(secreto, userId, emitidaDia, nonce);
  return { texto, userId, emitidaDia, nonce };
}

/**
 * Nonce DETERMINISTA de una familia de refresh (S-v12-01): HMAC-SHA-256 con la clave derivada de
 * REFRESH_SECRET y la etiqueta propia `mp-dispositivo-familia-v1` (HKDF, S-05) sobre `familia_id`,
 * truncado a 128 bits y en base64url (22 caracteres: el mismo formato que el nonce aleatorio).
 */
export async function nonceDeFamilia(secreto: string, familiaId: string): Promise<string> {
  return aBase64Url(await hmacTruncado(secreto, ETIQUETA_NONCE_FAMILIA, familiaId));
}

/**
 * Entrada para `userId` emitida hoy por un refresh de la familia `familiaId`, con el nonce
 * determinista de esa familia (S-v12-01). Todas las rotaciones de la familia dan el mismo nonce y,
 * por tanto, el mismo cupo `d:<nonce>`: un refresh token robado no fabrica cupos de dispositivo.
 */
export async function entradaDeFamilia(
  secreto: string,
  userId: string,
  familiaId: string,
  ahoraMs: number,
): Promise<EntradaDispositivo> {
  const emitidaDia = diaUtc(ahoraMs);
  const nonce = await nonceDeFamilia(secreto, familiaId);
  const texto = await firmarEntrada(secreto, userId, emitidaDia, nonce);
  return { texto, userId, emitidaDia, nonce };
}

interface EntradaSinVerificar {
  texto: string;
  userId: string;
  emitidaDia: number;
  nonce: string;
  firma: string;
}

function analizar(texto: string): EntradaSinVerificar | null {
  const partes = PATRON_ENTRADA.exec(texto);
  if (partes === null) {
    return null;
  }
  const [, userId = '', dia = '', nonce = '', firma = ''] = partes;
  return { texto, userId, emitidaDia: Number(dia), nonce, firma };
}

/** Firma correcta (comparación en tiempo constante) y edad entre 0 y 400 días. */
async function verificar(
  secreto: string,
  entrada: EntradaSinVerificar,
  ahoraMs: number,
): Promise<EntradaDispositivo | null> {
  const edadDias = diaUtc(ahoraMs) - entrada.emitidaDia;
  if (edadDias < 0 || edadDias > MAX_DIAS_ENTRADA_DISPOSITIVO) {
    return null;
  }
  const esperada = await firmarEntrada(secreto, entrada.userId, entrada.emitidaDia, entrada.nonce);
  const a = codificador.encode(esperada);
  const b = codificador.encode(entrada.texto);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    return null;
  }
  return {
    texto: entrada.texto,
    userId: entrada.userId,
    emitidaDia: entrada.emitidaDia,
    nonce: entrada.nonce,
  };
}

// ---------------------------------------------------------------------------------------------
// Lectura robusta de la cabecera Cookie
// ---------------------------------------------------------------------------------------------

/**
 * Todos los valores de `mp_dispositivo` de la cabecera Cookie, en orden (hasta
 * MAX_APARICIONES_DISPOSITIVO). Un valor de más de 4 KiB se ignora entero.
 */
export function valoresCookieDispositivo(cabecera: string | undefined): string[] {
  if (cabecera === undefined) {
    return [];
  }
  const valores: string[] = [];
  for (const par of cabecera.split(';')) {
    const igual = par.indexOf('=');
    if (igual < 0 || par.slice(0, igual).trim() !== NOMBRE_COOKIE_DISPOSITIVO) {
      continue;
    }
    let valor = par.slice(igual + 1).trim();
    if (valor.startsWith('"') && valor.endsWith('"') && valor.length >= 2) {
      valor = valor.slice(1, -1);
    }
    if (valor.length > 0 && valor.length <= MAX_BYTES_VALOR_DISPOSITIVO) {
      valores.push(valor);
    }
    if (valores.length >= MAX_APARICIONES_DISPOSITIVO) {
      break;
    }
  }
  return valores;
}

/** Entradas sin verificar de todos los valores (hasta 16 por valor), sin repetidas. */
function entradasPresentadas(valores: readonly string[]): EntradaSinVerificar[] {
  const vistas = new Set<string>();
  const salida: EntradaSinVerificar[] = [];
  for (const valor of valores) {
    for (const texto of valor.split(SEPARADOR_ENTRADAS).slice(0, MAX_ENTRADAS_DISPOSITIVO)) {
      const entrada = analizar(texto);
      if (entrada !== null && !vistas.has(texto)) {
        vistas.add(texto);
        salida.push(entrada);
      }
    }
  }
  return salida;
}

/**
 * Primera entrada VÁLIDA cuyo `user_id` es `userId`, o null (origen desconocido). Solo se verifican
 * las entradas de ese usuario.
 */
export async function entradaDelUsuario(
  secreto: string,
  valores: readonly string[],
  userId: string,
  ahoraMs: number,
): Promise<EntradaDispositivo | null> {
  for (const entrada of entradasPresentadas(valores)) {
    if (entrada.userId !== userId) {
      continue;
    }
    const valida = await verificar(secreto, entrada, ahoraMs);
    if (valida !== null) {
      return valida;
    }
  }
  return null;
}

/**
 * Valor renovado tras un login correcto de `userId`: su entrada nueva primero y después las
 * entradas VÁLIDAS de otros usuarios (una por usuario, en el orden presentado). Las inválidas se
 * descartan para no reemitir nada plantado. Máximo 16 entradas: el usuario más antiguo sale.
 */
export async function valorRenovado(
  secreto: string,
  valores: readonly string[],
  nueva: EntradaDispositivo,
  ahoraMs: number,
): Promise<string> {
  const textos = [nueva.texto];
  const usuarios = new Set([nueva.userId]);
  for (const entrada of entradasPresentadas(valores)) {
    if (textos.length >= MAX_ENTRADAS_DISPOSITIVO) {
      break;
    }
    if (usuarios.has(entrada.userId)) {
      continue;
    }
    const valida = await verificar(secreto, entrada, ahoraMs);
    if (valida !== null) {
      usuarios.add(valida.userId);
      textos.push(valida.texto);
    }
  }
  return textos.join(SEPARADOR_ENTRADAS);
}

/**
 * Valor de `mp_dispositivo` tras un refresh EXITOSO de `userId` (A8, ADR 0018 enmienda 2). El
 * refresh demuestra lo mismo que un login correcto previo en este navegador (un refresh token
 * vigente de esa familia) y no da acceso adicional: la cookie solo elige el cupo de login.
 * - Si la cookie presentada ya tiene una entrada válida de ese usuario, se conserva TAL CUAL (mismo
 *   nonce: su cupo `d:` no se reinicia); al reemitir la cookie solo se renueva su Max-Age.
 * - Si no, se agrega una entrada nueva. A diferencia del login correcto (nonce aleatorio), su nonce
 *   es el DETERMINISTA de la familia de refresh (S-v12-01, `entradaDeFamilia`): el refresh no exige
 *   contraseña, así que rotar una y otra vez un refresh token (robado, o el anterior dentro de la
 *   gracia) con cookies vacías siempre da el mismo cupo `d:`, no uno nuevo por rotación.
 * En los dos casos se arma como en el login (`valorRenovado`): la del usuario primero, después las
 * válidas de otros usuarios, máximo 16, y las inválidas se descartan.
 */
export async function valorTrasRefresh(
  secreto: string,
  valores: readonly string[],
  sesion: { userId: string; familiaId: string },
  ahoraMs: number,
): Promise<string> {
  const conocida = await entradaDelUsuario(secreto, valores, sesion.userId, ahoraMs);
  const propia =
    conocida ?? (await entradaDeFamilia(secreto, sesion.userId, sesion.familiaId, ahoraMs));
  return valorRenovado(secreto, valores, propia, ahoraMs);
}

export function ponerCookieDispositivo(c: Context, valor: string): void {
  setCookie(c, NOMBRE_COOKIE_DISPOSITIVO, valor, {
    path: RUTA_COOKIE_REFRESH,
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: MAX_EDAD_COOKIE_DISPOSITIVO_S,
  });
}

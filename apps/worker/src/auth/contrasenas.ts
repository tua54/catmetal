// Hash de contraseñas con PBKDF2-SHA256 (ADR 0007).
//
// Formato autodescriptivo: `pbkdf2-sha256$<iteraciones>$<sal_b64>$<hash_b64>`
//   - sal de 16 bytes y hash de 32 bytes, ambos en base64 estándar CON relleno (`btoa`);
//   - `scripts/seed.mjs` genera el mismo formato con `node:crypto` (pbkdf2Sync sha256, 32 bytes).
// workerd rechaza más de 100.000 iteraciones: un hash con más se trata como inválido (false).

import { PBKDF2_ITERACIONES_SERVIDOR } from '@catmetal/shared';
import { aBase64, bytesAleatorios, deBase64 } from './codificacion';

const PREFIJO = 'pbkdf2-sha256';
const BYTES_SAL = 16;
const BYTES_HASH = 32;
const codificador = new TextEncoder();

async function derivar(
  contrasena: string,
  sal: Uint8Array,
  iteraciones: number,
  bytes: number,
): Promise<Uint8Array> {
  const clave = await crypto.subtle.importKey(
    'raw',
    codificador.encode(contrasena),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteraciones },
    clave,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** Genera el hash autodescriptivo de una contraseña con una sal aleatoria nueva. */
export async function hashearContrasena(contrasena: string): Promise<string> {
  const sal = bytesAleatorios(BYTES_SAL);
  const hash = await derivar(contrasena, sal, PBKDF2_ITERACIONES_SERVIDOR, BYTES_HASH);
  return `${PREFIJO}$${String(PBKDF2_ITERACIONES_SERVIDOR)}$${aBase64(sal)}$${aBase64(hash)}`;
}

interface HashDescompuesto {
  iteraciones: number;
  sal: Uint8Array;
  hash: Uint8Array;
}

function descomponer(guardado: string): HashDescompuesto | null {
  const partes = guardado.split('$');
  if (partes.length !== 4 || partes[0] !== PREFIJO) {
    return null;
  }
  const [, textoIteraciones = '', textoSal = '', textoHash = ''] = partes;
  if (!/^[1-9]\d{0,6}$/.test(textoIteraciones)) {
    return null;
  }
  const iteraciones = Number(textoIteraciones);
  if (iteraciones > PBKDF2_ITERACIONES_SERVIDOR) {
    return null;
  }
  const sal = deBase64(textoSal);
  const hash = deBase64(textoHash);
  if (sal === null || hash === null || sal.length < BYTES_SAL || hash.length !== BYTES_HASH) {
    return null;
  }
  return { iteraciones, sal, hash };
}

/**
 * Verifica una contraseña contra su hash guardado, con comparación de tiempo constante.
 * Un formato desconocido o corrupto devuelve `false` (nunca lanza).
 */
export async function verificarContrasena(contrasena: string, guardado: string): Promise<boolean> {
  const partes = descomponer(guardado);
  if (partes === null) {
    // Se deriva igual para no revelar por tiempo que el hash guardado es inválido.
    await derivacionFicticia();
    return false;
  }
  const calculado = await derivar(contrasena, partes.sal, partes.iteraciones, BYTES_HASH);
  return crypto.subtle.timingSafeEqual(calculado, partes.hash);
}

const SAL_FICTICIA = new Uint8Array(BYTES_SAL).fill(0x5a);

/**
 * Derivación con el mismo costo que una verificación real. Se usa cuando el usuario no existe,
 * está inactivo o bloqueado, para que el tiempo de respuesta no revele nada (ADR 0007 y 0008).
 */
export async function derivacionFicticia(): Promise<void> {
  await derivar('contrasena-ficticia', SAL_FICTICIA, PBKDF2_ITERACIONES_SERVIDOR, BYTES_HASH);
}

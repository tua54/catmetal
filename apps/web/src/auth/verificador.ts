// Verificador del login offline (docs/spec.md §5, ADR 0012 punto 4).
//
// PBKDF2-SHA256 con WebCrypto, 600.000 iteraciones, sal aleatoria de 16 bytes PROPIA DEL DISPOSITIVO
// (distinta de la del servidor) y 32 bytes de salida, comparados en tiempo constante. El verificador
// solo abre los datos locales: nunca se envía al servidor ni reemplaza su autenticación.

import type { VerificadorLocal } from '../datos/tipos';

/** OWASP 2023 para PBKDF2-SHA256 (ADR 0012). Si cambia, los verificadores guardados conservan las suyas. */
export const ITERACIONES_VERIFICADOR = 600_000;
export const BYTES_SAL = 16;
export const BYTES_VERIFICADOR = 32;
/** Cota de las iteraciones leídas de IndexedDB (un dato corrupto no debe colgar la tablet). */
const MAX_ITERACIONES = 10_000_000;

export interface MedicionDerivacion {
  iteraciones: number;
  ms: number;
}

let ultimaMedicion: MedicionDerivacion | null = null;

/**
 * Última medición del tiempo de derivación en este navegador (para fijar las iteraciones según la
 * tablet real, ADR 0012). Nunca incluye la contraseña ni el resultado.
 */
export function ultimaMedicionDerivacion(): MedicionDerivacion | null {
  return ultimaMedicion;
}

function aBase64(bytes: Uint8Array): string {
  let binario = '';
  for (const byte of bytes) {
    binario += String.fromCharCode(byte);
  }
  return btoa(binario);
}

function deBase64(texto: string): Uint8Array | null {
  try {
    const binario = atob(texto);
    return Uint8Array.from(binario, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Deriva `BYTES_VERIFICADOR` bytes con PBKDF2-SHA256. Mide el tiempo de la derivación. */
export async function derivarVerificador(
  password: string,
  sal: Uint8Array,
  iteraciones: number,
): Promise<Uint8Array> {
  const inicio = performance.now();
  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(sal), iterations: iteraciones },
    clave,
    BYTES_VERIFICADOR * 8,
  );
  ultimaMedicion = { iteraciones, ms: Math.round(performance.now() - inicio) };
  return new Uint8Array(bits);
}

/** Crea un verificador nuevo con sal aleatoria. `iteraciones` solo se cambia en pruebas. */
export async function crearVerificador(
  password: string,
  iteraciones: number = ITERACIONES_VERIFICADOR,
): Promise<VerificadorLocal> {
  const sal = crypto.getRandomValues(new Uint8Array(BYTES_SAL));
  const hash = await derivarVerificador(password, sal, iteraciones);
  return {
    algoritmo: 'pbkdf2-sha256',
    iteraciones,
    sal: aBase64(sal),
    hash: aBase64(hash),
    ms_derivacion: ultimaMedicion?.ms ?? null,
    creado_at: new Date().toISOString(),
  };
}

/** Compara dos arreglos en tiempo constante respecto de su contenido (XOR acumulado). */
export function igualesEnTiempoConstante(a: Uint8Array, b: Uint8Array): boolean {
  let diferencia = a.length ^ b.length;
  const largo = Math.max(a.length, b.length);
  for (let i = 0; i < largo; i += 1) {
    diferencia |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diferencia === 0;
}

function esVerificadorValido(v: VerificadorLocal): boolean {
  return (
    v.algoritmo === 'pbkdf2-sha256' &&
    Number.isInteger(v.iteraciones) &&
    v.iteraciones >= 1 &&
    v.iteraciones <= MAX_ITERACIONES
  );
}

/**
 * Comprueba la contraseña contra un verificador guardado, con sus propias iteraciones. Un
 * verificador malformado nunca valida.
 */
export async function comprobarVerificador(
  password: string,
  guardado: VerificadorLocal,
): Promise<boolean> {
  if (!esVerificadorValido(guardado)) {
    return false;
  }
  const sal = deBase64(guardado.sal);
  const esperado = deBase64(guardado.hash);
  if (sal?.length !== BYTES_SAL || esperado?.length !== BYTES_VERIFICADOR) {
    return false;
  }
  const calculado = await derivarVerificador(password, sal, guardado.iteraciones);
  return igualesEnTiempoConstante(calculado, esperado);
}

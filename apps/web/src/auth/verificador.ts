// Verificador del login offline (docs/spec.md §5, ADR 0012 punto 4).
//
// PBKDF2-SHA256 con WebCrypto, 600.000 iteraciones, sal aleatoria de 16 bytes PROPIA DEL DISPOSITIVO
// (distinta de la del servidor) y 32 bytes de salida, comparados en tiempo constante. Nunca se envía
// al servidor ni reemplaza su autenticación, pero SÍ es un oráculo de la contraseña del servidor si
// alguien extrae IndexedDB (enmienda de la ADR 0012, ADR 0017): por eso hay un mínimo de iteraciones
// aceptadas, límite de intentos (sesion.ts) y ningún verificador para el admin.

import type { VerificadorLocal } from '../datos/tipos';

/** OWASP 2023 para PBKDF2-SHA256 (ADR 0012). Si cambia, los verificadores guardados conservan las suyas. */
export const ITERACIONES_VERIFICADOR = 600_000;
export const BYTES_SAL = 16;
export const BYTES_VERIFICADOR = 32;
/**
 * Mínimo de iteraciones de un verificador aceptado (ADR 0017 §6, F4-07): quien manipule IndexedDB no
 * puede rebajar el costo de la fuerza bruta guardando un verificador barato.
 */
export const MIN_ITERACIONES_VERIFICADOR = 100_000;
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

function esVerificadorValido(v: VerificadorLocal, minimo: number): boolean {
  return (
    v.algoritmo === 'pbkdf2-sha256' &&
    Number.isInteger(v.iteraciones) &&
    v.iteraciones >= Math.max(1, minimo) &&
    v.iteraciones <= MAX_ITERACIONES
  );
}

export interface OpcionesComprobacion {
  /** Solo pruebas unitarias: por defecto, `MIN_ITERACIONES_VERIFICADOR`. */
  minimoIteraciones?: number;
}

/**
 * Comprueba la contraseña contra un verificador guardado, con sus propias iteraciones. Un
 * verificador malformado o con menos de `MIN_ITERACIONES_VERIFICADOR` iteraciones nunca valida.
 */
export async function comprobarVerificador(
  password: string,
  guardado: VerificadorLocal,
  opciones: OpcionesComprobacion = {},
): Promise<boolean> {
  if (!esVerificadorValido(guardado, opciones.minimoIteraciones ?? MIN_ITERACIONES_VERIFICADOR)) {
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

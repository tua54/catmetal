// UUID versión 7 (RFC 9562 §5.7) con WebCrypto: funciona igual en el navegador y en Workers.
//
// Estructura: 48 bits de milisegundos Unix (big-endian) | versión 7 (4 bits) | rand_a (12 bits)
//             | variante 0b10 (2 bits) | rand_b (62 bits).
//
// Monotonicidad (RFC 9562 §6.2, método 1): rand_a se usa como contador de 12 bits. Dentro del mismo
// milisegundo, o si el reloj retrocede, se incrementa el contador sobre el último timestamp emitido,
// así los ids generados en un mismo proceso son estrictamente crecientes. Si el contador se agota,
// se avanza 1 ms el timestamp. El contador arranca en un valor aleatorio con el bit alto en 0
// para dejar margen de incremento.

const REGEX_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_CONTADOR = 0xfff;
const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

let ultimoMs = -1;
let contador = 0;

function contadorInicial(aleatorio: Uint8Array): number {
  // 11 bits aleatorios: bit alto del contador en 0.
  return (((aleatorio[0] ?? 0) & 0x07) << 8) | (aleatorio[1] ?? 0);
}

function hex(bytes: Uint8Array): string {
  let salida = '';
  for (const byte of bytes) {
    salida += byte.toString(16).padStart(2, '0');
  }
  return salida;
}

/**
 * Genera un UUID v7 en minúsculas. `ahoraMs` es opcional (por defecto `Date.now()`) y existe para
 * las pruebas.
 */
export function uuidv7(ahoraMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let ms = Math.floor(ahoraMs);
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) {
    throw new RangeError('Timestamp fuera del rango de UUID v7');
  }

  if (ms > ultimoMs) {
    contador = contadorInicial(bytes);
  } else {
    ms = ultimoMs;
    contador += 1;
    if (contador > MAX_CONTADOR) {
      ms += 1;
      contador = contadorInicial(bytes);
    }
  }
  ultimoMs = ms;

  // 48 bits de timestamp. Se divide en dos partes porque los operadores de bits de JS son de 32 bits.
  const alto = Math.floor(ms / 2 ** 16);
  const bajo = ms % 2 ** 16;
  bytes[0] = (alto >>> 24) & 0xff;
  bytes[1] = (alto >>> 16) & 0xff;
  bytes[2] = (alto >>> 8) & 0xff;
  bytes[3] = alto & 0xff;
  bytes[4] = (bajo >>> 8) & 0xff;
  bytes[5] = bajo & 0xff;
  // Versión 7 + 4 bits altos del contador; luego 8 bits bajos del contador.
  bytes[6] = 0x70 | ((contador >>> 8) & 0x0f);
  bytes[7] = contador & 0xff;
  // Variante 0b10.
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Indica si el texto es un UUID v7 en minúsculas. */
export function esUuidV7(valor: unknown): valor is string {
  return typeof valor === 'string' && REGEX_UUID_V7.test(valor);
}

/** Milisegundos Unix codificados en un UUID v7. Devuelve `null` si no es un UUID v7 válido. */
export function timestampDeUuidV7(valor: string): number | null {
  if (!esUuidV7(valor)) {
    return null;
  }
  return Number.parseInt(valor.slice(0, 8) + valor.slice(9, 13), 16);
}

export { REGEX_UUID_V7 };

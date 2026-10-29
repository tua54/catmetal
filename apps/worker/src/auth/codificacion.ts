// Codificaciones binarias usadas por la autenticación (WebCrypto devuelve ArrayBuffer).

/** Base64 estándar CON relleno (`btoa`), el formato del hash de contraseñas (ADR 0007). */
export function aBase64(bytes: Uint8Array): string {
  let binario = '';
  for (const byte of bytes) {
    binario += String.fromCharCode(byte);
  }
  return btoa(binario);
}

/** Decodifica base64 estándar. Devuelve `null` si el texto no es base64 válido. */
export function deBase64(texto: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(texto) || texto.length % 4 !== 0) {
    return null;
  }
  const binario = atob(texto);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) {
    bytes[i] = binario.charCodeAt(i);
  }
  return bytes;
}

/** Base64url sin relleno (tokens que viajan en cookies). */
export function aBase64Url(bytes: Uint8Array): string {
  return aBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Hexadecimal en minúsculas. */
export function aHex(bytes: Uint8Array): string {
  let salida = '';
  for (const byte of bytes) {
    salida += byte.toString(16).padStart(2, '0');
  }
  return salida;
}

export function bytesAleatorios(cantidad: number): Uint8Array {
  const bytes = new Uint8Array(cantidad);
  crypto.getRandomValues(bytes);
  return bytes;
}

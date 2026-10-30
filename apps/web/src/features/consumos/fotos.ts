// Fotos de evidencia (docs/spec.md §6 punto 5, P21; tarea 4.3).
//
// Toda foto se RECOMPRIME a JPEG antes de guardarla (también las HEIC del iPad, que Safari sabe
// decodificar): máximo 1600 px por lado y calidad 0,8. `browser-image-compression` redibuja la
// imagen en un canvas y exporta un JPEG nuevo; con `preserveExif: false` no copia el segmento EXIF
// (ubicación GPS, modelo del equipo, fecha). Como defensa en profundidad, además se quitan del JPEG
// resultante todos los segmentos APP1–APP15 (EXIF, XMP, ICC, IPTC…) y los comentarios.
//
// `useWebWorker: false` es obligatorio: con el Web Worker la librería descarga su código desde
// cdn.jsdelivr.net, lo que rompe la CSP `'self'` y no funciona sin conexión.

//
// La librería (~50 kB) se descarga con `import()` la primera vez que se adjunta una foto: no pesa en
// la carga de la pantalla de registro. Su fragmento queda igual en el precache del Service Worker,
// así que también funciona sin conexión.

import { MAX_EVIDENCIA_BYTES, MAX_EVIDENCIAS_POR_NOVEDAD } from '@catmetal/shared';
import type { Options } from 'browser-image-compression';
import { leerBlob } from '../../lib/blob';

export const MAX_FOTOS = MAX_EVIDENCIAS_POR_NOVEDAD;

export const OPCIONES_COMPRESION = {
  fileType: 'image/jpeg',
  maxWidthOrHeight: 1600,
  initialQuality: 0.8,
  maxSizeMB: 2,
  useWebWorker: false,
  preserveExif: false,
} as const satisfies Options;

export type Compresor = (archivo: File, opciones: Options) => Promise<Blob>;

/** Compresor real: carga `browser-image-compression` bajo demanda (ver la cabecera del archivo). */
export const comprimirConLibreria: Compresor = async (archivo, opciones) => {
  const { default: imageCompression } = await import('browser-image-compression');
  return imageCompression(archivo, opciones);
};

export class ErrorFoto extends Error {
  override readonly name = 'ErrorFoto';
}

const SOI = 0xffd8;
const SOS = 0xffda;
const EOI = 0xffd9;
const COM = 0xfffe;

function esMarcadorDeMetadatos(marcador: number): boolean {
  // APP1 (EXIF/XMP) a APP15 (APP2 = perfil ICC, APP13 = IPTC). Se conserva APP0 (JFIF).
  return (marcador >= 0xffe1 && marcador <= 0xffef) || marcador === COM;
}

function esJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) === SOI;
}

/**
 * Copia del JPEG sin segmentos de metadatos (APP1–APP15 y COM). Solo recorre la cabecera, hasta el
 * inicio de los datos de imagen (SOS): los bytes de la imagen no se tocan. Lanza `ErrorFoto` si los
 * bytes no son un JPEG bien formado.
 */
export function quitarMetadatosJpeg(bytes: Uint8Array): Uint8Array {
  if (!esJpeg(bytes)) {
    throw new ErrorFoto('El archivo no es un JPEG válido.');
  }
  const partes: Uint8Array[] = [bytes.subarray(0, 2)];
  let posicion = 2;
  for (;;) {
    if (posicion + 4 > bytes.length || bytes[posicion] !== 0xff) {
      throw new ErrorFoto('El JPEG está dañado.');
    }
    const marcador = ((bytes[posicion] ?? 0) << 8) | (bytes[posicion + 1] ?? 0);
    if (marcador === SOS || marcador === EOI) {
      partes.push(bytes.subarray(posicion));
      break;
    }
    const largo = ((bytes[posicion + 2] ?? 0) << 8) | (bytes[posicion + 3] ?? 0);
    const fin = posicion + 2 + largo;
    if (largo < 2 || fin > bytes.length) {
      throw new ErrorFoto('El JPEG está dañado.');
    }
    if (!esMarcadorDeMetadatos(marcador)) {
      partes.push(bytes.subarray(posicion, fin));
    }
    posicion = fin;
  }
  const total = partes.reduce((suma, parte) => suma + parte.length, 0);
  const resultado = new Uint8Array(total);
  let desplazamiento = 0;
  for (const parte of partes) {
    resultado.set(parte, desplazamiento);
    desplazamiento += parte.length;
  }
  return resultado;
}

/** ¿El JPEG tiene un segmento EXIF (APP1 que empieza por "Exif")? Solo mira la cabecera. */
export function tieneExif(bytes: Uint8Array): boolean {
  if (!esJpeg(bytes)) {
    return false;
  }
  let posicion = 2;
  while (posicion + 4 <= bytes.length && bytes[posicion] === 0xff) {
    const marcador = ((bytes[posicion] ?? 0) << 8) | (bytes[posicion + 1] ?? 0);
    if (marcador === SOS || marcador === EOI) {
      return false;
    }
    const largo = ((bytes[posicion + 2] ?? 0) << 8) | (bytes[posicion + 3] ?? 0);
    if (
      marcador === 0xffe1 &&
      String.fromCharCode(...bytes.subarray(posicion + 4, posicion + 8)) === 'Exif'
    ) {
      return true;
    }
    posicion += 2 + largo;
  }
  return false;
}

async function leerBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await leerBlob(blob));
}

/**
 * Convierte la foto elegida o tomada en la evidencia que se guarda: JPEG recomprimido, sin
 * metadatos y de máximo 5 MB.
 */
export async function prepararFotoEvidencia(
  archivo: File,
  comprimir: Compresor = comprimirConLibreria,
): Promise<Blob> {
  let comprimida: Blob;
  try {
    comprimida = await comprimir(archivo, { ...OPCIONES_COMPRESION });
  } catch {
    throw new ErrorFoto(
      'No se pudo procesar la foto. Intente tomarla de nuevo o elija otra imagen.',
    );
  }
  const limpia = quitarMetadatosJpeg(await leerBytes(comprimida));
  if (limpia.byteLength > MAX_EVIDENCIA_BYTES) {
    throw new ErrorFoto(
      'La foto es demasiado grande incluso después de comprimirla (máximo 5 MB).',
    );
  }
  return new Blob([limpia as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
}

// JPEG de prueba con metadatos (no se usa en producción).

function segmento(marcador: number, contenido: number[]): number[] {
  const largo = contenido.length + 2;
  return [0xff, marcador, largo >> 8, largo & 0xff, ...contenido];
}

const ascii = (texto: string) => [...texto].map((c) => c.charCodeAt(0));

/**
 * JPEG mínimo con la estructura real de una foto de cámara: SOI, APP0 (JFIF), APP1 (EXIF con datos
 * de GPS simulados), APP1 (XMP), COM, DQT, SOS + datos de imagen y EOI.
 */
export function jpegConExif(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...segmento(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segmento(0xe1, [
      ...ascii('Exif'),
      0,
      0,
      ...ascii('MM'),
      0,
      42,
      ...ascii('GPS 4.69N 74.46W'),
    ]),
    ...segmento(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x/>')]),
    ...segmento(0xfe, ascii('Samsung SM-T505')),
    ...segmento(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...segmento(0xda, [1, 1, 0, 0, 63, 0]),
    0x12,
    0x34,
    0x56,
    0xff,
    0xd9,
  ]);
}

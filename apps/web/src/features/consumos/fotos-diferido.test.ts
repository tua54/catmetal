// El compresor real se carga con `import()` solo al adjuntar una foto (no en la carga de la
// pantalla). jsdom no tiene canvas: la librería se simula.

import { describe, expect, it, vi } from 'vitest';
import { leerBlob } from '../../lib/blob';
import { jpegConExif } from './pruebas/jpeg';

const compresion = vi.hoisted(() => ({ cargada: false }));

vi.mock('browser-image-compression', async () => {
  compresion.cargada = true;
  const { jpegConExif: jpeg } = await import('./pruebas/jpeg');
  return {
    default: vi.fn(() =>
      Promise.resolve(new Blob([jpeg() as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })),
    ),
  };
});

describe('compresión de fotos bajo demanda', () => {
  it('no carga la librería al importar el módulo; sí al preparar la primera foto', async () => {
    const { prepararFotoEvidencia, tieneExif } = await import('./fotos');
    expect(compresion.cargada).toBe(false);

    const archivo = new File([jpegConExif() as Uint8Array<ArrayBuffer>], 'pieza.jpg', {
      type: 'image/jpeg',
    });
    const foto = await prepararFotoEvidencia(archivo);

    expect(compresion.cargada).toBe(true);
    expect(foto.type).toBe('image/jpeg');
    const bytes = new Uint8Array(await leerBlob(foto));
    expect(bytes.length).toBe(foto.size);
    expect(tieneExif(bytes)).toBe(false);
  });

  it('la foto preparada es un JPEG real sin EXIF, leído sin depender de stream()', async () => {
    const { prepararFotoEvidencia, tieneExif } = await import('./fotos');
    const archivo = new File([jpegConExif() as Uint8Array<ArrayBuffer>], 'pieza.jpg', {
      type: 'image/jpeg',
    });
    const foto = await prepararFotoEvidencia(archivo);
    // Simula el Blob de jsdom con Node 22, que no implementa stream().
    Object.defineProperty(foto, 'stream', { value: undefined });

    const bytes = new Uint8Array(await leerBlob(foto));
    // Se comprueba que se leyeron los bytes de la imagen (SOI de JPEG y tamaño), no un texto.
    expect(bytes.length).toBe(foto.size);
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0xff, 0xd8]);
    expect(tieneExif(bytes)).toBe(false);
  });
});

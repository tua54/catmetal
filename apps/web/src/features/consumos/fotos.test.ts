import { MAX_EVIDENCIA_BYTES } from '@catmetal/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ErrorFoto,
  OPCIONES_COMPRESION,
  prepararFotoEvidencia,
  quitarMetadatosJpeg,
  tieneExif,
} from './fotos';
import { jpegConExif } from './pruebas/jpeg';

const texto = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

describe('quitarMetadatosJpeg', () => {
  it('quita EXIF, XMP y comentarios; conserva JFIF, tablas y datos de imagen', () => {
    const original = jpegConExif();
    expect(tieneExif(original)).toBe(true);

    const limpio = quitarMetadatosJpeg(original);

    expect(tieneExif(limpio)).toBe(false);
    expect(texto(limpio)).not.toMatch(/Exif|GPS|adobe|Samsung/);
    expect(texto(limpio)).toMatch(/JFIF/);
    expect([...limpio.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...limpio.subarray(-5)]).toEqual([0x12, 0x34, 0x56, 0xff, 0xd9]);
    expect(limpio.length).toBeLessThan(original.length);
  });

  it('rechaza lo que no es un JPEG o está truncado', () => {
    expect(() => quitarMetadatosJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(ErrorFoto);
    expect(() => quitarMetadatosJpeg(jpegConExif().subarray(0, 30))).toThrow(ErrorFoto);
    expect(tieneExif(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('prepararFotoEvidencia', () => {
  it('recomprime a JPEG sin Web Worker ni EXIF y guarda una foto sin metadatos', async () => {
    const comprimir = vi.fn(() =>
      Promise.resolve(new Blob([jpegConExif() as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })),
    );
    const heic = new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: 'image/heic' });

    const foto = await prepararFotoEvidencia(heic, comprimir);

    expect(comprimir).toHaveBeenCalledWith(heic, {
      fileType: 'image/jpeg',
      maxWidthOrHeight: 1600,
      initialQuality: 0.8,
      maxSizeMB: 2,
      useWebWorker: false,
      preserveExif: false,
    });
    expect(OPCIONES_COMPRESION.useWebWorker).toBe(false);
    expect(foto.type).toBe('image/jpeg');
    const bytes = new Uint8Array(await foto.arrayBuffer());
    expect(tieneExif(bytes)).toBe(false);
    expect(texto(bytes)).not.toMatch(/GPS/);
  });

  it('explica en español si la foto no se puede procesar', async () => {
    const archivo = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' });
    await expect(
      prepararFotoEvidencia(archivo, () => Promise.reject(new Error('canvas'))),
    ).rejects.toThrow('No se pudo procesar la foto');
    await expect(
      prepararFotoEvidencia(archivo, () =>
        Promise.resolve(
          new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
        ),
      ),
    ).rejects.toThrow(ErrorFoto);
  });

  it('rechaza una foto que sigue pasando de 5 MB', async () => {
    const enorme = new Uint8Array(MAX_EVIDENCIA_BYTES + 100);
    enorme.set([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0, 0]);
    const archivo = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' });
    await expect(
      prepararFotoEvidencia(archivo, () =>
        Promise.resolve(new Blob([enorme], { type: 'image/jpeg' })),
      ),
    ).rejects.toThrow('demasiado grande');
  });
});

// El compresor real se carga con `import()` solo al adjuntar una foto (no en la carga de la
// pantalla). jsdom no tiene canvas: la librería se simula.

import { describe, expect, it, vi } from 'vitest';
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
    expect(tieneExif(new Uint8Array(await new Response(foto).arrayBuffer()))).toBe(false);
  });
});

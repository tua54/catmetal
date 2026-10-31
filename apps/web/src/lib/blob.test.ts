import { describe, expect, it } from 'vitest';
import { leerBlob } from './blob';

const BYTES = [0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9];

describe('leerBlob', () => {
  it('devuelve los bytes del Blob', async () => {
    const blob = new Blob([new Uint8Array(BYTES)], { type: 'image/jpeg' });
    expect(Array.from(new Uint8Array(await leerBlob(blob)))).toEqual(BYTES);
  });

  it('devuelve los bytes aunque el Blob no tenga arrayBuffer() ni stream() (jsdom en Node 22)', async () => {
    const blob = new Blob([new Uint8Array(BYTES)], { type: 'image/jpeg' });
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined });
    Object.defineProperty(blob, 'stream', { value: undefined });
    expect(Array.from(new Uint8Array(await leerBlob(blob)))).toEqual(BYTES);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isoFechaSchema } from './esquemas';
import { ahoraIso } from './fechas';

afterEach(() => {
  vi.useRealTimers();
});

describe('ahoraIso', () => {
  it('devuelve el instante actual en el formato único de 24 caracteres', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T20:55:00Z'));
    expect(ahoraIso()).toBe('2026-10-29T20:55:00.000Z');
  });

  it('su salida pasa isoFechaSchema sin cambios', () => {
    const ahora = ahoraIso();
    expect(ahora).toHaveLength(24);
    expect(ahora).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isoFechaSchema.parse(ahora)).toBe(ahora);
  });
});

import { describe, expect, it } from 'vitest';
import { esUuidV7, REGEX_UUID_V7, timestampDeUuidV7, uuidv7 } from './uuid';

describe('uuidv7', () => {
  it('tiene formato de UUID v7 en minúsculas, versión 7 y variante 10', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = uuidv7();
      expect(id).toMatch(REGEX_UUID_V7);
      expect(id).toHaveLength(36);
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
      expect(id).toBe(id.toLowerCase());
    }
  });

  it('codifica el timestamp en los primeros 48 bits', () => {
    const ms = Date.UTC(2030, 0, 1, 12, 0, 0, 123);
    const id = uuidv7(ms);
    expect(timestampDeUuidV7(id)).toBe(ms);
    expect(id.slice(0, 13)).toBe(
      `${ms.toString(16).padStart(12, '0').slice(0, 8)}-${ms
        .toString(16)
        .padStart(12, '0')
        .slice(8)}`,
    );
  });

  it('es creciente en milisegundos distintos', () => {
    const base = Date.UTC(2031, 5, 1);
    const ids = [0, 1, 2, 10, 1000, 60_000].map((delta) => uuidv7(base + delta));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('es estrictamente creciente dentro del mismo milisegundo y si el reloj retrocede', () => {
    const base = Date.UTC(2032, 0, 1);
    const ids = [uuidv7(base), uuidv7(base), uuidv7(base), uuidv7(base - 5000), uuidv7(base)];
    for (let i = 1; i < ids.length; i += 1) {
      expect((ids[i] ?? '') > (ids[i - 1] ?? '')).toBe(true);
    }
  });

  it('si se agota el contador de 12 bits avanza el timestamp y sigue creciente', () => {
    const base = Date.UTC(2033, 0, 1);
    let anterior = uuidv7(base);
    for (let i = 0; i < 5000; i += 1) {
      const actual = uuidv7(base);
      expect(actual > anterior).toBe(true);
      anterior = actual;
    }
    expect(timestampDeUuidV7(anterior)).toBeGreaterThan(base);
  });

  it('genera ids únicos', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => uuidv7()));
    expect(ids.size).toBe(2000);
  });

  it('rechaza timestamps fuera de rango', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(Number.NaN)).toThrow(RangeError);
  });
});

describe('esUuidV7', () => {
  it('acepta UUID v7 en minúsculas', () => {
    expect(esUuidV7('01920d5e-8f3a-7b2c-9d4e-0123456789ab')).toBe(true);
    expect(esUuidV7(uuidv7())).toBe(true);
  });

  it('rechaza otras versiones, variantes, mayúsculas y otros tipos', () => {
    expect(esUuidV7('01920d5e-8f3a-4b2c-9d4e-0123456789ab')).toBe(false); // v4
    expect(esUuidV7('01920d5e-8f3a-7b2c-cd4e-0123456789ab')).toBe(false); // variante 11
    expect(esUuidV7('01920D5E-8F3A-7B2C-9D4E-0123456789AB')).toBe(false); // mayúsculas
    expect(esUuidV7('01920d5e8f3a7b2c9d4e0123456789ab')).toBe(false); // sin guiones
    expect(esUuidV7(' 01920d5e-8f3a-7b2c-9d4e-0123456789ab')).toBe(false);
    expect(esUuidV7('')).toBe(false);
    expect(esUuidV7(null)).toBe(false);
    expect(esUuidV7(123)).toBe(false);
  });
});

describe('timestampDeUuidV7', () => {
  it('devuelve null si no es UUID v7', () => {
    expect(timestampDeUuidV7('no-es-uuid')).toBeNull();
  });
});

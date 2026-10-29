import { describe, expect, it } from 'vitest';
import {
  diaBogota,
  formatearCantidad,
  formatearCOP,
  formatearFechaHora,
  formatearHora,
  parsearCantidad,
} from './formato';

describe('formatearCOP', () => {
  it('usa punto de miles, sin decimales y con espacio normal tras "$"', () => {
    // Intl en Node 24 produce "$\u00A04.182.300"; el módulo normaliza el espacio duro a U+0020.
    expect(formatearCOP(4182300)).toBe('$ 4.182.300');
    expect(formatearCOP(950)).toBe('$ 950');
    expect(formatearCOP(0)).toBe('$ 0');
    expect(formatearCOP(1500.6)).toBe('$ 1.501');
    expect(formatearCOP(-1500)).toBe('-$ 1.500');
  });

  it('no contiene espacios especiales', () => {
    expect(formatearCOP(4182300)).not.toMatch(/[\u00A0\u202F]/);
  });
});

describe('formatearHora', () => {
  it('muestra la hora de Bogotá (UTC−5) en 12 h con "a. m." / "p. m."', () => {
    expect(formatearHora('2026-10-29T15:24:00.000Z')).toBe('10:24 a. m.');
    expect(formatearHora('2026-10-29T20:55:00.000Z')).toBe('3:55 p. m.');
    expect(formatearHora('2026-10-30T04:05:00.000Z')).toBe('11:05 p. m.');
    expect(formatearHora('2026-10-29T17:00:00.000Z')).toBe('12:00 p. m.');
  });

  it('no contiene espacios especiales', () => {
    expect(formatearHora('2026-10-29T15:24:00.000Z')).not.toMatch(/[\u00A0\u202F]/);
  });

  it('devuelve texto vacío si la fecha no es válida', () => {
    expect(formatearHora('no-es-fecha')).toBe('');
  });
});

describe('formatearFechaHora', () => {
  it('muestra fecha y hora de Bogotá', () => {
    expect(formatearFechaHora('2026-10-29T15:24:00.000Z')).toBe('29/10/2026, 10:24 a. m.');
    // 02:00 UTC del 30 es aún el 29 en Bogotá.
    expect(formatearFechaHora('2026-10-30T02:00:00.000Z')).toBe('29/10/2026, 9:00 p. m.');
  });

  it('devuelve texto vacío si la fecha no es válida', () => {
    expect(formatearFechaHora('')).toBe('');
  });
});

describe('formatearCantidad', () => {
  it('usa coma decimal, punto de miles y hasta 3 decimales', () => {
    expect(formatearCantidad(125.5)).toBe('125,5');
    expect(formatearCantidad(1234.5)).toBe('1.234,5');
    expect(formatearCantidad(1000)).toBe('1.000');
    expect(formatearCantidad(0.125)).toBe('0,125');
    expect(formatearCantidad(1234.5678)).toBe('1.234,568');
    expect(formatearCantidad(7)).toBe('7');
  });
});

describe('diaBogota', () => {
  it('devuelve el día calendario de Bogotá', () => {
    expect(diaBogota('2026-10-29T15:24:00.000Z')).toBe('2026-10-29');
    // Antes de las 05:00 UTC todavía es el día anterior en Bogotá.
    expect(diaBogota('2026-10-30T04:59:59.999Z')).toBe('2026-10-29');
    expect(diaBogota('2026-10-30T05:00:00.000Z')).toBe('2026-10-30');
    expect(diaBogota('2027-01-01T03:00:00.000Z')).toBe('2026-12-31');
  });

  it('lanza RangeError si la fecha no es válida', () => {
    expect(() => diaBogota('2026-13-45')).toThrow(RangeError);
  });
});

describe('parsearCantidad', () => {
  it('acepta enteros y un solo separador decimal (punto o coma)', () => {
    expect(parsearCantidad('125')).toBe(125);
    expect(parsearCantidad('125,5')).toBe(125.5);
    expect(parsearCantidad('125.5')).toBe(125.5);
    expect(parsearCantidad('0,125')).toBe(0.125);
    expect(parsearCantidad('  42,75  ')).toBe(42.75);
    expect(parsearCantidad('0')).toBe(0);
  });

  it('con un solo separador una vez, lo interpreta como decimal (también "1.234")', () => {
    expect(parsearCantidad('1.234')).toBe(1.234);
    expect(parsearCantidad('1,234')).toBe(1.234);
  });

  it('con ambos separadores, el último es el decimal', () => {
    expect(parsearCantidad('1.234,5')).toBe(1234.5);
    expect(parsearCantidad('1,234.5')).toBe(1234.5);
    expect(parsearCantidad('1.234.567,125')).toBe(1234567.125);
  });

  it('el mismo separador repetido es de miles', () => {
    expect(parsearCantidad('1.234.567')).toBe(1234567);
    expect(parsearCantidad('1,234,567')).toBe(1234567);
  });

  it('rechaza grupos de miles mal formados', () => {
    expect(parsearCantidad('1.23.456')).toBeNull();
    expect(parsearCantidad('12.34,5')).toBeNull();
    expect(parsearCantidad('1234.567,5')).toBeNull();
    expect(parsearCantidad('1.234,5,6')).toBeNull();
    expect(parsearCantidad('1,234.5.6')).toBeNull();
  });

  it('rechaza más de 3 decimales', () => {
    expect(parsearCantidad('1,2345')).toBeNull();
    expect(parsearCantidad('1.234,5678')).toBeNull();
  });

  it('rechaza textos que no son cantidades', () => {
    for (const texto of [
      '',
      '   ',
      'abc',
      '12kg',
      '-5',
      '+5',
      '1e3',
      ',5',
      '5,',
      '1.234,',
      '.',
      ',',
      '1 234',
    ]) {
      expect(parsearCantidad(texto), texto).toBeNull();
    }
  });
});

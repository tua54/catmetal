import { describe, expect, it } from 'vitest';
import { UNIDADES } from './dominio';
import { convertir, excedeTolerancia, MAGNITUD, redondear6, sonConvertibles } from './unidades';

describe('sonConvertibles', () => {
  it('permite solo kg↔g, l↔ml y la identidad', () => {
    expect(sonConvertibles('kg', 'g')).toBe(true);
    expect(sonConvertibles('g', 'kg')).toBe(true);
    expect(sonConvertibles('l', 'ml')).toBe(true);
    expect(sonConvertibles('ml', 'l')).toBe(true);
    for (const unidad of UNIDADES) {
      expect(sonConvertibles(unidad, unidad)).toBe(true);
    }
    expect(sonConvertibles('kg', 'l')).toBe(false);
    expect(sonConvertibles('g', 'ml')).toBe(false);
    expect(sonConvertibles('und', 'kg')).toBe(false);
    expect(sonConvertibles('m', 'und')).toBe(false);
    expect(sonConvertibles('m', 'ml')).toBe(false);
  });

  it('asigna una magnitud a cada unidad', () => {
    for (const unidad of UNIDADES) {
      expect(MAGNITUD[unidad]).toBeDefined();
    }
  });
});

describe('convertir', () => {
  it('convierte kg↔g y l↔ml', () => {
    expect(convertir(2.5, 'kg', 'g')).toBe(2500);
    expect(convertir(750, 'g', 'kg')).toBe(0.75);
    expect(convertir(1.2, 'l', 'ml')).toBe(1200);
    expect(convertir(330, 'ml', 'l')).toBe(0.33);
  });

  it('redondea a 6 decimales para que 0,1 kg sea exactamente 100 g', () => {
    // 0.1 * 1000 en coma flotante es 100.00000000000001 sin redondeo.
    expect(convertir(0.1, 'kg', 'g')).toBe(100);
    expect(convertir(0.3, 'l', 'ml')).toBe(300);
    expect(convertir(1, 'g', 'kg')).toBe(0.001);
    expect(convertir(0.001, 'g', 'kg')).toBe(0.000001);
    expect(convertir(0.0004, 'g', 'kg')).toBe(0);
  });

  it('la identidad devuelve la misma cantidad', () => {
    expect(convertir(12.345, 'kg', 'kg')).toBe(12.345);
    expect(convertir(7, 'und', 'und')).toBe(7);
    expect(convertir(3.5, 'm', 'm')).toBe(3.5);
  });

  it('devuelve null si las unidades son incompatibles (UNIDAD_INCOMPATIBLE)', () => {
    expect(convertir(1, 'kg', 'l')).toBeNull();
    expect(convertir(1, 'ml', 'g')).toBeNull();
    expect(convertir(1, 'und', 'kg')).toBeNull();
    expect(convertir(1, 'm', 'und')).toBeNull();
  });

  it('devuelve null si la cantidad no es finita', () => {
    expect(convertir(Number.NaN, 'kg', 'g')).toBeNull();
    expect(convertir(Number.POSITIVE_INFINITY, 'kg', 'kg')).toBeNull();
  });

  it('ida y vuelta conserva la cantidad', () => {
    for (const cantidad of [0.001, 0.1, 1.234, 99.999, 1234.567]) {
      const g = convertir(cantidad, 'kg', 'g');
      expect(g).not.toBeNull();
      expect(convertir(g ?? 0, 'g', 'kg')).toBe(cantidad);
    }
  });
});

describe('redondear6', () => {
  it('redondea y normaliza -0 a 0', () => {
    expect(redondear6(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(redondear6(-0.0000001), 0)).toBe(true);
  });
});

describe('excedeTolerancia', () => {
  it('justo en el límite no excede; por encima sí', () => {
    // 100 kg planeados + 5 % = 105 kg.
    expect(excedeTolerancia({ planeada: 100, consumidaAcumulada: 105, toleranciaPct: 5 })).toBe(
      false,
    );
    expect(excedeTolerancia({ planeada: 100, consumidaAcumulada: 105.001, toleranciaPct: 5 })).toBe(
      true,
    );
    expect(excedeTolerancia({ planeada: 100, consumidaAcumulada: 80, toleranciaPct: 5 })).toBe(
      false,
    );
  });

  it('el límite no depende de errores de coma flotante', () => {
    // 0.3 * 1.1 = 0.33000000000000007 en coma flotante.
    expect(excedeTolerancia({ planeada: 0.3, consumidaAcumulada: 0.33, toleranciaPct: 10 })).toBe(
      false,
    );
    // 0.1 + 0.2 acumulado = 0.30000000000000004; con tolerancia 0 % y plan 0,3 no excede.
    expect(
      excedeTolerancia({ planeada: 0.3, consumidaAcumulada: 0.1 + 0.2, toleranciaPct: 0 }),
    ).toBe(false);
    expect(excedeTolerancia({ planeada: 0.3, consumidaAcumulada: 0.301, toleranciaPct: 0 })).toBe(
      true,
    );
  });

  it('con tolerancia 0 % cualquier exceso sobre lo planeado excede', () => {
    expect(excedeTolerancia({ planeada: 50, consumidaAcumulada: 50, toleranciaPct: 0 })).toBe(
      false,
    );
    expect(excedeTolerancia({ planeada: 50, consumidaAcumulada: 50.001, toleranciaPct: 0 })).toBe(
      true,
    );
  });

  it('si no hay nada planeado, cualquier consumo excede', () => {
    expect(excedeTolerancia({ planeada: 0, consumidaAcumulada: 0.001, toleranciaPct: 5 })).toBe(
      true,
    );
    expect(excedeTolerancia({ planeada: 0, consumidaAcumulada: 0, toleranciaPct: 5 })).toBe(false);
    expect(excedeTolerancia({ planeada: -1, consumidaAcumulada: 1, toleranciaPct: 5 })).toBe(true);
  });
});

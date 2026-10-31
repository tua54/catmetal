import { describe, expect, it } from 'vitest';
import type { PlaneadoVsConsumidoLocal } from '../../datos';
import { evaluarNovedad, unidadesConvertibles } from './reglas';

const avance: PlaneadoVsConsumidoLocal = {
  order_id: 'o',
  tolerancia_pct: 5,
  materiales: [
    {
      material_id: 'arena',
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      cantidad_planeada: 100,
      consumido: 80,
      porcentaje: 80,
      excede_tolerancia: false,
    },
  ],
  fuera_de_plan: [],
  incompatibles: 0,
};

describe('unidades convertibles (S11)', () => {
  it('solo kg↔g y l↔ml; und y m sin conversión', () => {
    expect(unidadesConvertibles('kg')).toEqual(['kg', 'g']);
    expect(unidadesConvertibles('g')).toEqual(['kg', 'g']);
    expect(unidadesConvertibles('l')).toEqual(['l', 'ml']);
    expect(unidadesConvertibles('und')).toEqual(['und']);
    expect(unidadesConvertibles('m')).toEqual(['m']);
  });
});

describe('novedad obligatoria (S7, P10)', () => {
  it('sin material o sin cantidad no se evalúa', () => {
    expect(
      evaluarNovedad(avance, { material_id: null, cantidad: 5, unidad: 'kg' }).obligatoria,
    ).toBe(false);
    const sinCantidad = evaluarNovedad(avance, {
      material_id: 'arena',
      cantidad: null,
      unidad: 'kg',
    });
    expect(sinCantidad.obligatoria).toBe(false);
    expect(sinCantidad.plan).toMatchObject({ planeada: 100, consumido: 80, limite: 105 });
  });

  it('justo en el límite (plan + 5 %) no obliga; un gramo más sí, con conversión', () => {
    expect(
      evaluarNovedad(avance, { material_id: 'arena', cantidad: 25, unidad: 'kg' }).obligatoria,
    ).toBe(false);
    const excede = evaluarNovedad(avance, { material_id: 'arena', cantidad: 25001, unidad: 'g' });
    expect(excede.obligatoria).toBe(true);
    expect(excede.motivo).toBe(
      'Con este registro la orden llevaría 105,001 kg de este material; lo planeado más la tolerancia (5 %) es 105 kg. La novedad es obligatoria.',
    );
  });

  it('un material fuera del plan siempre obliga la novedad', () => {
    const fuera = evaluarNovedad(avance, { material_id: 'grafito', cantidad: 1, unidad: 'kg' });
    expect(fuera).toMatchObject({ obligatoria: true, fueraDelPlan: true, plan: null });
    expect(fuera.motivo).toMatch(/no está en el plan/);
  });

  it('al editar no cuenta dos veces el consumo original', () => {
    const excluir = { material_id: 'arena', cantidad: 20, unidad: 'kg' as const };
    // 80 - 20 + 25 = 85: dentro de la tolerancia.
    expect(
      evaluarNovedad(avance, { material_id: 'arena', cantidad: 25, unidad: 'kg' }, excluir)
        .obligatoria,
    ).toBe(false);
    expect(
      evaluarNovedad(avance, { material_id: 'arena', cantidad: 46, unidad: 'kg' }, excluir)
        .obligatoria,
    ).toBe(true);
  });

  it('una unidad incompatible no se suma (el servidor la rechaza con UNIDAD_INCOMPATIBLE)', () => {
    expect(
      evaluarNovedad(avance, { material_id: 'arena', cantidad: 500, unidad: 'l' }).obligatoria,
    ).toBe(false);
  });
});

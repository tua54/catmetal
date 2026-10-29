import { describe, expect, it } from 'vitest';
import {
  idParamSchema,
  LIMITE_PAGINA_DEFECTO,
  LIMITE_PAGINA_MAXIMO,
  limiteQuerySchema,
  listarMaterialesQuerySchema,
  listarOrdenesQuerySchema,
  paginacionQuerySchema,
} from './consultas';
import { uuidv7 } from './uuid';

describe('consultas', () => {
  it('limiteQuerySchema acepta 1..100 y rechaza el resto', () => {
    expect(limiteQuerySchema.parse('1')).toBe(1);
    expect(limiteQuerySchema.parse('100')).toBe(LIMITE_PAGINA_MAXIMO);
    for (const limite of ['0', '101', '007', '-1', '1.5', 'abc', '', '1000']) {
      const resultado = limiteQuerySchema.safeParse(limite);
      expect(resultado.success, limite).toBe(false);
      if (!resultado.success) {
        expect(resultado.error.issues[0]?.message).toBe(
          'El límite debe ser un entero entre 1 y 100.',
        );
      }
    }
    expect(LIMITE_PAGINA_DEFECTO).toBeLessThanOrEqual(LIMITE_PAGINA_MAXIMO);
  });

  it('paginacionQuerySchema exige un cursor UUID v7 y deja todo opcional', () => {
    const cursor = uuidv7();
    expect(paginacionQuerySchema.parse({})).toEqual({});
    expect(paginacionQuerySchema.parse({ cursor, limite: '20' })).toEqual({ cursor, limite: 20 });
    expect(paginacionQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    // Una clave repetida llega como arreglo: se rechaza.
    expect(paginacionQuerySchema.safeParse({ cursor: [cursor, cursor] }).success).toBe(false);
  });

  it('idParamSchema exige un UUID v7', () => {
    const id = uuidv7();
    expect(idParamSchema.parse({ id })).toEqual({ id });
    expect(idParamSchema.safeParse({ id: '1' }).success).toBe(false);
    expect(idParamSchema.safeParse({ id: id.toUpperCase() }).success).toBe(false);
  });

  it('listarMaterialesQuerySchema convierte activo a booleano', () => {
    expect(listarMaterialesQuerySchema.parse({ activo: 'true' })).toEqual({ activo: true });
    expect(listarMaterialesQuerySchema.parse({ activo: 'false' })).toEqual({ activo: false });
    const resultado = listarMaterialesQuerySchema.safeParse({ activo: '1' });
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.issues[0]?.message).toBe('El valor debe ser true o false.');
    }
  });

  it('listarOrdenesQuerySchema valida el estado', () => {
    expect(listarOrdenesQuerySchema.parse({ estado: 'en_proceso' })).toEqual({
      estado: 'en_proceso',
    });
    const resultado = listarOrdenesQuerySchema.safeParse({ estado: 'abierta' });
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.issues[0]?.message).toBe('El estado de la orden no es válido.');
    }
  });
});

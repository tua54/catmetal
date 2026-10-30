import { describe, expect, it } from 'vitest';
import { MAX_ENTIDADES_SNAPSHOT, snapshotQuerySchema, snapshotResponseSchema } from './snapshot';
import { uuidv7 } from './uuid';

describe('snapshotQuerySchema', () => {
  it('acepta el alcance inicial sin página', () => {
    expect(snapshotQuerySchema.safeParse({ alcance: 'inicial' }).success).toBe(true);
  });

  it('acepta el alcance de orden con order_id y página', () => {
    const r = snapshotQuerySchema.safeParse({
      alcance: 'orden',
      order_id: uuidv7(),
      pagina: 'eyJ0IjoxfQ',
    });
    expect(r.success).toBe(true);
  });

  it('exige order_id cuando el alcance es orden', () => {
    const r = snapshotQuerySchema.safeParse({ alcance: 'orden' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['order_id']);
  });

  it('rechaza un alcance desconocido y una página con caracteres no permitidos', () => {
    expect(snapshotQuerySchema.safeParse({ alcance: 'todo' }).success).toBe(false);
    expect(snapshotQuerySchema.safeParse({ alcance: 'inicial', pagina: 'a b' }).success).toBe(
      false,
    );
    expect(
      snapshotQuerySchema.safeParse({ alcance: 'inicial', pagina: 'a'.repeat(513) }).success,
    ).toBe(false);
  });
});

describe('snapshotResponseSchema', () => {
  const base = {
    epoca: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b',
    cursor: 42,
    entidades: [{ entidad: 'materials', id: uuidv7(), datos: { codigo: 'MP-001' } }],
    siguiente_pagina: null,
  };

  it('acepta una página final', () => {
    expect(snapshotResponseSchema.safeParse(base).success).toBe(true);
  });

  it('acepta una página intermedia con token', () => {
    expect(snapshotResponseSchema.safeParse({ ...base, siguiente_pagina: 'abc' }).success).toBe(
      true,
    );
  });

  it('rechaza más entidades que el máximo, cursor negativo y época vacía', () => {
    const muchas = Array.from({ length: MAX_ENTIDADES_SNAPSHOT + 1 }, () => base.entidades[0]);
    expect(snapshotResponseSchema.safeParse({ ...base, entidades: muchas }).success).toBe(false);
    expect(snapshotResponseSchema.safeParse({ ...base, cursor: -1 }).success).toBe(false);
    expect(snapshotResponseSchema.safeParse({ ...base, epoca: '' }).success).toBe(false);
  });
});

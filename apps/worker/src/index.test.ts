// Prueba trivial con Vitest estándar; el pool de Workers se configura en la tarea 0.3.
import { describe, expect, it } from 'vitest';
import { NOMBRE_SERVICIO } from './index';

describe('@catmetal/worker', () => {
  it('expone el nombre del servicio', () => {
    expect(NOMBRE_SERVICIO).toBe('catmetal-worker');
  });
});

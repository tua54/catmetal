import { describe, expect, it } from 'vitest';
import { NOMBRE_PAQUETE } from './index';

describe('@catmetal/shared', () => {
  it('expone su punto de entrada', () => {
    expect(NOMBRE_PAQUETE).toBe('@catmetal/shared');
  });
});

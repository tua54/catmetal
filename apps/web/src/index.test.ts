// @vitest-environment jsdom
// Prueba trivial en jsdom; la configuración de Vitest + Testing Library se completa en la tarea 0.4.
import { describe, expect, it } from 'vitest';
import { NOMBRE_APP, PAQUETE_COMPARTIDO } from './index';

describe('@catmetal/web', () => {
  it('se ejecuta en jsdom y resuelve @catmetal/shared', () => {
    expect(NOMBRE_APP).toBe('catmetal-web');
    expect(PAQUETE_COMPARTIDO).toBe('@catmetal/shared');
    expect(typeof document.createElement).toBe('function');
  });
});

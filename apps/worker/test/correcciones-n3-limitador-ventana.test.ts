// N3 (docs/correcciones-v1.2.md): las pruebas que esperan el 429 al sexto intento de login dependían
// de la hora. El limitador simulado de Miniflare cuenta por ventanas alineadas al reloj de pared; si
// la ráfaga cruza el cambio de ventana, el contador vuelve a 0 y el sexto intento responde 401.
//
// Esta prueba fuerza la condición en lugar de esperar al azar: empieza la ráfaga a 1,5 s del cambio
// de ventana. Cada 401 tarda al menos 400 ms (piso de H-02), así que 5 intentos duran ≥ 2 s y la
// ráfaga cruza el cambio sin falta. Con la precondición `enVentanaDelLimitador`, la ráfaga cae
// entera en una ventana y el sexto intento da 429.

import { uuidv7 } from '@catmetal/shared';
import { describe, expect, it } from 'vitest';
import { peticion } from './auth-helpers';
import {
  enVentanaDelLimitador,
  MARGEN_LIMITADOR_MS,
  PERIODO_LIMITADOR_MS,
  restanteDeVentana,
} from './limitador-helpers';

const dormir = (ms: number): Promise<void> =>
  new Promise((resolver) => setTimeout(resolver, Math.max(0, ms)));

async function rafaga(email: string, ip: string): Promise<number[]> {
  const estados: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const respuesta = await peticion('/api/v1/auth/login', {
      body: { email, password: 'x', device_id: uuidv7() },
      ip,
    });
    estados.push(respuesta.status);
  }
  return estados;
}

describe('N3: las pruebas del limitador no dependen de la hora', () => {
  it('restanteDeVentana mide lo que queda de la ventana alineada al reloj', () => {
    expect(restanteDeVentana(0)).toBe(PERIODO_LIMITADOR_MS);
    expect(restanteDeVentana(59_000)).toBe(1_000);
    expect(restanteDeVentana(60_000)).toBe(PERIODO_LIMITADOR_MS);
    expect(restanteDeVentana(125_500)).toBe(54_500);
  });

  it('una ráfaga empezada a 1,5 s del cambio de ventana llega al 429 si antes se respeta la precondición', async () => {
    // Se fuerza el peor caso: la ráfaga empezaría justo antes del cambio de ventana.
    await dormir(restanteDeVentana() - 1_500);
    expect(restanteDeVentana()).toBeLessThan(MARGEN_LIMITADOR_MS);

    const restante = await enVentanaDelLimitador();
    expect(restante).toBeGreaterThanOrEqual(MARGEN_LIMITADOR_MS);

    const estados = await rafaga(`n3-${uuidv7()}@catmetal.test`, `ip-${crypto.randomUUID()}`);
    expect(estados).toEqual([401, 401, 401, 401, 401, 429]);
  }, 90_000);
});

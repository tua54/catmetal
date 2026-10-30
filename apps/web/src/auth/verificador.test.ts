import { describe, expect, it } from 'vitest';
import {
  BYTES_SAL,
  BYTES_VERIFICADOR,
  comprobarVerificador,
  crearVerificador,
  derivarVerificador,
  igualesEnTiempoConstante,
  ITERACIONES_VERIFICADOR,
  ultimaMedicionDerivacion,
} from './verificador';

const POCAS = 1_000;

function deBase64(texto: string): number[] {
  return Array.from(atob(texto), (c) => c.charCodeAt(0));
}

describe('verificador PBKDF2', () => {
  it('la constante es 600.000 (ADR 0012)', () => {
    expect(ITERACIONES_VERIFICADOR).toBe(600_000);
    expect(BYTES_SAL).toBe(16);
    expect(BYTES_VERIFICADOR).toBe(32);
  });

  it('ida y vuelta, contraseña mala y formato guardado', async () => {
    const v = await crearVerificador('clave-de-planta', POCAS);
    expect(v).toMatchObject({ algoritmo: 'pbkdf2-sha256', iteraciones: POCAS });
    expect(deBase64(v.sal)).toHaveLength(16);
    expect(deBase64(v.hash)).toHaveLength(32);
    expect(v.ms_derivacion).toBeGreaterThanOrEqual(0);
    expect(await comprobarVerificador('clave-de-planta', v)).toBe(true);
    expect(await comprobarVerificador('clave-de-plantA', v)).toBe(false);
    expect(await comprobarVerificador('', v)).toBe(false);
  });

  it('cada verificador tiene su propia sal', async () => {
    const a = await crearVerificador('misma', POCAS);
    const b = await crearVerificador('misma', POCAS);
    expect(a.sal).not.toBe(b.sal);
    expect(a.hash).not.toBe(b.hash);
  });

  it('se comprueba con las iteraciones GUARDADAS, no con la constante', async () => {
    const v = await crearVerificador('clave', 2_000);
    expect(await comprobarVerificador('clave', v)).toBe(true);
    expect(ultimaMedicionDerivacion()?.iteraciones).toBe(2_000);
    // Con otras iteraciones el resultado no coincide.
    expect(await comprobarVerificador('clave', { ...v, iteraciones: 2_001 })).toBe(false);
  });

  it('coincide con un vector de PBKDF2-HMAC-SHA256 (RFC 7914 §11)', async () => {
    const salida = await derivarVerificador('passwd', new TextEncoder().encode('salt'), 1);
    const hex = Array.from(salida, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc');
  });

  it('un verificador malformado nunca valida', async () => {
    const v = await crearVerificador('clave', POCAS);
    const malos = [
      { ...v, algoritmo: 'md5' as 'pbkdf2-sha256' },
      { ...v, iteraciones: 0 },
      { ...v, iteraciones: 1.5 },
      { ...v, iteraciones: 50_000_000 },
      { ...v, sal: 'no-es-base64!!' },
      { ...v, sal: btoa('corta') },
      { ...v, hash: btoa('corto') },
    ];
    for (const malo of malos) {
      expect(await comprobarVerificador('clave', malo)).toBe(false);
    }
  });

  it('comparación en tiempo constante', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(igualesEnTiempoConstante(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(igualesEnTiempoConstante(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(igualesEnTiempoConstante(a, new Uint8Array([1, 2]))).toBe(false);
    expect(igualesEnTiempoConstante(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  it(
    'por defecto deriva con 600.000 iteraciones y mide el tiempo',
    { timeout: 30_000 },
    async () => {
      const v = await crearVerificador('clave-real');
      expect(v.iteraciones).toBe(600_000);
      expect(ultimaMedicionDerivacion()).toEqual({ iteraciones: 600_000, ms: v.ms_derivacion });
      expect(await comprobarVerificador('clave-real', v)).toBe(true);
    },
  );
});

import type { Usuario } from '@catmetal/shared';
import { describe, expect, it } from 'vitest';
import { ErrorApi, ErrorRed } from '../../auth';
import {
  campoDuplicado,
  erroresDeCampo,
  MENSAJE_GUARDADO_SIN_CONEXION,
  MENSAJE_ULTIMO_ADMIN,
  mensajeDeError,
} from './errores';
import {
  estaBloqueado,
  indicadorContrasena,
  leerTolerancia,
  parsearCostoCop,
  textoBloqueo,
} from './formato';

describe('parsearCostoCop', () => {
  it.each([
    ['4182', 4182],
    ['4.182', 4182],
    ['1.250.000', 1250000],
    [' $ 4.182 ', 4182],
    ['0', 0],
  ])('"%s" → %d', (texto, valor) => {
    expect(parsearCostoCop(texto)).toBe(valor);
  });

  it.each(['', '4,5', '4.18', '-10', '1.2345', 'abc', '4.182,00'])('"%s" no es válido', (texto) => {
    expect(parsearCostoCop(texto)).toBeNull();
  });
});

describe('indicadorContrasena', () => {
  it('mide solo la longitud (P17: mínimo 10, sin reglas de composición)', () => {
    expect(indicadorContrasena('').nivel).toBe('vacia');
    expect(indicadorContrasena('123456789')).toEqual({
      nivel: 'corta',
      texto: 'Muy corta: falta 1 carácter.',
    });
    expect(indicadorContrasena('a'.repeat(10)).nivel).toBe('aceptable');
    expect(indicadorContrasena('a'.repeat(16)).nivel).toBe('robusta');
  });
});

describe('bloqueo', () => {
  const base: Usuario = {
    id: 'u',
    nombre: 'Ana',
    email: 'ana@catmetal.co',
    rol: 'supervisor',
    activo: true,
    intentos_fallidos: 5,
    bloqueado_hasta: '2026-10-29T15:15:00.000Z',
    created_at: '2026-10-29T15:00:00.000Z',
    updated_at: '2026-10-29T15:00:00.000Z',
  };

  it('está bloqueado solo mientras `bloqueado_hasta` es futuro', () => {
    expect(estaBloqueado(base, new Date('2026-10-29T15:10:00.000Z'))).toBe(true);
    expect(estaBloqueado(base, new Date('2026-10-29T15:20:00.000Z'))).toBe(false);
    expect(estaBloqueado({ ...base, bloqueado_hasta: null })).toBe(false);
    expect(textoBloqueo(base, new Date('2026-10-29T15:10:00.000Z'))).toBe(
      'Bloqueado hasta 29/10/2026, 10:15 a. m.',
    );
    expect(textoBloqueo(base, new Date('2026-10-29T15:20:00.000Z'))).toBeNull();
  });
});

describe('leerTolerancia', () => {
  it('acepta coma o punto decimal y valida 0–100 con 2 decimales', () => {
    expect(leerTolerancia('7,5')).toEqual({ valor: 7.5 });
    expect(leerTolerancia('0')).toEqual({ valor: 0 });
    expect(leerTolerancia('100')).toEqual({ valor: 100 });
    expect(leerTolerancia('')).toEqual({ error: 'Escriba la nueva tolerancia.' });
    expect(leerTolerancia('100,5')).toEqual({ error: 'La tolerancia no puede superar 100 %.' });
    expect(leerTolerancia('1,234')).toEqual({ error: 'La tolerancia admite máximo 2 decimales.' });
    expect(leerTolerancia('-1')).toHaveProperty('error');
  });
});

describe('errores de la API', () => {
  it('traduce sin conexión, último admin y los códigos del contrato', () => {
    expect(mensajeDeError(new ErrorRed(), true)).toBe(MENSAJE_GUARDADO_SIN_CONEXION);
    expect(mensajeDeError(new ErrorRed())).toBe('No hay conexión con el servidor.');
    expect(mensajeDeError(new ErrorApi('ULTIMO_ADMIN', 422))).toBe(MENSAJE_ULTIMO_ADMIN);
    // Nunca se muestra texto arbitrario del servidor: el mensaje del contrato.
    expect(mensajeDeError(new ErrorApi('PERMISO_DENEGADO', 403, '<b>x</b>'))).toBe(
      'No tiene permiso para realizar esta acción.',
    );
    expect(mensajeDeError(new Error('x'))).toMatch(/inesperado/);
  });

  it('lee los detalles de validación y el campo duplicado', () => {
    const validacion = new ErrorApi('VALIDACION', 400, undefined, [
      { campo: 'email', mensaje: 'El correo no es válido.' },
      { campo: 'email', mensaje: 'Otro' },
      { nada: 1 },
    ]);
    expect(erroresDeCampo(validacion)).toEqual({ email: 'El correo no es válido.' });
    expect(erroresDeCampo(new ErrorApi('CONFLICTO', 409))).toEqual({});
    expect(campoDuplicado(new ErrorApi('CONFLICTO', 409, undefined, { campo: 'email' }))).toBe(
      'email',
    );
    expect(
      campoDuplicado(
        new ErrorApi('CONFLICTO', 409, undefined, { entidad: 'materials', campos: ['codigo'] }),
      ),
    ).toBe('codigo');
    expect(campoDuplicado(new ErrorApi('CONFLICTO', 409))).toBeNull();
    expect(campoDuplicado(new ErrorApi('VALIDACION', 400))).toBeNull();
  });
});

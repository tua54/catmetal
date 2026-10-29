import { describe, expect, it } from 'vitest';
import {
  CODIGOS_ERROR,
  CODIGOS_ERROR_LISTA,
  crearError,
  ESTADO_HTTP_POR_CODIGO,
  esCodigoError,
  MENSAJES_ERROR,
} from './errores';

const MINIMOS = [
  'NO_AUTENTICADO',
  'PERMISO_DENEGADO',
  'VALIDACION',
  'NO_ENCONTRADO',
  'CONFLICTO',
  'CREDENCIALES_INVALIDAS',
  'CUENTA_BLOQUEADA',
  'DEMASIADOS_INTENTOS',
  'ORIGEN_INVALIDO',
  'TOKEN_INVALIDO',
  'SESION_REVOCADA',
  'UNIDAD_INCOMPATIBLE',
  'ORDEN_NO_EN_PROCESO',
  'ESTADO_ORDEN_INVALIDO',
  'ORDEN_CON_PENDIENTES',
  'CONSUMO_NO_PENDIENTE',
  'AUTOAPROBACION',
  'REQUIERE_NOVEDAD',
  'DEPENDENCIA_RECHAZADA',
  'EVIDENCIA_DESCONOCIDA',
  'EVIDENCIA_TIPO_INVALIDO',
  'EVIDENCIA_DEMASIADO_GRANDE',
  'EVIDENCIA_YA_SUBIDA',
  'CORRECCION_INVALIDA',
  'MATERIAL_INACTIVO',
  'USUARIO_INACTIVO',
  'ID_INVALIDO',
  'ID_DUPLICADO',
  'LOTE_DEMASIADO_GRANDE',
  'ERROR_INTERNO',
];

describe('errores', () => {
  it('incluye todos los códigos mínimos del contrato', () => {
    for (const codigo of MINIMOS) {
      expect(CODIGOS_ERROR_LISTA).toContain(codigo);
    }
  });

  it('CODIGOS_ERROR mapea cada código a sí mismo y es inmutable', () => {
    for (const codigo of CODIGOS_ERROR_LISTA) {
      expect(CODIGOS_ERROR[codigo]).toBe(codigo);
    }
    expect(Object.isFrozen(CODIGOS_ERROR)).toBe(true);
  });

  it('cada código tiene mensaje en español y estado HTTP válido', () => {
    for (const codigo of CODIGOS_ERROR_LISTA) {
      expect(MENSAJES_ERROR[codigo].length).toBeGreaterThan(10);
      expect(MENSAJES_ERROR[codigo]).toMatch(/\.$/);
      const estado = ESTADO_HTTP_POR_CODIGO[codigo];
      expect(estado).toBeGreaterThanOrEqual(400);
      expect(estado).toBeLessThan(600);
    }
    expect(Object.keys(MENSAJES_ERROR).sort()).toEqual([...CODIGOS_ERROR_LISTA].sort());
    expect(Object.keys(ESTADO_HTTP_POR_CODIGO).sort()).toEqual([...CODIGOS_ERROR_LISTA].sort());
  });

  it('asigna los estados HTTP acordados', () => {
    expect(ESTADO_HTTP_POR_CODIGO.VALIDACION).toBe(400);
    expect(ESTADO_HTTP_POR_CODIGO.ID_INVALIDO).toBe(400);
    for (const codigo of [
      'NO_AUTENTICADO',
      'CREDENCIALES_INVALIDAS',
      'TOKEN_INVALIDO',
      'SESION_REVOCADA',
    ] as const) {
      expect(ESTADO_HTTP_POR_CODIGO[codigo]).toBe(401);
    }
    for (const codigo of ['PERMISO_DENEGADO', 'ORIGEN_INVALIDO', 'AUTOAPROBACION'] as const) {
      expect(ESTADO_HTTP_POR_CODIGO[codigo]).toBe(403);
    }
    expect(ESTADO_HTTP_POR_CODIGO.NO_ENCONTRADO).toBe(404);
    expect(ESTADO_HTTP_POR_CODIGO.EVIDENCIA_DESCONOCIDA).toBe(404);
    for (const codigo of [
      'CONFLICTO',
      'ID_DUPLICADO',
      'CONSUMO_NO_PENDIENTE',
      'ORDEN_CON_PENDIENTES',
    ] as const) {
      expect(ESTADO_HTTP_POR_CODIGO[codigo]).toBe(409);
    }
    expect(ESTADO_HTTP_POR_CODIGO.EVIDENCIA_DEMASIADO_GRANDE).toBe(413);
    expect(ESTADO_HTTP_POR_CODIGO.EVIDENCIA_TIPO_INVALIDO).toBe(415);
    for (const codigo of [
      'UNIDAD_INCOMPATIBLE',
      'ORDEN_NO_EN_PROCESO',
      'ESTADO_ORDEN_INVALIDO',
      'REQUIERE_NOVEDAD',
      'DEPENDENCIA_RECHAZADA',
      'CORRECCION_INVALIDA',
      'MATERIAL_INACTIVO',
    ] as const) {
      expect(ESTADO_HTTP_POR_CODIGO[codigo]).toBe(422);
    }
    expect(ESTADO_HTTP_POR_CODIGO.DEMASIADOS_INTENTOS).toBe(429);
    expect(ESTADO_HTTP_POR_CODIGO.ERROR_INTERNO).toBe(500);
  });

  it('el mensaje de credenciales inválidas no revela si el correo existe', () => {
    expect(MENSAJES_ERROR.CREDENCIALES_INVALIDAS).toBe(
      'Correo o contraseña incorrectos, o la cuenta está bloqueada temporalmente. Intente de nuevo en unos minutos.',
    );
    expect(MENSAJES_ERROR.CREDENCIALES_INVALIDAS).not.toMatch(/no existe|no registrado/i);
  });

  it('crearError usa el mensaje estándar e incluye details solo si se pasa', () => {
    expect(crearError('NO_ENCONTRADO')).toEqual({
      code: 'NO_ENCONTRADO',
      message: MENSAJES_ERROR.NO_ENCONTRADO,
    });
    expect(crearError('NO_ENCONTRADO')).not.toHaveProperty('details');
    const detalles = [{ campo: 'cantidad', mensaje: 'x' }];
    expect(crearError('VALIDACION', detalles)).toEqual({
      code: 'VALIDACION',
      message: MENSAJES_ERROR.VALIDACION,
      details: detalles,
    });
    expect(crearError('CONFLICTO', null)).toHaveProperty('details', null);
  });

  it('esCodigoError reconoce solo códigos conocidos', () => {
    expect(esCodigoError('VALIDACION')).toBe(true);
    expect(esCodigoError('NO_EXISTE')).toBe(false);
    expect(esCodigoError('toString')).toBe(false);
    expect(esCodigoError(42)).toBe(false);
    expect(esCodigoError(undefined)).toBe(false);
  });
});

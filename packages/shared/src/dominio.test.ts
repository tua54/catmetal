import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_S,
  ALERTA_RELOJ_MS,
  BLOQUEO_MINUTOS,
  DECISIONES,
  ESTADOS_CONSUMO,
  ESTADOS_ORDEN,
  ESTADOS_OUTBOX,
  MAX_CAMBIOS_PULL,
  MAX_EVIDENCIA_BYTES,
  MAX_EVIDENCIAS_POR_NOVEDAD,
  MAX_FILAS_REVISADAS_PULL,
  MAX_INTENTOS_LOGIN,
  MAX_MUTACIONES_POR_LOTE,
  MIMES_EVIDENCIA,
  PBKDF2_ITERACIONES_SERVIDOR,
  REFRESH_TOKEN_TTL_S,
  RESULTADOS_MUTACION,
  ROLES,
  TIPOS_MUTACION,
  TIPOS_NOVEDAD,
  TOLERANCIA_PCT_DEFECTO,
  UNIDADES,
  ZONA_HORARIA,
} from './dominio';

describe('dominio', () => {
  it('define los valores de los CHECK de D1 tal como en la spec', () => {
    expect(ROLES).toEqual(['supervisor', 'jefe', 'admin']);
    expect(ESTADOS_ORDEN).toEqual(['planeada', 'en_proceso', 'finalizada', 'cancelada']);
    expect(ESTADOS_CONSUMO).toEqual(['pendiente', 'aprobado', 'rechazado']);
    expect(UNIDADES).toEqual(['kg', 'g', 'l', 'ml', 'und', 'm']);
    expect(TIPOS_NOVEDAD).toEqual(['reproceso', 'merma', 'dano', 'error_registro', 'otro']);
    expect(DECISIONES).toEqual(['aprobado', 'rechazado']);
    expect(RESULTADOS_MUTACION).toEqual(['aplicada', 'rechazada', 'conflicto']);
    expect(ESTADOS_OUTBOX).toEqual(['pendiente', 'enviando', 'aplicada', 'rechazada', 'conflicto']);
    expect(TIPOS_MUTACION).toEqual([
      'consumo.crear',
      'consumo.editar',
      'novedad.crear',
      'consumo.aprobar',
      'consumo.rechazar',
    ]);
    expect(MIMES_EVIDENCIA).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('define los límites del sistema', () => {
    expect(TOLERANCIA_PCT_DEFECTO).toBe(5);
    expect(MAX_MUTACIONES_POR_LOTE).toBe(25);
    expect(MAX_CAMBIOS_PULL).toBe(200);
    expect(MAX_FILAS_REVISADAS_PULL).toBe(1000);
    expect(MAX_EVIDENCIA_BYTES).toBe(5_242_880);
    expect(MAX_EVIDENCIAS_POR_NOVEDAD).toBe(5);
    expect(ACCESS_TOKEN_TTL_S).toBe(15 * 60);
    expect(REFRESH_TOKEN_TTL_S).toBe(30 * 24 * 60 * 60);
    expect(MAX_INTENTOS_LOGIN).toBe(5);
    expect(BLOQUEO_MINUTOS).toBe(15);
    expect(ALERTA_RELOJ_MS).toBe(10 * 60 * 1000);
    expect(ZONA_HORARIA).toBe('America/Bogota');
  });

  it('nunca configura más de 100.000 iteraciones de PBKDF2 (tope del runtime de Workers)', () => {
    expect(PBKDF2_ITERACIONES_SERVIDOR).toBeLessThanOrEqual(100_000);
    expect(PBKDF2_ITERACIONES_SERVIDOR).toBe(100_000);
  });
});

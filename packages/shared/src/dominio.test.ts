import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_S,
  ALERTA_RELOJ_MS,
  BLOQUEO_MINUTOS,
  DECISIONES,
  ENTIDADES_SYNC,
  ESTADOS_CONSUMO,
  ESTADOS_ORDEN,
  ESTADOS_OUTBOX,
  MAX_CAMBIOS_PULL,
  MAX_EVIDENCIA_BYTES,
  MAX_EVIDENCIAS_POR_NOVEDAD,
  MAX_FILAS_REVISADAS_PULL,
  MAX_INTENTOS_LOGIN,
  MAX_INTENTOS_LOGIN_GLOBAL,
  MAX_MUTACIONES_POR_LOTE,
  MAX_PAYLOAD_MUTACION_BYTES,
  MIMES_EVIDENCIA,
  PBKDF2_ITERACIONES_SERVIDOR,
  REFRESH_TOKEN_TTL_S,
  RESULTADOS_MUTACION,
  RETENCION_MUTACIONES_APLICADAS_DIAS,
  ROLES,
  TIPOS_MUTACION,
  TIPOS_NOVEDAD,
  TOLERANCIA_PCT_DEFECTO,
  UNIDADES,
  VENTANA_GRACIA_REFRESH_MS,
  VENTANA_INTENTOS_LOGIN_MINUTOS,
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
    expect(MAX_INTENTOS_LOGIN_GLOBAL).toBe(20);
    expect(VENTANA_INTENTOS_LOGIN_MINUTOS).toBe(15);
    expect(ALERTA_RELOJ_MS).toBe(10 * 60 * 1000);
    expect(ZONA_HORARIA).toBe('America/Bogota');
    expect(VENTANA_GRACIA_REFRESH_MS).toBe(30_000);
    expect(RETENCION_MUTACIONES_APLICADAS_DIAS).toBe(30);
    expect(MAX_PAYLOAD_MUTACION_BYTES).toBe(64 * 1024);
  });

  it('lista las entidades sincronizables con su nombre de tabla', () => {
    expect(ENTIDADES_SYNC).toEqual([
      'users',
      'materials',
      'production_orders',
      'order_supervisors',
      'order_planned_materials',
      'consumptions',
      'incidents',
      'evidences',
      'validations',
      'settings',
    ]);
    for (const interna of ['audit_log', 'sync_mutations', 'devices', 'refresh_tokens']) {
      expect(ENTIDADES_SYNC).not.toContain(interna);
    }
  });

  it('nunca configura más de 100.000 iteraciones de PBKDF2 (tope del runtime de Workers)', () => {
    expect(PBKDF2_ITERACIONES_SERVIDOR).toBeLessThanOrEqual(100_000);
    expect(PBKDF2_ITERACIONES_SERVIDOR).toBe(100_000);
  });
});

// Mantenimiento diario del cron, después del backup (ADR 0014, revisión del esquema H14).
//
// 1. Mide el tamaño de la base: conteo de filas por tabla y `meta.size_after` de D1 (bytes), en un
//    log estructurado `tamano_base`. Solo números: ningún dato personal.
// 2. Purga `refresh_tokens` VENCIDOS hace más de 90 días (`expira_at < ?`, con el índice
//    `refresh_tokens_expira_at`: revisión de la Fase 3, B5). Con la del punto 3, son los únicos
//    `DELETE` del sistema: `refresh_tokens` no es tabla de negocio (no tiene trigger
//    `_no_delete`) y su historia de seguridad queda en `audit_log`. Un token revocado vence a más
//    tardar 30 días después de creado (REFRESH_TOKEN_TTL_S), así que también se purga, a lo sumo
//    30 días más tarde que con la condición anterior (`revocado_at < ?`, que obligaba a recorrer
//    la tabla). Una fila purgada ya no sirve para nada, ni siquiera para detectar reuso.
// 3. Purga `login_cupos` (ADR 0018 punto 10): filas sin cambios hace más de 24 h y sin bloqueo
//    vigente (índice `login_cupos_updated_at`). Tabla técnica, no de negocio: sin trigger
//    `_no_delete`; sus bloqueos y desbloqueos quedan en `audit_log`. Solo corre si queda
//    presupuesto después de la purga de `refresh_tokens`.

import { registrar } from '../log';
import { Presupuesto } from './presupuesto';
import { TABLAS_BACKUP } from './tablas';

export const DIAS_RETENCION_REFRESH_TOKENS = 90;
/** Filas por sentencia de purga (D1 no admite `DELETE … LIMIT`; se usa una subconsulta). */
export const LOTE_PURGA = 500;
/** Purga por lotes; usa el índice `refresh_tokens_expira_at` (migración 0005). */
export const SENTENCIA_PURGA = `DELETE FROM refresh_tokens WHERE id IN (
  SELECT id FROM refresh_tokens WHERE expira_at < ?1 LIMIT ?2)`;

/** Horas sin cambios tras las que se purga una fila de `login_cupos` (ADR 0018). */
export const HORAS_RETENCION_LOGIN_CUPOS = 24;
/** Purga por lotes de `login_cupos` (PK compuesta: se usa el rowid). */
export const SENTENCIA_PURGA_LOGIN_CUPOS = `DELETE FROM login_cupos WHERE rowid IN (
  SELECT rowid FROM login_cupos
  WHERE updated_at < ?1 AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= ?2) LIMIT ?3)`;

export interface ResultadoMantenimiento {
  filas: Record<string, number>;
  bytes_base: number | null;
  refresh_tokens_purgados: number;
  /** false si el presupuesto se agotó antes de purgar todo (sigue mañana). */
  purga_completa: boolean;
  umbral_purga: string;
  login_cupos_purgados: number;
  /** false si el presupuesto no alcanzó para purgar todo `login_cupos` (sigue mañana). */
  purga_login_cupos_completa: boolean;
}

export async function ejecutarMantenimiento(
  env: Env,
  ahora: Date,
  presupuesto: Presupuesto = new Presupuesto(),
): Promise<ResultadoMantenimiento> {
  const db = env.DB;

  presupuesto.consumirD1();
  const conteos = await db.batch(
    TABLAS_BACKUP.map((tabla) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabla.nombre}`)),
  );
  const filas: Record<string, number> = {};
  TABLAS_BACKUP.forEach((tabla, i) => {
    const fila = conteos[i]?.results[0] as { n?: unknown } | undefined;
    filas[tabla.nombre] = Number(fila?.n ?? 0);
  });
  const tamano = conteos[0]?.meta.size_after;
  const bytesBase = typeof tamano === 'number' ? tamano : null;
  registrar('info', 'tamano_base', {
    bytes_base: bytesBase,
    ...Object.fromEntries(Object.entries(filas).map(([tabla, n]) => [`filas_${tabla}`, n])),
  });

  const umbral = new Date(
    ahora.getTime() - DIAS_RETENCION_REFRESH_TOKENS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const purga = db.prepare(SENTENCIA_PURGA);
  let purgados = 0;
  let completa = false;
  while (presupuesto.disponible()) {
    presupuesto.consumirD1();
    const { meta } = await purga.bind(umbral, LOTE_PURGA).run();
    purgados += meta.changes;
    if (meta.changes < LOTE_PURGA) {
      completa = true;
      break;
    }
  }
  registrar(completa ? 'info' : 'aviso', 'purga_refresh_tokens', {
    purgados,
    completa,
    umbral,
  });

  const umbralCupos = new Date(
    ahora.getTime() - HORAS_RETENCION_LOGIN_CUPOS * 60 * 60 * 1000,
  ).toISOString();
  const purgaCupos = db.prepare(SENTENCIA_PURGA_LOGIN_CUPOS);
  let cuposPurgados = 0;
  let cuposCompleta = false;
  while (presupuesto.disponible()) {
    presupuesto.consumirD1();
    const { meta } = await purgaCupos.bind(umbralCupos, ahora.toISOString(), LOTE_PURGA).run();
    cuposPurgados += meta.changes;
    if (meta.changes < LOTE_PURGA) {
      cuposCompleta = true;
      break;
    }
  }
  registrar(cuposCompleta ? 'info' : 'aviso', 'purga_login_cupos', {
    purgados: cuposPurgados,
    completa: cuposCompleta,
    umbral: umbralCupos,
  });

  return {
    filas,
    bytes_base: bytesBase,
    refresh_tokens_purgados: purgados,
    purga_completa: completa,
    umbral_purga: umbral,
    login_cupos_purgados: cuposPurgados,
    purga_login_cupos_completa: cuposCompleta,
  };
}

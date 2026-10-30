// Mantenimiento diario del cron, después del backup (ADR 0014, revisión del esquema H14).
//
// 1. Mide el tamaño de la base: conteo de filas por tabla y `meta.size_after` de D1 (bytes), en un
//    log estructurado `tamano_base`. Solo números: ningún dato personal.
// 2. Purga `refresh_tokens` revocados o vencidos hace más de 90 días. Es el ÚNICO `DELETE` del
//    sistema: `refresh_tokens` no es tabla de negocio (no tiene trigger `_no_delete`) y su historia
//    de seguridad queda en `audit_log`. Los refresh tokens viven 30 días (REFRESH_TOKEN_TTL_S), así
//    que una fila purgada ya no sirve para nada, ni siquiera para detectar reuso.

import { registrar } from '../log';
import { Presupuesto } from './presupuesto';
import { TABLAS_BACKUP } from './tablas';

export const DIAS_RETENCION_REFRESH_TOKENS = 90;
/** Filas por sentencia de purga (D1 no admite `DELETE … LIMIT`; se usa una subconsulta). */
export const LOTE_PURGA = 500;

export interface ResultadoMantenimiento {
  filas: Record<string, number>;
  bytes_base: number | null;
  refresh_tokens_purgados: number;
  /** false si el presupuesto se agotó antes de purgar todo (sigue mañana). */
  purga_completa: boolean;
  umbral_purga: string;
}

export async function ejecutarMantenimiento(
  env: Env,
  ahora: Date,
  presupuesto: Presupuesto = new Presupuesto(),
): Promise<ResultadoMantenimiento> {
  const db = env.DB;

  presupuesto.consumir();
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
  const purga = db.prepare(
    `DELETE FROM refresh_tokens WHERE id IN (
       SELECT id FROM refresh_tokens
       WHERE (revocado_at IS NOT NULL AND revocado_at < ?1) OR expira_at < ?1
       LIMIT ?2)`,
  );
  let purgados = 0;
  let completa = false;
  while (presupuesto.disponible()) {
    presupuesto.consumir();
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

  return {
    filas,
    bytes_base: bytesBase,
    refresh_tokens_purgados: purgados,
    purga_completa: completa,
    umbral_purga: umbral,
  };
}

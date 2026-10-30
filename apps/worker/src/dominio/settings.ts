// Configuración del sistema (docs/spec.md §4 y S7). Vive en D1 (`settings`), nunca solo en KV.
// Solo se expone `tolerancia_pct`: `sync_epoca` viaja en `/sync/pull` (ADR 0009).

import { type Configuracion, TOLERANCIA_PCT_DEFECTO, type Tolerancia } from '@catmetal/shared';
import { nuevaMarca, porMarca, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import type { Contexto } from './contexto';
import type { PlanDeEscritura } from './plan';

export const CLAVE_TOLERANCIA = 'tolerancia_pct';

interface FilaSetting {
  clave: string;
  valor: string;
  actualizado_por: string | null;
  created_at: string;
  updated_at: string;
}

/** Valor numérico de la tolerancia guardada (JSON). El trigger `settings_valores_validos` lo exige. */
function toleranciaDe(valor: string | undefined): number {
  if (valor === undefined) {
    return TOLERANCIA_PCT_DEFECTO;
  }
  const numero: unknown = JSON.parse(valor);
  return typeof numero === 'number' && Number.isFinite(numero) && numero >= 0
    ? numero
    : TOLERANCIA_PCT_DEFECTO;
}

/** Sentencia que lee la fila de la tolerancia (para incluirla en un batch de lectura). */
export function sentenciaLeerTolerancia(db: D1Database): D1PreparedStatement {
  return db
    .prepare(
      'SELECT clave, valor, actualizado_por, created_at, updated_at FROM settings WHERE clave = ?',
    )
    .bind(CLAVE_TOLERANCIA);
}

/** Convierte el resultado de `sentenciaLeerTolerancia` en el porcentaje vigente. */
export function toleranciaDeResultado(resultado: D1Result | undefined): number {
  const fila = resultado?.results[0] as FilaSetting | undefined;
  return toleranciaDe(fila?.valor);
}

/** Tolerancia vigente en porcentaje (S7). Si faltara la fila, la de la spec (5 %). */
export async function leerTolerancia(db: D1Database): Promise<number> {
  const fila = await sentenciaLeerTolerancia(db).first<FilaSetting>();
  return toleranciaDe(fila?.valor);
}

export async function leerConfiguracion(db: D1Database): Promise<Configuracion> {
  return { tolerancia_pct: await leerTolerancia(db) };
}

function datosAuditoria(fila: FilaSetting) {
  return { ...fila, valor: JSON.parse(fila.valor) as unknown };
}

/**
 * `PATCH /settings/tolerancia`. Guarda en el `WHERE` el valor y la marca de escritura leídos (N1:
 * un ABA del valor no la deja pasar con un `antes` falso): si otro admin la cambió entretanto, no
 * aplica (409). Auditoría con antes y después, condicionada a la marca de ESTE plan (ADR 0028).
 */
export async function cambiarTolerancia(
  ctx: Contexto,
  entrada: Tolerancia,
): Promise<PlanDeEscritura<Configuracion>> {
  const leida = await ctx.db
    .prepare(
      'SELECT clave, valor, actualizado_por, created_at, updated_at, escritura_id FROM settings WHERE clave = ?',
    )
    .bind(CLAVE_TOLERANCIA)
    .first<FilaSetting & { escritura_id: string | null }>();
  // La marca es interna: no entra en `actual` (ni, por tanto, en la auditoría).
  const marcaLeida = leida?.escritura_id ?? null;
  const actual: FilaSetting | null =
    leida === null
      ? null
      : {
          clave: leida.clave,
          valor: leida.valor,
          actualizado_por: leida.actualizado_por,
          created_at: leida.created_at,
          updated_at: leida.updated_at,
        };
  const marca = nuevaMarca();
  const aplicada = porMarca('settings', { clave: CLAVE_TOLERANCIA }, marca);
  const valor = JSON.stringify(entrada.tolerancia_pct);
  const nueva: FilaSetting = {
    clave: CLAVE_TOLERANCIA,
    valor,
    actualizado_por: ctx.actor.id,
    created_at: actual?.created_at ?? ctx.ahora,
    updated_at: ctx.ahora,
  };
  return {
    sentencias: [
      ctx.db
        .prepare(
          `UPDATE settings SET valor = ?, actualizado_por = ?, updated_at = ?, escritura_id = ?
           WHERE clave = ? AND valor IS ? AND escritura_id IS ?`,
        )
        .bind(
          valor,
          ctx.actor.id,
          ctx.ahora,
          marca,
          CLAVE_TOLERANCIA,
          actual?.valor ?? null,
          marcaLeida,
        ),
      sentenciaAuditoriaCondicional(
        ctx.db,
        {
          entidad: 'settings',
          entidad_id: CLAVE_TOLERANCIA,
          accion: 'settings.tolerancia',
          actor_id: ctx.actor.id,
          device_id: ctx.deviceId,
          antes: actual === null ? null : datosAuditoria(actual),
          despues: datosAuditoria(nueva),
          server_at: ctx.ahora,
          alerta_reloj: ctx.alertaReloj,
        },
        aplicada,
      ),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    aplicada,
    respuesta: { tolerancia_pct: entrada.tolerancia_pct },
  };
}

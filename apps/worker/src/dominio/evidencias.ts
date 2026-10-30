// Evidencias (fotos) en R2 (docs/spec.md §6 punto 5, §7 y §9; docs/plan-fase-2.md "Evidencia").
//
// Subida (`PUT /evidences/:id`): solo quien registró la novedad. El tipo se decide por los
// **magic bytes** (nunca solo por la cabecera) y debe coincidir con el `mime` declarado en la
// novedad; el sha256 calculado debe coincidir con el declarado. Orden de escritura:
//   1. `EVIDENCE.put(storage_key, …)` en R2 (con el sha256 para que R2 también lo verifique);
//   2. un batch con `UPDATE evidences SET subido = 1 …` (guarda `subido = 0`) + auditoría
//      condicionada (`evidencia.subida`, con `order_id`).
// R2 y D1 no comparten transacción: si el paso 2 falla después del 1, el objeto queda en R2 sin
// que la evidencia figure como subida. No hay pérdida ni inconsistencia visible: la evidencia sigue
// `subido = 0`, el cliente reintenta y el `put` sobrescribe el mismo objeto (misma clave, mismo
// contenido verificado por sha256), así que la subida es idempotente. Una evidencia ya subida no se
// vuelve a escribir en R2.

import { type Evidencia, MAX_EVIDENCIA_BYTES, type MimeEvidencia } from '@catmetal/shared';
import { sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import type { Contexto } from './contexto';
import { evidenciaDe } from './consumos';
import type { PlanDeEscritura } from './plan';

export interface FilaEvidenciaCompleta {
  id: string;
  incident_id: string;
  storage_key: string;
  mime: MimeEvidencia;
  tamano_bytes: number;
  sha256: string;
  subido: number;
  subido_at: string | null;
  created_at: string;
  updated_at: string;
  /** Autor de la novedad (único que puede subir la foto). */
  novedad_registrada_por: string;
  order_id: string;
  /** Autor del consumo (para la regla de lectura). */
  consumo_registrado_por: string;
}

export async function buscarEvidencia(
  db: D1Database,
  id: string,
): Promise<FilaEvidenciaCompleta | null> {
  return db
    .prepare(
      `SELECT e.id, e.incident_id, e.storage_key, e.mime, e.tamano_bytes, e.sha256, e.subido,
         e.subido_at, e.created_at, e.updated_at,
         i.registrado_por AS novedad_registrada_por, c.order_id,
         c.registrado_por AS consumo_registrado_por
       FROM evidences AS e
       JOIN incidents AS i ON i.id = e.incident_id
       JOIN consumptions AS c ON c.id = i.consumption_id
       WHERE e.id = ?`,
    )
    .bind(id)
    .first<FilaEvidenciaCompleta>();
}

export function evidenciaPublica(fila: FilaEvidenciaCompleta): Evidencia {
  return evidenciaDe({
    id: fila.id,
    incident_id: fila.incident_id,
    mime: fila.mime,
    tamano_bytes: fila.tamano_bytes,
    sha256: fila.sha256,
    subido: fila.subido,
    subido_at: fila.subido_at,
    created_at: fila.created_at,
    updated_at: fila.updated_at,
  });
}

function empiezaCon(bytes: Uint8Array, firma: readonly number[], desde = 0): boolean {
  return firma.every((byte, i) => bytes[desde + i] === byte);
}

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

/** Tipo real del archivo por sus magic bytes, o `null` si no es JPEG, PNG ni WebP. */
export function detectarMime(bytes: Uint8Array): MimeEvidencia | null {
  if (empiezaCon(bytes, JPEG)) {
    return 'image/jpeg';
  }
  if (empiezaCon(bytes, PNG)) {
    return 'image/png';
  }
  if (empiezaCon(bytes, RIFF) && empiezaCon(bytes, WEBP, 8)) {
    return 'image/webp';
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Lee el cuerpo completo sin pasar de `maximo` bytes: corta en cuanto lo supera, sin acumular más.
 * Devuelve `null` si es demasiado grande.
 */
export async function leerCuerpoLimitado(
  cuerpo: ReadableStream<Uint8Array> | null,
  maximo: number = MAX_EVIDENCIA_BYTES,
): Promise<Uint8Array | null> {
  if (cuerpo === null) {
    return new Uint8Array(0);
  }
  const lector = cuerpo.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maximo) {
      await lector.cancel();
      return null;
    }
    trozos.push(value);
  }
  const bytes = new Uint8Array(total);
  let posicion = 0;
  for (const trozo of trozos) {
    bytes.set(trozo, posicion);
    posicion += trozo.byteLength;
  }
  return bytes;
}

/** `Content-Type` sin parámetros y en minúsculas (`image/jpeg; x=y` → `image/jpeg`). */
export function tipoDeContenido(cabecera: string | undefined): string | null {
  const tipo = cabecera?.split(';')[0]?.trim().toLowerCase();
  return tipo === undefined || tipo === '' ? null : tipo;
}

/**
 * Valida el archivo recibido contra la evidencia declarada, en este orden: 415
 * `EVIDENCIA_TIPO_INVALIDO` si la cabecera o los magic bytes no corresponden al `mime` declarado;
 * 400 `VALIDACION` si el tamaño no es el `tamano_bytes` declarado (H-12); 400 `VALIDACION` si el
 * sha256 no coincide.
 * Devuelve el sha256 calculado.
 */
export async function validarArchivo(
  evidencia: Pick<FilaEvidenciaCompleta, 'mime' | 'sha256' | 'tamano_bytes'>,
  bytes: Uint8Array,
  contentType: string | null,
): Promise<string> {
  const real = detectarMime(bytes);
  if (contentType !== evidencia.mime || real !== evidencia.mime) {
    throw new ErrorApi('EVIDENCIA_TIPO_INVALIDO', {
      mime_declarado: evidencia.mime,
      ...(real === null ? {} : { mime_detectado: real }),
    });
  }
  if (bytes.byteLength !== evidencia.tamano_bytes) {
    throw new ErrorApi('VALIDACION', [
      {
        campo: 'tamano_bytes',
        mensaje: 'El tamaño de la foto no coincide con el declarado al registrar la novedad.',
      },
    ]);
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== evidencia.sha256) {
    throw new ErrorApi('VALIDACION', [
      { campo: 'sha256', mensaje: 'El contenido de la foto no coincide con el sha256 declarado.' },
    ]);
  }
  return sha256;
}

/** Plan que marca la evidencia como subida (guarda `subido = 0`) con su auditoría condicionada. */
export function planMarcarSubida(
  ctx: Contexto,
  evidencia: FilaEvidenciaCompleta,
): PlanDeEscritura<Evidencia> {
  const antes = evidenciaPublica(evidencia);
  const despues: Evidencia = {
    ...antes,
    subido: true,
    subido_at: ctx.ahora,
    updated_at: ctx.ahora,
  };
  return {
    sentencias: [
      ctx.db
        .prepare(
          'UPDATE evidences SET subido = 1, subido_at = ?, updated_at = ? WHERE id = ? AND subido = 0',
        )
        .bind(ctx.ahora, ctx.ahora, evidencia.id),
      sentenciaAuditoriaCondicional(
        ctx.db,
        {
          entidad: 'evidences',
          entidad_id: evidencia.id,
          accion: 'evidencia.subida',
          order_id: evidencia.order_id,
          actor_id: ctx.actor.id,
          device_id: ctx.deviceId,
          antes: { ...antes },
          despues: { ...despues },
          server_at: ctx.ahora,
          alerta_reloj: ctx.alertaReloj,
        },
        {
          sql: 'EXISTS (SELECT 1 FROM evidences WHERE id = ? AND subido = 1 AND subido_at = ?)',
          parametros: [evidencia.id, ctx.ahora],
        },
      ),
    ],
    principal: { indice: 0, cambiosEsperados: 1 },
    respuesta: despues,
    siNoAplica: new ErrorApi('EVIDENCIA_YA_SUBIDA'),
  };
}

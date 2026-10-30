// Contrato de `GET /api/v1/sync/snapshot` (ADR 0005, regla 7; plan de la Fase 3).
//
// El snapshot entrega el estado ACTUAL de todo lo visible para el usuario, paginado. Se usa al
// arrancar (cursor 0), al hidratar una orden recién asignada, al reiniciar (cambio de rol o
// reactivación) y tras un cambio de época. La primera página lee `MAX(audit_log.seq)` ANTES del
// estado, en el mismo batch; ese valor viaja como `cursor` en todas las páginas y el cliente lo
// guarda como cursor de `/sync/pull` al terminar. Los cambios posteriores al cursor se vuelven a
// entregar en el pull, y aplicarlos otra vez es idempotente.
//
// Forma de `datos` por entidad: la misma que devuelve la API REST para esa entidad (y que usa
// `/sync/pull` en los cambios `upsert`). Ids de entidades con clave compuesta:
// `order_supervisors` → `<order_id>:<user_id>`, `order_planned_materials` → `<order_id>:<material_id>`,
// `settings` → la `clave`.

import { z } from 'zod';
import { uuidV7Schema } from './esquemas';

export const ALCANCES_SNAPSHOT = ['inicial', 'orden'] as const;
export type AlcanceSnapshot = (typeof ALCANCES_SNAPSHOT)[number];

/** Tamaño máximo de página del snapshot (entidades por respuesta). */
export const MAX_ENTIDADES_SNAPSHOT = 500;

export const snapshotQuerySchema = z
  .object({
    alcance: z.enum(ALCANCES_SNAPSHOT, { error: 'El alcance debe ser "inicial" u "orden".' }),
    order_id: uuidV7Schema.optional(),
    /** Token opaco devuelto por la página anterior (`siguiente_pagina`). */
    pagina: z
      .string()
      .min(1)
      .max(512, { error: 'La página no es válida.' })
      .regex(/^[A-Za-z0-9_-]+$/, { error: 'La página no es válida.' })
      .optional(),
  })
  .refine((q) => q.alcance !== 'orden' || q.order_id !== undefined, {
    error: 'El alcance "orden" exige order_id.',
    path: ['order_id'],
  });

export const entidadSnapshotSchema = z.object({
  /** Nombre de tabla (`ENTIDADES_SYNC`); el cliente ignora las que no conoce. */
  entidad: z.string().min(1),
  id: z.string().min(1),
  datos: z.record(z.string(), z.unknown()),
});

export const snapshotResponseSchema = z.object({
  epoca: z.string().min(1),
  /** `MAX(audit_log.seq)` leído antes del estado en la primera página; igual en todas las páginas. */
  cursor: z.number().int().min(0),
  entidades: z.array(entidadSnapshotSchema).max(MAX_ENTIDADES_SNAPSHOT),
  /** Token para pedir la siguiente página, o `null` si es la última. */
  siguiente_pagina: z.string().min(1).nullable(),
});

export type SnapshotQuery = z.infer<typeof snapshotQuerySchema>;
export type EntidadSnapshot = z.infer<typeof entidadSnapshotSchema>;
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;

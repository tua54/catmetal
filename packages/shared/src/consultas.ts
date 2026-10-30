// Esquemas Zod de los parámetros de ruta y de la query string de los listados de la API
// (docs/spec.md §7). Todo llega como texto: estos esquemas lo validan y lo convierten.
//
// Paginación: siempre por cursor sobre el id (UUID v7, ordenable por tiempo), nunca con OFFSET
// (docs/spec.md §4). El cursor es el `id` del último elemento de la página anterior.

import { z } from 'zod';
import { ESTADOS_ORDEN } from './dominio';
import { uuidV7Schema } from './esquemas';

/** Tamaño de página por defecto de los listados. */
export const LIMITE_PAGINA_DEFECTO = 50;
/** Tamaño de página máximo de los listados. */
export const LIMITE_PAGINA_MAXIMO = 100;

const MENSAJE_LIMITE = `El límite debe ser un entero entre 1 y ${LIMITE_PAGINA_MAXIMO}.`;

/** `limite` de la query: entero de 1 a 100, sin ceros a la izquierda ni signo. */
export const limiteQuerySchema = z
  .string({ error: MENSAJE_LIMITE })
  .regex(/^[1-9]\d{0,2}$/, { error: MENSAJE_LIMITE })
  .transform(Number)
  .refine((n) => n <= LIMITE_PAGINA_MAXIMO, { error: MENSAJE_LIMITE });

/** Query común de los listados paginados por cursor. */
export const paginacionQuerySchema = z.object({
  cursor: uuidV7Schema.optional(),
  limite: limiteQuerySchema.optional(),
});

/** Parámetro de ruta `:id` (UUID v7). */
export const idParamSchema = z.object({ id: uuidV7Schema });

/** Booleano en la query string: solo `true` o `false`. */
const booleanoQuerySchema = z
  .enum(['true', 'false'], { error: 'El valor debe ser true o false.' })
  .transform((valor) => valor === 'true');

/** `GET /materials?activo=&cursor=&limite=`. */
export const listarMaterialesQuerySchema = paginacionQuerySchema.extend({
  activo: booleanoQuerySchema.optional(),
});

/** `GET /orders?estado=&cursor=&limite=`. */
export const listarOrdenesQuerySchema = paginacionQuerySchema.extend({
  estado: z.enum(ESTADOS_ORDEN, { error: 'El estado de la orden no es válido.' }).optional(),
});

/**
 * `GET /validations/queue?orden=&supervisor=&con_novedad=&cursor=&limite=`. `con_novedad=true`:
 * consumos con alguna novedad o que la requieren; `false`: ni lo uno ni lo otro.
 */
export const colaValidacionQuerySchema = paginacionQuerySchema.extend({
  orden: uuidV7Schema.optional(),
  supervisor: uuidV7Schema.optional(),
  con_novedad: booleanoQuerySchema.optional(),
});

export type PaginacionQuery = z.infer<typeof paginacionQuerySchema>;
export type ColaValidacionQuery = z.infer<typeof colaValidacionQuerySchema>;
export type IdParam = z.infer<typeof idParamSchema>;
export type ListarMaterialesQuery = z.infer<typeof listarMaterialesQuerySchema>;
export type ListarOrdenesQuery = z.infer<typeof listarOrdenesQuerySchema>;

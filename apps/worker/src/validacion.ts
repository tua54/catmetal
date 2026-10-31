// Validación de entradas con Zod (todas las entradas de la API pasan por aquí, docs/spec.md §9).

import { detallesValidacion } from '@catmetal/shared';
import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { ZodError, type z } from 'zod';
import { responderError } from './errores';

/**
 * `validar('json', esquema)`: middleware de `@hono/zod-validator` que, si la entrada no es válida,
 * responde 400 con `{ code: 'VALIDACION', message, details: [{ campo, mensaje }] }`.
 * Los datos validados se leen con `c.req.valid('json')`.
 */
export function validar<Objetivo extends keyof ValidationTargets, Esquema extends z.ZodType>(
  objetivo: Objetivo,
  esquema: Esquema,
) {
  return zValidator(objetivo, esquema, (resultado, c) => {
    if (!resultado.success) {
      // El hook entrega un $ZodError de zod/v4/core; se envuelve en el ZodError clásico que espera shared.
      const error = new ZodError(resultado.error.issues);
      return responderError(c, 'VALIDACION', detallesValidacion(error));
    }
    return undefined;
  });
}

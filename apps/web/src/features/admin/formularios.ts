// Ayudas de formularios y de conexión de la administración (sin componentes: los hooks y funciones
// van aparte de los .tsx para no romper el refresco en caliente de Vite).

import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { useEstadoSync } from '../../sync';

/** El navegador tiene red (el indicador global de conexión). */
export function useEnLinea(): boolean {
  return useEstadoSync((estado) => estado.conexion === 'en_linea');
}

/**
 * Resolver de react-hook-form a partir de un esquema Zod (el mismo patrón que el formulario de
 * consumo): el primer mensaje de cada campo, con los valores ya normalizados por el esquema.
 */
export function resolverDe<T extends FieldValues>(esquema: z.ZodType): Resolver<T> {
  return (valores) => {
    const resultado = esquema.safeParse(valores);
    if (resultado.success) {
      // El esquema valida los mismos campos del formulario (con los valores ya normalizados).
      return { values: resultado.data as T, errors: {} };
    }
    const errores: Record<string, { type: string; message: string }> = {};
    for (const problema of resultado.error.issues) {
      const campo = String(problema.path[0] ?? '');
      if (campo !== '' && errores[campo] === undefined) {
        errores[campo] = { type: 'validate', message: problema.message };
      }
    }
    return { values: {}, errors: errores as FieldErrors<T> };
  };
}

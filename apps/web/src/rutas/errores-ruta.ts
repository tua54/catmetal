// Clasificación de los errores que llegan al límite de errores de las rutas (`RouteErrorPage`).

import { isRouteErrorResponse } from 'react-router';

/** Qué tipo de fallo llegó al límite de errores (nunca se muestra el error técnico). */
export type TipoErrorRuta = 'no_encontrada' | 'sin_conexion' | 'carga' | 'inesperado';

/**
 * Mensajes de los navegadores cuando falla el `import()` de un fragmento de pantalla (Chrome/Edge,
 * Safari y Firefox). Pasa si la tablet no tiene la pantalla en el caché y no hay red, o si se publicó
 * una versión nueva y el fragmento viejo ya no existe.
 */
const FALLO_DE_FRAGMENTO =
  /dynamically imported module|module script failed|importing a module script|error loading dynamically imported/i;

export function clasificarErrorRuta(error: unknown, enLinea: boolean): TipoErrorRuta {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return 'no_encontrada';
  }
  if (error instanceof Error && FALLO_DE_FRAGMENTO.test(error.message)) {
    return enLinea ? 'carga' : 'sin_conexion';
  }
  return 'inesperado';
}

// Traducción de errores de la API a mensajes para el administrador (docs/spec.md §7).

import { MENSAJES_ERROR } from '@catmetal/shared';
import { ErrorApi, esErrorDeRed } from '../../auth';

export const TITULO_SIN_CONEXION = 'Esta pantalla necesita conexión';
export const TEXTO_SIN_CONEXION =
  'La administración trabaja directamente con el servidor y no guarda cambios en la tablet. Conéctese a la red y vuelva a intentarlo.';

/**
 * Sin respuesta del servidor al guardar: el cambio pudo aplicarse o no (la respuesta se pudo perder).
 * Se pide revisar antes de repetir, para no duplicar ni deshacer el trabajo de nadie.
 */
export const MENSAJE_GUARDADO_SIN_CONEXION =
  'No se pudo confirmar el cambio porque no hay conexión con el servidor. Cuando vuelva la conexión, revise la lista antes de intentarlo de nuevo.';

export const MENSAJE_ULTIMO_ADMIN =
  'No se puede desactivar ni quitar el rol de administrador al último administrador activo. Primero cree o reactive otro administrador.';

export const MENSAJE_CONFLICTO_USUARIO =
  'Otro administrador cambió este usuario mientras usted trabajaba. Se recargó la lista con los datos actuales: revíselos y vuelva a intentarlo si aún es necesario.';

export const MENSAJE_CONFLICTO_MATERIAL =
  'Otro administrador cambió este material mientras usted trabajaba. Se recargó la lista con los datos actuales: revíselos y vuelva a intentarlo si aún es necesario.';

export const MENSAJE_CONFLICTO_ASIGNACION =
  'Otro administrador cambió las asignaciones de esta orden mientras usted trabajaba. Se recargaron los datos actuales: revise la lista y guarde de nuevo si aún es necesario.';

export const MENSAJE_SUPERVISOR_NO_VALIDO =
  'Algún supervisor elegido ya no está activo o cambió de rol. Se recargó la lista: revísela y guarde de nuevo.';

export const MENSAJE_CONFLICTO_TOLERANCIA =
  'Otro administrador cambió la tolerancia mientras usted trabajaba. Se recargó el valor actual: revíselo y vuelva a intentarlo si aún es necesario.';

export const MENSAJE_CORREO_DUPLICADO = 'Ya existe un usuario con ese correo.';
export const MENSAJE_CODIGO_DUPLICADO = 'Ya existe un material con ese código.';

export function esSinConexion(error: unknown): boolean {
  return esErrorDeRed(error);
}

export function esCodigo(error: unknown, codigo: ErrorApi['code']): error is ErrorApi {
  return error instanceof ErrorApi && error.code === codigo;
}

/** Mensaje general de un error de lectura o escritura. */
export function mensajeDeError(error: unknown, alGuardar = false): string {
  if (esErrorDeRed(error)) {
    return alGuardar ? MENSAJE_GUARDADO_SIN_CONEXION : 'No hay conexión con el servidor.';
  }
  if (error instanceof ErrorApi) {
    if (error.code === 'ULTIMO_ADMIN') {
      return MENSAJE_ULTIMO_ADMIN;
    }
    // Mensajes del contrato (no se muestra texto arbitrario del servidor).
    return MENSAJES_ERROR[error.code];
  }
  return 'Ocurrió un error inesperado. Intente de nuevo.';
}

/** Errores por campo de un 400 `VALIDACION` (`details: [{ campo, mensaje }]`). */
export function erroresDeCampo(error: unknown): Record<string, string> {
  if (!esCodigo(error, 'VALIDACION') || !Array.isArray(error.details)) {
    return {};
  }
  const errores: Record<string, string> = {};
  for (const detalle of error.details as unknown[]) {
    if (typeof detalle !== 'object' || detalle === null) {
      continue;
    }
    const { campo, mensaje } = detalle as Record<string, unknown>;
    if (typeof campo === 'string' && typeof mensaje === 'string' && errores[campo] === undefined) {
      errores[campo] = mensaje;
    }
  }
  return errores;
}

/** Campo duplicado de un 409 `CONFLICTO` por restricción única (`{ campo }` o `{ campos: [...] }`). */
export function campoDuplicado(error: unknown): string | null {
  if (!esCodigo(error, 'CONFLICTO')) {
    return null;
  }
  const detalles = error.details;
  if (typeof detalles !== 'object' || detalles === null) {
    return null;
  }
  const { campo, campos } = detalles as Record<string, unknown>;
  if (typeof campo === 'string') {
    return campo;
  }
  if (Array.isArray(campos) && typeof campos[0] === 'string') {
    return campos[0];
  }
  return null;
}

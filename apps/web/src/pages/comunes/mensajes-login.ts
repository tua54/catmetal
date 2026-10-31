// Mensajes en español de los errores de inicio de sesión (docs/spec.md §5).

import { MENSAJES_ERROR } from '@catmetal/shared';
import {
  ErrorApi,
  ErrorSesion,
  MENSAJE_ESPERA_INTENTOS,
  MENSAJE_SIN_CONEXION_CONFIRMAR,
} from '../../auth';

export const MENSAJE_SIN_LOGIN_PREVIO =
  'No hay conexión. Para entrar sin conexión, primero inicie sesión con conexión en esta tablet.';

export const MENSAJE_DATOS_INVALIDOS = 'Escriba un correo válido y su contraseña.';

export const MENSAJE_ERROR_DESCONOCIDO =
  'No se pudo iniciar sesión. Intente de nuevo en unos minutos.';

/**
 * Texto para el usuario. Las credenciales inválidas dan SIEMPRE el mismo mensaje genérico (no revela
 * si el correo existe ni si la cuenta está bloqueada). Los errores del servidor se muestran con el
 * mensaje del contrato de shared, no con el texto que venga en la respuesta.
 */
export function mensajeErrorLogin(error: unknown): string {
  if (error instanceof ErrorSesion) {
    switch (error.code) {
      case 'SIN_LOGIN_PREVIO':
        return MENSAJE_SIN_LOGIN_PREVIO;
      case 'CREDENCIALES_INVALIDAS':
        return MENSAJES_ERROR.CREDENCIALES_INVALIDAS;
      case 'VALIDACION':
        return MENSAJE_DATOS_INVALIDOS;
      case 'ESPERA_INTENTOS':
        return MENSAJE_ESPERA_INTENTOS;
      case 'SIN_CONEXION':
        return MENSAJE_SIN_CONEXION_CONFIRMAR;
    }
  }
  if (error instanceof ErrorApi) {
    if (error.code === 'VALIDACION') {
      return MENSAJE_DATOS_INVALIDOS;
    }
    if (error.code === 'ERROR_INTERNO') {
      return MENSAJE_ERROR_DESCONOCIDO;
    }
    return MENSAJES_ERROR[error.code];
  }
  return MENSAJE_ERROR_DESCONOCIDO;
}

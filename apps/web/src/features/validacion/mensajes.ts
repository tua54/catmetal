// Textos de error y de estado del panel del jefe, en español y sin detalles técnicos.

import { MENSAJES_ERROR } from '@catmetal/shared';
import { ErrorApi, esErrorDeRed } from '../../auth';
import { ErrorDatosLocales } from '../../datos';

export const MENSAJE_SIN_CONEXION =
  'No hay conexión con el servidor. Revise la red e intente de nuevo.';

/** Mensaje para la persona a partir de cualquier error de la API, de la red o de la capa local. */
export function mensajeDeError(error: unknown): string {
  if (esErrorDeRed(error)) {
    return MENSAJE_SIN_CONEXION;
  }
  if (error instanceof ErrorApi || error instanceof ErrorDatosLocales) {
    return error.message;
  }
  return MENSAJES_ERROR.ERROR_INTERNO;
}

/** La sesión del servidor no está disponible (sin red, sesión offline o que pide contraseña). */
export function esFaltaDeServidor(error: unknown): boolean {
  if (esErrorDeRed(error)) {
    return true;
  }
  return (
    error instanceof ErrorApi &&
    (error.code === 'NO_AUTENTICADO' ||
      error.code === 'TOKEN_INVALIDO' ||
      error.code === 'SESION_REVOCADA')
  );
}

/** `details.pendientes` de un 409 `ORDEN_CON_PENDIENTES`, o `null` si no viene. */
export function pendientesDeError(error: unknown): number | null {
  if (!(error instanceof ErrorApi) || error.code !== 'ORDEN_CON_PENDIENTES') {
    return null;
  }
  const detalles = error.details;
  if (typeof detalles === 'object' && detalles !== null && 'pendientes' in detalles) {
    const valor = detalles.pendientes;
    return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
  }
  return null;
}

/** `5` → "5 consumos pendientes"; `1` → "1 consumo pendiente". */
export function textoPendientes(cantidad: number): string {
  return cantidad === 1 ? '1 consumo pendiente' : `${cantidad} consumos pendientes`;
}

/**
 * Política de reintento de las consultas del jefe: un reintento solo ante un error 5xx. Un 4xx no
 * cambia al repetirlo y un corte de red ya se maneja (copia de la tablet o aviso "Sin conexión").
 */
export function reintentarConsulta(fallos: number, error: unknown): boolean {
  return fallos < 1 && error instanceof ErrorApi && error.status >= 500;
}

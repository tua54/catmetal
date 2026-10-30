// Códigos de error de la API (docs/spec.md §7: formato único `{ code, message, details }`).
// Los mensajes están en español de Colombia y van dirigidos a un operario de planta: claros, sin
// jerga técnica y sin revelar información sensible (por ejemplo, si un correo existe).

const LISTA_CODIGOS_ERROR = [
  'NO_AUTENTICADO',
  'PERMISO_DENEGADO',
  'VALIDACION',
  'NO_ENCONTRADO',
  'CONFLICTO',
  'CREDENCIALES_INVALIDAS',
  'CUENTA_BLOQUEADA',
  'DEMASIADOS_INTENTOS',
  'ORIGEN_INVALIDO',
  'TOKEN_INVALIDO',
  'SESION_REVOCADA',
  'UNIDAD_INCOMPATIBLE',
  'ORDEN_NO_EN_PROCESO',
  'ESTADO_ORDEN_INVALIDO',
  'ORDEN_CON_PENDIENTES',
  'CONSUMO_NO_PENDIENTE',
  'AUTOAPROBACION',
  'REQUIERE_NOVEDAD',
  'DEPENDENCIA_RECHAZADA',
  'EVIDENCIA_DESCONOCIDA',
  'EVIDENCIA_TIPO_INVALIDO',
  'EVIDENCIA_DEMASIADO_GRANDE',
  'EVIDENCIA_YA_SUBIDA',
  'CORRECCION_INVALIDA',
  'MATERIAL_INACTIVO',
  'USUARIO_INACTIVO',
  'ID_INVALIDO',
  'ID_DUPLICADO',
  'LOTE_DEMASIADO_GRANDE',
  'AUTOR_NO_COINCIDE',
  'EPOCA_CAMBIADA',
  'ULTIMO_ADMIN',
  'ERROR_INTERNO',
] as const;

export type CodigoError = (typeof LISTA_CODIGOS_ERROR)[number];

/**
 * Códigos de error como objeto (`CODIGOS_ERROR.VALIDACION === 'VALIDACION'`).
 * Sirve también como enum de Zod: `z.enum(CODIGOS_ERROR)`.
 */
export const CODIGOS_ERROR = Object.freeze(
  Object.fromEntries(LISTA_CODIGOS_ERROR.map((codigo) => [codigo, codigo])),
) as { readonly [K in CodigoError]: K };

/** Todos los códigos de error, en orden. */
export const CODIGOS_ERROR_LISTA: readonly CodigoError[] = LISTA_CODIGOS_ERROR;

export const MENSAJES_ERROR: Readonly<Record<CodigoError, string>> = {
  NO_AUTENTICADO: 'Su sesión no está activa. Inicie sesión de nuevo.',
  PERMISO_DENEGADO: 'No tiene permiso para realizar esta acción.',
  VALIDACION: 'Hay datos incompletos o no válidos. Revise los campos marcados.',
  NO_ENCONTRADO: 'No se encontró el registro solicitado.',
  CONFLICTO:
    'Este registro cambió en el servidor mientras usted trabajaba. Revise la versión actual antes de continuar.',
  // No revela si el correo existe ni si la cuenta está bloqueada (docs/spec.md §5).
  CREDENCIALES_INVALIDAS:
    'Correo o contraseña incorrectos, o la cuenta está bloqueada temporalmente. Intente de nuevo en unos minutos.',
  // Para uso administrativo. En el login el Worker responde CREDENCIALES_INVALIDAS.
  CUENTA_BLOQUEADA:
    'La cuenta está bloqueada temporalmente por intentos fallidos. Intente de nuevo en unos minutos.',
  DEMASIADOS_INTENTOS: 'Demasiados intentos seguidos. Espere un momento e intente de nuevo.',
  ORIGEN_INVALIDO: 'La solicitud no viene de la aplicación autorizada.',
  TOKEN_INVALIDO: 'Su sesión no es válida o ya venció. Inicie sesión de nuevo.',
  SESION_REVOCADA: 'Su sesión fue cerrada por seguridad. Inicie sesión de nuevo.',
  UNIDAD_INCOMPATIBLE:
    'La unidad no se puede convertir a la unidad planeada para este material. Use una unidad equivalente.',
  ORDEN_NO_EN_PROCESO: 'La orden de producción no está en proceso.',
  ESTADO_ORDEN_INVALIDO: 'Esta acción no se puede hacer con la orden en su estado actual.',
  ORDEN_CON_PENDIENTES:
    'La orden tiene consumos pendientes de validar. Valídelos o confirme que desea finalizarla de todas formas.',
  CONSUMO_NO_PENDIENTE: 'El consumo ya fue validado o rechazado y no se puede modificar.',
  AUTOAPROBACION: 'No puede validar un consumo registrado por usted. Debe validarlo otro jefe.',
  REQUIERE_NOVEDAD:
    'Este consumo supera lo planeado más la tolerancia. Falta justificar la novedad antes de validarlo.',
  DEPENDENCIA_RECHAZADA: 'No se aplicó porque el registro del que depende fue rechazado.',
  EVIDENCIA_DESCONOCIDA:
    'El servidor aún no tiene registrada esta foto. Se intentará subir de nuevo más tarde.',
  EVIDENCIA_TIPO_INVALIDO: 'La foto debe ser una imagen JPG, PNG o WEBP.',
  EVIDENCIA_DEMASIADO_GRANDE: 'La foto es demasiado grande. El máximo es 5 MB.',
  EVIDENCIA_YA_SUBIDA: 'Esta foto ya fue subida.',
  CORRECCION_INVALIDA:
    'Solo se puede crear una corrección de un consumo rechazado de la misma orden.',
  MATERIAL_INACTIVO: 'El material está inactivo y no se puede usar.',
  USUARIO_INACTIVO: 'El usuario está inactivo.',
  ID_INVALIDO: 'El identificador del registro no es válido.',
  ID_DUPLICADO: 'Ya existe un registro con este identificador.',
  LOTE_DEMASIADO_GRANDE: 'Se enviaron demasiados registros a la vez. Intente con menos.',
  // /sync/push con un user_id distinto del de la sesión (tablet compartida, ADR 0008 punto 8).
  AUTOR_NO_COINCIDE:
    'Estas mutaciones pertenecen a otro usuario. Inicie sesión con su propio usuario para enviarlas.',
  // /sync/push con una época distinta de la del servidor (restauración, ADR 0009): no se procesa nada.
  EPOCA_CAMBIADA: 'El servidor fue restaurado. Se están sincronizando de nuevo sus registros.',
  ULTIMO_ADMIN: 'No se puede desactivar ni cambiar el rol del último administrador activo.',
  ERROR_INTERNO: 'Ocurrió un error inesperado en el servidor. Intente de nuevo más tarde.',
};

/** Estado HTTP de cada código. Las reglas de negocio responden 422. */
export const ESTADO_HTTP_POR_CODIGO: Readonly<Record<CodigoError, number>> = {
  NO_AUTENTICADO: 401,
  PERMISO_DENEGADO: 403,
  VALIDACION: 400,
  NO_ENCONTRADO: 404,
  CONFLICTO: 409,
  CREDENCIALES_INVALIDAS: 401,
  CUENTA_BLOQUEADA: 423,
  DEMASIADOS_INTENTOS: 429,
  ORIGEN_INVALIDO: 403,
  TOKEN_INVALIDO: 401,
  SESION_REVOCADA: 401,
  UNIDAD_INCOMPATIBLE: 422,
  ORDEN_NO_EN_PROCESO: 422,
  ESTADO_ORDEN_INVALIDO: 422,
  ORDEN_CON_PENDIENTES: 409,
  CONSUMO_NO_PENDIENTE: 409,
  AUTOAPROBACION: 403,
  REQUIERE_NOVEDAD: 422,
  DEPENDENCIA_RECHAZADA: 422,
  EVIDENCIA_DESCONOCIDA: 404,
  EVIDENCIA_TIPO_INVALIDO: 415,
  EVIDENCIA_DEMASIADO_GRANDE: 413,
  EVIDENCIA_YA_SUBIDA: 409,
  CORRECCION_INVALIDA: 422,
  MATERIAL_INACTIVO: 422,
  USUARIO_INACTIVO: 422,
  ID_INVALIDO: 400,
  ID_DUPLICADO: 409,
  LOTE_DEMASIADO_GRANDE: 413,
  AUTOR_NO_COINCIDE: 403,
  EPOCA_CAMBIADA: 409,
  ULTIMO_ADMIN: 422,
  ERROR_INTERNO: 500,
};

/** Cuerpo único de error de la API. */
export interface ApiError {
  code: CodigoError;
  message: string;
  details?: unknown;
}

/** Indica si un valor es un código de error conocido. */
export function esCodigoError(valor: unknown): valor is CodigoError {
  return typeof valor === 'string' && Object.hasOwn(CODIGOS_ERROR, valor);
}

/** Crea el cuerpo de error con el mensaje estándar del código. `details` solo se incluye si se pasa. */
export function crearError(code: CodigoError, details?: unknown): ApiError {
  const error: ApiError = { code, message: MENSAJES_ERROR[code] };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

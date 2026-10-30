// API pública del cliente de autenticación (tarea 3.4). El motor de sync (3.5) usa
// `sesion.obtenerAccessToken()`, `sesion.usuarioDeLaSesion()`, `sesion.suscribir()` y `clienteApi`.
export {
  BASE_API,
  crearClienteApi,
  ErrorApi,
  ErrorRed,
  esErrorDeRed,
  type ClienteApi,
  type OpcionesPeticion,
  type ProveedorSesion,
} from './cliente-api';
export { conCandado, type GestorCandados } from './candado';
export * from './sesion';
export { crearStoreSesion, useSesion, type StoreSesion } from './store';
export {
  BYTES_SAL,
  BYTES_VERIFICADOR,
  ITERACIONES_VERIFICADOR,
  comprobarVerificador,
  crearVerificador,
  derivarVerificador,
  igualesEnTiempoConstante,
  ultimaMedicionDerivacion,
  type MedicionDerivacion,
} from './verificador';

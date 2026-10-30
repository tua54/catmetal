// API pública del cliente de autenticación (tarea 3.4). El motor de sync (3.5) usa
// `sesion.obtenerAccessToken({ esperado })`, `sesion.usuarioDeLaSesion()`, `sesion.suscribir()`,
// `sesion.senalDeSesion()` y `clienteApi`.
export {
  BASE_API,
  crearClienteApi,
  ErrorApi,
  ErrorRed,
  esErrorDeRed,
  type ClienteApi,
  type OpcionesPeticion,
  type ProveedorSesion,
  type TokenEsperado,
} from './cliente-api';
export {
  conCandado,
  DURACION_CANDADO_SYNC_MS,
  NOMBRE_CANDADO_SYNC,
  type GestorCandados,
} from './candado';
export {
  EVENTOS_ACTIVIDAD,
  INTERVALO_AVISO_ACTIVIDAD_MS,
  vigilarInactividad,
  type DocumentoVigilado,
  type OpcionesVigilante,
  type SesionVigilada,
  type Temporizadores,
} from './inactividad';
export * from './sesion';
export { crearStoreSesion, useSesion, type StoreSesion } from './store';
export {
  BYTES_SAL,
  BYTES_VERIFICADOR,
  ITERACIONES_VERIFICADOR,
  MIN_ITERACIONES_VERIFICADOR,
  comprobarVerificador,
  crearVerificador,
  derivarVerificador,
  igualesEnTiempoConstante,
  ultimaMedicionDerivacion,
  type MedicionDerivacion,
  type OpcionesComprobacion,
} from './verificador';

// Componentes base del sistema visual (Tarea 4.1). Ver docs/diseno/README.md y ADR 0011.
export { Aviso, type PropsAviso } from './Aviso';
export { Avatar, type PropsAvatar } from './Avatar';
export { BarraSuperior, type PropsBarraSuperior } from './BarraSuperior';
export { BloqueNovedad, type PropsBloqueNovedad } from './BloqueNovedad';
export { Boton, type PropsBoton } from './Boton';
export { clasesBoton, type TamanoBoton, type VarianteBoton } from './estilos-boton';
export { AreaTexto, Campo, type PropsAreaTexto, type PropsCampo } from './Campo';
export { CapaModal, type PropsCapaModal } from './CapaModal';
export { Chip, type EstadoChip, type PropsChip } from './Chip';
export {
  DialogoConfirmacion,
  type ConfigMotivo,
  type PropsDialogoConfirmacion,
} from './DialogoConfirmacion';
export { EnlaceBoton, type PropsEnlaceBoton } from './EnlaceBoton';
export { EstadoVacio, type PropsEstadoVacio } from './EstadoVacio';
export {
  ErrorCarga,
  TextoCargando,
  type PropsErrorCarga,
  type PropsTextoCargando,
} from './EstadosCarga';
export { Interruptor, type PropsInterruptor } from './Interruptor';
export {
  LineaTiempo,
  type EventoLinea,
  type PropsLineaTiempo,
  type TipoEventoLinea,
} from './LineaTiempo';
export {
  FilaRegistro,
  ListaRegistros,
  type PropsFilaRegistro,
  type PropsListaRegistros,
} from './ListaRegistros';
export { PildoraConexion, type EstadoConexion, type PropsPildoraConexion } from './PildoraConexion';
export { ProveedorAvisos } from './ProveedorAvisos';
export { SelectBuscable, type OpcionBuscable, type PropsSelectBuscable } from './SelectBuscable';
export { SelectCorto, type OpcionSelectCorto, type PropsSelectCorto } from './SelectCorto';
export { Tarjeta, type PropsTarjeta } from './Tarjeta';
export { VisorImagen, type PropsVisorImagen } from './VisorImagen';
export { useAvisos } from './useAvisos';
export {
  DURACION_AVISO_MS,
  DURACION_MINIMA_AVISO_MS,
  type ApiAvisos,
  type DatosAviso,
  type TonoAviso,
} from './contexto-avisos';
export * from './iconos';

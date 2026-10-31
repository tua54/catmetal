import {
  EnlaceBoton,
  ErrorCarga,
  EstadoVacio,
  LineaTiempo,
  Tarjeta,
  TextoCargando,
  type TipoEventoLinea,
} from '../../components/ui';
import type { EventoTrazabilidad } from '../../datos';

const TIPO_POR_ACCION: Readonly<Record<EventoTrazabilidad['accion'], TipoEventoLinea>> = {
  'consumo.registrado': 'registro',
  'consumo.editado': 'registro',
  'consumo.registrado_con_novedad': 'novedad',
  'novedad.registrada': 'novedad',
  'consumo.aprobado': 'validacion',
  'consumo.rechazado': 'rechazo',
  'sync.completada': 'sistema',
};

export interface PropsTrazabilidadDispositivo {
  eventos: readonly EventoTrazabilidad[] | undefined;
  /** Error al leer la trazabilidad de IndexedDB (`undefined` = sin error). */
  error?: unknown;
  alReintentar?: () => void;
}

/** "Trazabilidad — este dispositivo": "10:24 a. m. · Juan S. registró consumo + novedad". */
export function TrazabilidadDispositivo({
  eventos,
  error,
  alReintentar,
}: PropsTrazabilidadDispositivo) {
  return (
    <Tarjeta titulo="Trazabilidad — este dispositivo">
      {error !== undefined ? (
        <ErrorCarga
          titulo="No se pudo leer la trazabilidad de esta tablet"
          alReintentar={alReintentar}
        >
          Sus registros no se han borrado.
        </ErrorCarga>
      ) : eventos === undefined ? (
        <TextoCargando texto="Cargando trazabilidad…" />
      ) : eventos.length === 0 ? (
        <EstadoVacio
          titulo="Sin actividad en esta tablet"
          texto="Aquí aparecerá lo que se registre y se sincronice desde esta tablet."
          accion={<EnlaceBoton to="/sincronizacion">Ir a sincronización</EnlaceBoton>}
        />
      ) : (
        <LineaTiempo
          etiqueta="Trazabilidad de este dispositivo"
          variante="compacta"
          eventos={eventos.map((evento) => ({
            id: evento.id,
            fechaHora: evento.ts,
            actor: evento.actor_nombre,
            descripcion: evento.descripcion,
            tipo: TIPO_POR_ACCION[evento.accion] ?? 'sistema',
          }))}
        />
      )}
    </Tarjeta>
  );
}

import { EstadoVacio, LineaTiempo, Tarjeta, type TipoEventoLinea } from '../../components/ui';
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

/** "Trazabilidad — este dispositivo": "10:24 a. m. · Juan S. registró consumo + novedad". */
export function TrazabilidadDispositivo({
  eventos,
}: {
  eventos: readonly EventoTrazabilidad[] | undefined;
}) {
  return (
    <Tarjeta titulo="Trazabilidad — este dispositivo">
      {eventos === undefined ? (
        <p className="text-ink-500">Cargando…</p>
      ) : eventos.length === 0 ? (
        <EstadoVacio titulo="Sin actividad en esta tablet" />
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

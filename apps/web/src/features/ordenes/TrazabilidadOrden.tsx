import type { LineaTiempoOrden } from '@catmetal/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSesion } from '../../auth';
import {
  Boton,
  ErrorCarga,
  EstadoVacio,
  IconoSinConexion,
  LineaTiempo,
  Tarjeta,
  TextoCargando,
} from '../../components/ui';
import { CLAVES_JEFE } from '../validacion/api';
import { mensajeDeError, reintentarConsulta } from '../validacion/mensajes';
import { obtenerLineaTiempo } from './api';
import { aEventoLinea, ETIQUETA_TRAZABILIDAD } from './linea-tiempo';

/** "Trazabilidad completa de la orden" (Figma, columna derecha abajo): `GET /orders/:id/audit`. */
export function TrazabilidadOrden({ orderId }: { orderId: string | null }) {
  const enLinea = useSesion((estado) => estado.modo === 'online');
  const consulta = useInfiniteQuery({
    retry: reintentarConsulta,
    queryKey: CLAVES_JEFE.lineaTiempo(orderId ?? ''),
    queryFn: ({ pageParam, signal }) => obtenerLineaTiempo(orderId ?? '', pageParam, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (ultima: LineaTiempoOrden) => ultima.siguiente_cursor,
    enabled: orderId !== null && enLinea,
  });
  const eventos = consulta.data?.pages.flatMap((pagina) => pagina.eventos) ?? [];
  const codigo = consulta.data?.pages[0]?.codigo;

  return (
    <Tarjeta titulo={ETIQUETA_TRAZABILIDAD}>
      {orderId === null ? (
        <EstadoVacio
          titulo="Sin orden seleccionada"
          texto="Elija un consumo o filtre por orden para ver su trazabilidad."
        />
      ) : consulta.data === undefined ? (
        !enLinea ? (
          <EstadoVacio
            icono={<IconoSinConexion className="size-7" />}
            titulo="Sin conexión"
            texto="La auditoría está en el servidor. La trazabilidad aparecerá cuando vuelva la conexión."
          />
        ) : consulta.isError ? (
          <ErrorCarga
            titulo="No se pudo cargar la trazabilidad"
            alReintentar={() => void consulta.refetch()}
          >
            {mensajeDeError(consulta.error)}
          </ErrorCarga>
        ) : (
          <TextoCargando texto="Cargando trazabilidad…" />
        )
      ) : eventos.length === 0 ? (
        <EstadoVacio
          titulo="Sin eventos registrados"
          texto="Los cambios de la orden y de sus consumos aparecerán aquí."
          accion={
            enLinea ? (
              <Boton
                variante="secundario"
                cargando={consulta.isFetching}
                textoCargando="Actualizando…"
                onClick={() => void consulta.refetch()}
              >
                Actualizar
              </Boton>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {codigo !== undefined && (
            <p className="text-[0.9375rem] text-ink-700">
              Orden {codigo}, del evento más antiguo al más reciente.
            </p>
          )}
          <LineaTiempo
            etiqueta={ETIQUETA_TRAZABILIDAD}
            eventos={eventos.map((evento) => aEventoLinea(evento))}
          />
          {consulta.hasNextPage && (
            <Boton
              variante="secundario"
              cargando={consulta.isFetchingNextPage}
              textoCargando="Cargando más eventos…"
              onClick={() => void consulta.fetchNextPage()}
            >
              Cargar más
            </Boton>
          )}
          {consulta.isError && (
            <p role="alert" className="text-sm text-danger-700">
              {mensajeDeError(consulta.error)}
            </p>
          )}
        </div>
      )}
    </Tarjeta>
  );
}

import {
  ESTADOS_ORDEN,
  formatearFechaHora,
  type EstadoOrden as TipoEstadoOrden,
  type ListaOrdenes,
} from '@catmetal/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useSesion } from '../../../auth';
import {
  Aviso,
  Boton,
  EnlaceBoton,
  EstadoVacio,
  SelectCorto,
  Tarjeta,
  TextoCargando,
} from '../../../components/ui';
import { listarOrdenes } from '../../../features/ordenes/api';
import { EstadoOrden } from '../../../features/ordenes/EstadoOrden';
import { NOMBRE_ESTADO_ORDEN } from '../../../features/ordenes/estado-orden';
import { CLAVES_JEFE } from '../../../features/validacion/api';
import { mensajeDeError, reintentarConsulta } from '../../../features/validacion/mensajes';

const CLASE_ENLACE =
  'inline-flex min-h-11 items-center font-semibold text-brand-600 underline underline-offset-4';
const CLASE_ENLACE_PRIMARIO =
  'inline-flex min-h-12 items-center justify-center rounded-lg bg-brand-600 px-5 text-base font-semibold text-white active:bg-brand-700';

function estadoDe(valor: string | null): TipoEstadoOrden | null {
  return valor !== null && (ESTADOS_ORDEN as readonly string[]).includes(valor)
    ? (valor as TipoEstadoOrden)
    : null;
}

/** `/jefe/ordenes`: gestión de órdenes de producción (lista con filtro por estado y cursor). */
export function OrdenesPage() {
  const [parametros, setParametros] = useSearchParams();
  const estado = estadoDe(parametros.get('estado'));
  const enLinea = useSesion((s) => s.modo === 'online');
  const consulta = useInfiniteQuery({
    retry: reintentarConsulta,
    queryKey: CLAVES_JEFE.ordenesCon(estado),
    queryFn: ({ pageParam, signal }) => listarOrdenes(estado, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (ultima: ListaOrdenes) => ultima.siguiente_cursor,
    enabled: enLinea,
  });
  const ordenes = consulta.data?.pages.flatMap((pagina) => pagina.ordenes);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/jefe" className={CLASE_ENLACE}>
            ← Validación de consumos
          </Link>
          <h1 className="mt-2 text-2xl font-bold text-ink-950">Órdenes de producción</h1>
        </div>
        <Link to="nueva" className={CLASE_ENLACE_PRIMARIO}>
          Nueva orden
        </Link>
      </div>

      <Tarjeta titulo="Órdenes" acento>
        <div className="flex flex-col gap-5">
          <SelectCorto
            className="max-w-xs"
            etiqueta="Estado"
            textoVacio="Todos los estados"
            opciones={ESTADOS_ORDEN.map((e) => ({ valor: e, etiqueta: NOMBRE_ESTADO_ORDEN[e] }))}
            value={estado ?? ''}
            onChange={(evento) => {
              const valor = evento.target.value;
              setParametros(valor === '' ? {} : { estado: valor }, { replace: true });
            }}
          />

          {!enLinea && ordenes === undefined && (
            <Aviso tono="advertencia" titulo="Sin conexión">
              La gestión de órdenes se hace con el servidor. Vuelva a intentarlo cuando haya
              conexión.
            </Aviso>
          )}
          {consulta.isError && (
            <Aviso
              tono="error"
              titulo="No se pudieron cargar las órdenes"
              accion={
                <Boton variante="secundario" onClick={() => void consulta.refetch()}>
                  Reintentar
                </Boton>
              }
            >
              {mensajeDeError(consulta.error)}
            </Aviso>
          )}
          {enLinea && consulta.isPending && <TextoCargando texto="Cargando órdenes…" />}
          {ordenes !== undefined && ordenes.length === 0 && (
            <EstadoVacio
              titulo="No hay órdenes"
              texto={
                estado === null
                  ? 'Todavía no hay órdenes de producción. Cree la primera para planear sus materiales.'
                  : `No hay órdenes en estado "${NOMBRE_ESTADO_ORDEN[estado]}".`
              }
              accion={
                estado === null ? (
                  <EnlaceBoton to="nueva" variante="primario">
                    Crear una orden
                  </EnlaceBoton>
                ) : (
                  <Boton variante="secundario" onClick={() => setParametros({}, { replace: true })}>
                    Ver todos los estados
                  </Boton>
                )
              }
            />
          )}
          {ordenes !== undefined && ordenes.length > 0 && (
            <ul
              aria-label="Órdenes de producción"
              className="flex flex-col divide-y divide-line-200"
            >
              {ordenes.map((orden) => (
                <li
                  key={orden.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      to={orden.id}
                      className="inline-flex min-h-11 items-center text-lg font-semibold text-brand-600 underline underline-offset-4"
                    >
                      Orden {orden.codigo}
                    </Link>
                    <p className="cifras text-[0.9375rem] text-ink-700">
                      Línea {orden.linea}
                      {orden.fecha_inicio !== null &&
                        ` · Inició ${formatearFechaHora(orden.fecha_inicio)}`}
                      {orden.fecha_fin !== null &&
                        ` · Finalizó ${formatearFechaHora(orden.fecha_fin)}`}
                    </p>
                  </div>
                  <EstadoOrden estado={orden.estado} />
                </li>
              ))}
            </ul>
          )}
          {consulta.hasNextPage && (
            <Boton
              variante="secundario"
              cargando={consulta.isFetchingNextPage}
              textoCargando="Cargando más órdenes…"
              onClick={() => void consulta.fetchNextPage()}
            >
              Cargar más órdenes
            </Boton>
          )}
        </div>
      </Tarjeta>
    </div>
  );
}

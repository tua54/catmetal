import { formatearCantidad, formatearCOP, type ResumenOrden } from '@catmetal/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSesion } from '../../auth';
import { Aviso, EstadoVacio, Tarjeta } from '../../components/ui';
import { cx } from '../../components/ui/clases';
import { CLAVES_JEFE } from '../validacion/api';
import { mensajeDeError, reintentarConsulta } from '../validacion/mensajes';
import { obtenerResumenOrden } from './api';
import { nombreEstadoOrden } from './estado-orden';

export interface PropsResumenOrdenTarjeta {
  /** Orden a resumir; `null` = no hay orden seleccionada. */
  orderId: string | null;
  /** Contenido extra al pie (p. ej. el enlace a la gestión de la orden). */
  pie?: ReactNode;
}

function Par({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-200 py-2.5 last:border-b-0">
      <dt className="text-[0.9375rem] text-ink-700">{etiqueta}</dt>
      <dd className="cifras text-right font-semibold text-ink-950">{children}</dd>
    </div>
  );
}

function TextoNovedades({ resumen }: { resumen: ResumenOrden }) {
  const { novedades_abiertas: abiertas, novedades_faltantes: faltantes } = resumen.totales;
  if (abiertas === 0) {
    return <>0</>;
  }
  return (
    <span className="inline-flex items-center rounded-full border border-warning-500 bg-warning-100 px-3 py-0.5 text-warning-800">
      {abiertas}
      {faltantes > 0 && ` (${faltantes} por sustentar)`}
    </span>
  );
}

/** Tabla "Planeado vs consumido" del resumen (con los costos congelados, S12). */
function TablaMateriales({ resumen }: { resumen: ResumenOrden }) {
  const filas = resumen.materiales.length + resumen.materiales_fuera_de_plan.length;
  if (filas === 0) {
    return null;
  }
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="cifras w-full min-w-[28rem] border-collapse text-left text-[0.9375rem]">
        <caption className="pb-2 text-left font-semibold text-ink-950">
          Planeado vs consumido
        </caption>
        <thead>
          <tr className="bg-navy-800 text-white">
            <th scope="col" className="px-3 py-2 font-semibold">
              Material
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Planeado
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Consumido
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Costo
            </th>
          </tr>
        </thead>
        <tbody>
          {resumen.materiales.map((m) => (
            <tr key={m.material_id} className="border-b border-line-200">
              <th scope="row" className="px-3 py-2 font-normal text-ink-950">
                {m.nombre}
                {m.excede_tolerancia && (
                  <span className="block text-sm font-semibold text-danger-700">
                    Supera la tolerancia
                  </span>
                )}
              </th>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {formatearCantidad(m.cantidad_planeada)} {m.unidad}
              </td>
              <td
                className={cx(
                  'px-3 py-2 text-right whitespace-nowrap',
                  m.excede_tolerancia && 'font-semibold text-danger-700',
                )}
              >
                {formatearCantidad(m.consumido)} {m.unidad} ({formatearCantidad(m.porcentaje)} %)
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {formatearCOP(m.costo_cop)}
              </td>
            </tr>
          ))}
          {resumen.materiales_fuera_de_plan.map((m) => (
            <tr key={m.material_id} className="border-b border-line-200">
              <th scope="row" className="px-3 py-2 font-normal text-ink-950">
                {m.nombre}
                <span className="block text-sm font-semibold text-warning-800">Fuera del plan</span>
              </th>
              <td className="px-3 py-2 text-right">—</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {formatearCantidad(m.consumido)} {m.unidad}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {formatearCOP(m.costo_cop)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Resumen de la orden" (Figma, columna derecha arriba): `GET /reports/orders/:id/summary`. */
export function ResumenOrdenTarjeta({ orderId, pie }: PropsResumenOrdenTarjeta) {
  const enLinea = useSesion((estado) => estado.modo === 'online');
  const consulta = useQuery({
    retry: reintentarConsulta,
    queryKey: CLAVES_JEFE.resumen(orderId ?? ''),
    queryFn: ({ signal }) => obtenerResumenOrden(orderId ?? '', signal),
    enabled: orderId !== null && enLinea,
  });
  const resumen = consulta.data;

  return (
    <Tarjeta titulo="Resumen de la orden" pie={pie}>
      {orderId === null ? (
        <EstadoVacio
          titulo="Sin orden seleccionada"
          texto="Elija un consumo o filtre por orden para ver su resumen."
        />
      ) : resumen === undefined ? (
        consulta.isError || !enLinea ? (
          <Aviso tono="advertencia" titulo="No se pudo cargar el resumen">
            {consulta.isError
              ? mensajeDeError(consulta.error)
              : 'El resumen se calcula en el servidor y no hay conexión.'}
          </Aviso>
        ) : (
          <p role="status" className="text-ink-500">
            Cargando resumen…
          </p>
        )
      ) : (
        <>
          <dl>
            <Par etiqueta="Orden">
              {resumen.codigo} · {resumen.linea}
            </Par>
            <Par etiqueta="Materiales consumidos">
              {resumen.totales.materiales_consumidos === 1
                ? '1 registro'
                : `${resumen.totales.materiales_consumidos} registros`}
            </Par>
            <Par etiqueta="Costo total reportado">
              <span className="whitespace-nowrap">
                {formatearCOP(resumen.totales.costo_total_cop)}
              </span>
            </Par>
            <Par etiqueta="Novedades abiertas">
              <TextoNovedades resumen={resumen} />
            </Par>
            <Par etiqueta="Estado de la orden">{nombreEstadoOrden(resumen.estado)}</Par>
          </dl>
          <TablaMateriales resumen={resumen} />
          {consulta.isError && (
            <p className="mt-3 text-sm text-ink-700">
              Se muestra el último resumen cargado: {mensajeDeError(consulta.error)}
            </p>
          )}
        </>
      )}
    </Tarjeta>
  );
}

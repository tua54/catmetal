import { formatearFechaHora } from '@catmetal/shared';
import { useCallback } from 'react';
import { Link } from 'react-router';
import { useConsultaLocal } from '../../app/useConsultaLocal';
import { useSesion } from '../../auth';
import { EstadoVacio, Tarjeta } from '../../components/ui';
import { BarraProgreso } from '../../features/consumos/BarraProgreso';
import { misOrdenes } from '../../features/consumos/consultas';

const CLASE_ENLACE_PRIMARIO =
  'inline-flex min-h-14 items-center justify-center rounded-lg bg-brand-600 px-5 text-lg font-semibold text-white active:bg-brand-700';
const CLASE_ENLACE_SECUNDARIO =
  'inline-flex min-h-14 items-center justify-center rounded-lg border border-ink-400 bg-white px-5 text-lg font-semibold text-ink-700 active:bg-surface-200';

/** `/supervisor`: órdenes en proceso asignadas al supervisor, con su avance según esta tablet. */
export function MisOrdenesPage() {
  const userId = useSesion((estado) => estado.usuario?.id ?? null);
  const consulta = useCallback(
    () => (userId === null ? Promise.resolve([]) : misOrdenes(userId)),
    [userId],
  );
  const { datos: ordenes, error } = useConsultaLocal(consulta);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-ink-950">Mis órdenes en proceso</h1>

      {error !== undefined && (
        <p role="alert" className="text-danger-700">
          No se pudieron leer las órdenes guardadas en esta tablet.
        </p>
      )}
      {ordenes === undefined && error === undefined && (
        <p role="status" className="text-ink-500">
          Cargando órdenes…
        </p>
      )}
      {ordenes !== undefined && ordenes.length === 0 && (
        <Tarjeta>
          <EstadoVacio
            nivelTitulo={2}
            titulo="No tiene órdenes en proceso asignadas"
            texto="Cuando el jefe le asigne una orden y la inicie, aparecerá aquí. Si acaba de pasar, sincronice para traer los cambios."
            accion={
              <Link to="/sincronizacion" className={CLASE_ENLACE_SECUNDARIO}>
                Ir a sincronización
              </Link>
            }
          />
        </Tarjeta>
      )}
      {ordenes !== undefined && ordenes.length > 0 && (
        <ul aria-label="Órdenes en proceso" className="grid gap-6 md:grid-cols-2">
          {ordenes.map(({ orden, porcentaje, materialesExcedidos, avance }) => (
            <li key={orden.id}>
              <Tarjeta
                titulo={`Orden ${orden.codigo}`}
                acento
                pie={
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Link
                      to={`ordenes/${orden.id}/registrar`}
                      className={CLASE_ENLACE_PRIMARIO}
                      aria-label={`Registrar consumo en la orden ${orden.codigo}`}
                    >
                      Registrar consumo
                    </Link>
                    <Link
                      to={`ordenes/${orden.id}`}
                      className={CLASE_ENLACE_SECUNDARIO}
                      aria-label={`Ver detalle de la orden ${orden.codigo}`}
                    >
                      Ver detalle
                    </Link>
                  </div>
                }
              >
                <p className="text-base text-ink-700">Línea {orden.linea}</p>
                {orden.fecha_inicio && (
                  <p className="cifras text-[0.9375rem] text-ink-500">
                    Inició: {formatearFechaHora(orden.fecha_inicio)}
                  </p>
                )}
                <BarraProgreso
                  className="mt-4"
                  etiqueta={`Avance de la orden ${orden.codigo}`}
                  porcentaje={porcentaje}
                  texto={
                    avance.materiales.length === 0
                      ? 'Sin materiales planeados en esta tablet'
                      : `Avance promedio del plan: ${porcentaje} % (${avance.materiales.length} materiales)`
                  }
                  excede={materialesExcedidos > 0}
                />
                {materialesExcedidos > 0 && (
                  <p className="mt-2 text-[0.9375rem] font-semibold text-danger-700">
                    {materialesExcedidos === 1
                      ? '1 material supera la tolerancia'
                      : `${materialesExcedidos} materiales superan la tolerancia`}
                  </p>
                )}
              </Tarjeta>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

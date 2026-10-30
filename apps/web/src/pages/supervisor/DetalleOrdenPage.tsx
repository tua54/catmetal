import { formatearCantidad } from '@catmetal/shared';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router';
import { useSubtituloBarra } from '../../app/encabezado';
import { useConsultaLocal } from '../../app/useConsultaLocal';
import { useSesion } from '../../auth';
import { Aviso, EstadoVacio, Tarjeta } from '../../components/ui';
import { BarraProgreso } from '../../features/consumos/BarraProgreso';
import { datosDeOrden } from '../../features/consumos/consultas';

const NOMBRE_ESTADO_ORDEN: Readonly<Record<string, string>> = {
  borrador: 'Borrador',
  en_proceso: 'En proceso',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

const CLASE_ENLACE_PRIMARIO =
  'inline-flex min-h-14 w-full items-center justify-center rounded-lg bg-brand-600 px-5 text-lg font-semibold text-white active:bg-brand-700';

/** `/supervisor/ordenes/:id`: planeado vs consumido por material (cálculo de esta tablet). */
export function DetalleOrdenPage() {
  const { id = '' } = useParams();
  const userId = useSesion((estado) => estado.usuario?.id ?? null);
  const consulta = useCallback(
    () => (userId === null ? Promise.resolve(null) : datosDeOrden(userId, id)),
    [userId, id],
  );
  const { datos } = useConsultaLocal(consulta);
  const orden = datos?.orden ?? null;
  useSubtituloBarra(orden ? `Orden ${orden.codigo} · Línea ${orden.linea}` : null);

  if (datos === undefined || datos === null) {
    return (
      <p role="status" className="text-ink-500">
        Cargando orden…
      </p>
    );
  }
  if (orden === null) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-ink-950">Orden no disponible</h1>
        <Tarjeta>
          <EstadoVacio
            nivelTitulo={2}
            titulo="La orden no está en esta tablet"
            texto="Puede que no esté asignada a usted o que aún no se haya sincronizado."
            accion={
              <Link to="/supervisor" className="font-semibold text-brand-600 underline">
                Volver a mis órdenes
              </Link>
            }
          />
        </Tarjeta>
      </div>
    );
  }

  const { avance, materiales } = datos;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/supervisor"
          className="inline-flex min-h-11 items-center font-semibold text-brand-600 underline-offset-4 active:underline"
        >
          ← Mis órdenes
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-ink-950">Orden {orden.codigo}</h1>
        <p className="text-ink-700">
          Línea {orden.linea} · {NOMBRE_ESTADO_ORDEN[orden.estado] ?? orden.estado}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Tarjeta titulo="Planeado vs consumido" acento>
          <Aviso tono="info" titulo="Cálculo con los registros de esta tablet" className="mb-5">
            El servidor confirma la tolerancia con los registros de todos los supervisores.
          </Aviso>
          {avance.materiales.length === 0 ? (
            <EstadoVacio titulo="La orden no tiene materiales planeados en esta tablet" />
          ) : (
            <ul aria-label="Materiales planeados" className="flex flex-col gap-5">
              {avance.materiales.map((m) => {
                const nombre = m.nombre ?? 'Material sin catálogo local';
                return (
                  <li key={m.material_id}>
                    <p className="font-semibold text-ink-950">
                      {nombre}
                      {m.codigo && (
                        <span className="cifras ml-2 font-normal text-ink-500">{m.codigo}</span>
                      )}
                    </p>
                    <BarraProgreso
                      className="mt-2"
                      etiqueta={nombre}
                      porcentaje={m.porcentaje}
                      excede={m.excede_tolerancia}
                      texto={`${formatearCantidad(m.consumido)} ${m.unidad} de ${formatearCantidad(m.cantidad_planeada)} ${m.unidad} (${formatearCantidad(m.porcentaje)} %)`}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {avance.incompatibles > 0 && (
            <p className="mt-4 text-[0.9375rem] text-ink-700">
              {avance.incompatibles === 1
                ? '1 registro tiene una unidad que no se puede comparar con el plan.'
                : `${avance.incompatibles} registros tienen una unidad que no se puede comparar con el plan.`}
            </p>
          )}
        </Tarjeta>

        <div className="flex flex-col gap-6">
          <Link
            to="registrar"
            className={CLASE_ENLACE_PRIMARIO}
            aria-label={`Registrar consumo en la orden ${orden.codigo}`}
          >
            Registrar consumo
          </Link>
          {avance.fuera_de_plan.length > 0 && (
            <Tarjeta titulo="Fuera del plan">
              <p className="text-ink-700">
                Materiales usados que no están en el plan: cada consumo necesita una novedad.
              </p>
              <ul aria-label="Materiales fuera del plan" className="mt-3 flex flex-col gap-2">
                {avance.fuera_de_plan.map((m) => (
                  <li key={m.material_id} className="cifras flex justify-between gap-3">
                    <span>{m.nombre ?? materiales.get(m.material_id)?.nombre ?? 'Material'}</span>
                    <span className="font-semibold text-ink-950">
                      {formatearCantidad(m.consumido)} {m.unidad}
                    </span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          )}
        </div>
      </div>
    </div>
  );
}

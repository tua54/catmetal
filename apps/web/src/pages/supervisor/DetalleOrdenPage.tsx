import { formatearCantidad } from '@catmetal/shared';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router';
import { useSubtituloBarra } from '../../app/encabezado';
import { useConsultaLocal } from '../../app/useConsultaLocal';
import { useSesion } from '../../auth';
import {
  Aviso,
  EnlaceBoton,
  ErrorCarga,
  EstadoVacio,
  Tarjeta,
  TextoCargando,
} from '../../components/ui';
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
  const { datos, error, reintentar } = useConsultaLocal(consulta);
  const orden = datos?.orden ?? null;
  useSubtituloBarra(orden ? `Orden ${orden.codigo} · Línea ${orden.linea}` : null);

  const hayDatos = datos !== undefined && datos !== null;
  // El encabezado es el mismo elemento en todos los estados: el foco que la navegación puso en el
  // `<h1>` no se pierde cuando llegan los datos.
  const encabezado = (
    <div>
      <Link
        to="/supervisor"
        className="inline-flex min-h-11 items-center font-semibold text-brand-600 underline-offset-4 active:underline"
      >
        ← Mis órdenes
      </Link>
      <h1 className="mt-2 text-2xl font-bold text-ink-950">
        {orden !== null
          ? `Orden ${orden.codigo}`
          : hayDatos
            ? 'Orden no disponible'
            : 'Detalle de orden'}
      </h1>
      {orden !== null && (
        <p className="text-ink-700">
          Línea {orden.linea} · {NOMBRE_ESTADO_ORDEN[orden.estado] ?? orden.estado}
        </p>
      )}
    </div>
  );

  if (!hayDatos) {
    return (
      <div className="flex flex-col gap-6">
        {encabezado}
        {error !== undefined ? (
          <ErrorCarga
            titulo="No se pudo leer la orden guardada en esta tablet"
            alReintentar={reintentar}
          >
            Sus registros no se han borrado. Si el problema sigue, cierre y vuelva a abrir la
            aplicación.
          </ErrorCarga>
        ) : (
          <TextoCargando texto="Cargando orden…" />
        )}
      </div>
    );
  }
  if (orden === null) {
    return (
      <div className="flex flex-col gap-6">
        {encabezado}
        <Tarjeta>
          <EstadoVacio
            nivelTitulo={2}
            titulo="La orden no está en esta tablet"
            texto="Puede que no esté asignada a usted o que aún no se haya sincronizado. Si acaba de pasar, sincronice para traer los cambios."
            accion={
              <div className="flex flex-wrap justify-center gap-3">
                <EnlaceBoton to="/supervisor" variante="primario">
                  Volver a mis órdenes
                </EnlaceBoton>
                <EnlaceBoton to="/sincronizacion">Ir a sincronización</EnlaceBoton>
              </div>
            }
          />
        </Tarjeta>
      </div>
    );
  }

  const { avance, materiales } = datos;
  return (
    <div className="flex flex-col gap-6">
      {encabezado}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Tarjeta titulo="Planeado vs consumido" acento>
          <Aviso tono="info" titulo="Cálculo con los registros de esta tablet" className="mb-5">
            El servidor confirma la tolerancia con los registros de todos los supervisores.
          </Aviso>
          {avance.materiales.length === 0 ? (
            <EstadoVacio
              titulo="La orden no tiene materiales planeados en esta tablet"
              texto="Si el jefe acaba de cambiar el plan, sincronice para traerlo."
              accion={<EnlaceBoton to="/sincronizacion">Ir a sincronización</EnlaceBoton>}
            />
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

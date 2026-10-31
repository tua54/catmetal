import {
  esUuidV7,
  formatearCantidad,
  formatearFechaHora,
  type DetalleOrden,
} from '@catmetal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useSubtituloBarra } from '../../../app/encabezado';
import { ErrorApi, useSesion } from '../../../auth';
import {
  Aviso,
  Boton,
  DialogoConfirmacion,
  EstadoVacio,
  Tarjeta,
  TextoCargando,
  useAvisos,
} from '../../../components/ui';
import { BarraProgreso } from '../../../features/consumos/BarraProgreso';
import {
  exportarCsv,
  finalizarOrden,
  iniciarOrden,
  obtenerDetalleOrden,
} from '../../../features/ordenes/api';
import { EstadoOrden } from '../../../features/ordenes/EstadoOrden';
import { ResumenOrdenTarjeta } from '../../../features/ordenes/ResumenOrdenTarjeta';
import { TrazabilidadOrden } from '../../../features/ordenes/TrazabilidadOrden';
import { CLAVES_JEFE } from '../../../features/validacion/api';
import {
  mensajeDeError,
  pendientesDeError,
  reintentarConsulta,
  textoPendientes,
} from '../../../features/validacion/mensajes';
import { NotFoundPage } from '../../NotFoundPage';

const CLASE_ENLACE =
  'inline-flex min-h-11 items-center font-semibold text-brand-600 underline underline-offset-4';

type Accion = 'iniciar' | 'finalizar' | 'forzar';

function PlanVsConsumo({ orden }: { orden: DetalleOrden }) {
  return (
    <Tarjeta titulo="Planeado vs consumido" acento>
      {orden.materiales.length === 0 ? (
        <EstadoVacio titulo="La orden no tiene materiales planeados" />
      ) : (
        <ul aria-label="Materiales planeados" className="flex flex-col gap-5">
          {orden.materiales.map((m) => (
            <li key={m.material_id}>
              <p className="font-semibold text-ink-950">
                {m.nombre}
                <span className="cifras ml-2 font-normal text-ink-500">{m.codigo}</span>
              </p>
              <BarraProgreso
                className="mt-2"
                etiqueta={m.nombre}
                porcentaje={m.porcentaje}
                excede={m.excede_tolerancia}
                texto={`${formatearCantidad(m.consumido)} ${m.unidad} de ${formatearCantidad(m.cantidad_planeada)} ${m.unidad} (${formatearCantidad(m.porcentaje)} %)`}
              />
            </li>
          ))}
        </ul>
      )}
      {orden.materiales_fuera_de_plan.length > 0 && (
        <div className="mt-5">
          <h3 className="font-semibold text-ink-950">Fuera del plan</h3>
          <ul aria-label="Materiales fuera del plan" className="mt-2 flex flex-col gap-2">
            {orden.materiales_fuera_de_plan.map((m) => (
              <li key={m.material_id} className="cifras flex justify-between gap-3">
                <span>{m.nombre}</span>
                <span className="font-semibold text-ink-950">
                  {formatearCantidad(m.consumido)} {m.unidad}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-5 text-[0.9375rem] text-ink-700">
        Tolerancia vigente: {formatearCantidad(orden.tolerancia_pct)} %. Cuenta los consumos
        pendientes y aprobados.
      </p>
    </Tarjeta>
  );
}

/**
 * `/jefe/ordenes/:id`: plan vs consumo, iniciar, finalizar (con `force` explícito), CSV y auditoría.
 * F6-05: un id que no es UUID v7 no llega a la API (se muestra "no encontrada").
 */
export function DetalleOrdenJefePage() {
  const { id = '' } = useParams();
  if (!esUuidV7(id)) {
    return <NotFoundPage />;
  }
  return <DetalleOrdenJefe id={id} />;
}

function DetalleOrdenJefe({ id }: { id: string }) {
  const enLinea = useSesion((s) => s.modo === 'online');
  const clienteQuery = useQueryClient();
  const avisos = useAvisos();
  const [dialogo, setDialogo] = useState<Accion | null>(null);
  const [pendientes, setPendientes] = useState<number | null>(null);
  const [exportando, setExportando] = useState(false);

  const consulta = useQuery({
    retry: reintentarConsulta,
    queryKey: CLAVES_JEFE.orden(id),
    queryFn: ({ signal }) => obtenerDetalleOrden(id, signal),
    enabled: enLinea,
  });
  const orden = consulta.data;
  useSubtituloBarra(orden ? `Orden ${orden.codigo} · Línea ${orden.linea}` : null);

  function refrescar() {
    void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.ordenes });
    void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.resumen(id) });
    void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.lineaTiempo(id) });
  }

  const accion = useMutation({
    networkMode: 'always',
    mutationFn: (tipo: Accion) =>
      tipo === 'iniciar' ? iniciarOrden(id) : finalizarOrden(id, tipo === 'forzar'),
    onSuccess: (_orden, tipo) => {
      setPendientes(null);
      avisos.mostrar({
        tono: 'exito',
        titulo: tipo === 'iniciar' ? 'Orden iniciada' : 'Orden finalizada',
        mensaje:
          tipo === 'forzar'
            ? 'Se finalizó con consumos pendientes; quedó registrado en la auditoría.'
            : undefined,
      });
      refrescar();
    },
    onError: (error, tipo) => {
      const cantidad = pendientesDeError(error);
      if (tipo === 'finalizar' && cantidad !== null) {
        setPendientes(cantidad);
        return;
      }
      avisos.mostrar({
        tono: 'error',
        titulo:
          tipo === 'iniciar' ? 'No se pudo iniciar la orden' : 'No se pudo finalizar la orden',
        mensaje: mensajeDeError(error),
      });
      if (error instanceof ErrorApi && error.code === 'ESTADO_ORDEN_INVALIDO') {
        refrescar();
      }
    },
    onSettled: () => {
      setDialogo(null);
      void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.orden(id) });
    },
  });

  async function descargarCsv(codigo: string) {
    setExportando(true);
    try {
      await exportarCsv(id, codigo);
    } catch (error) {
      avisos.mostrar({
        tono: 'error',
        titulo: 'No se pudo exportar el CSV',
        mensaje: mensajeDeError(error),
      });
    } finally {
      setExportando(false);
    }
  }

  const volver = (
    <Link to="/jefe/ordenes" className={CLASE_ENLACE}>
      ← Órdenes de producción
    </Link>
  );

  if (orden === undefined) {
    // Misma estructura que el encabezado con datos: el `<h1>` es el mismo elemento y conserva el
    // foco que le puso la navegación cuando llega la orden.
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            {volver}
            <h1 className="mt-2 text-2xl font-bold text-ink-950">Detalle de orden</h1>
          </div>
        </div>
        {consulta.isError ? (
          <Aviso
            tono="error"
            titulo="No se pudo cargar la orden"
            accion={
              <Boton variante="secundario" onClick={() => void consulta.refetch()}>
                Reintentar
              </Boton>
            }
          >
            {mensajeDeError(consulta.error)}
          </Aviso>
        ) : !enLinea ? (
          <Aviso tono="advertencia" titulo="Sin conexión">
            El detalle de la orden se consulta en el servidor. Vuelva a intentarlo con conexión.
          </Aviso>
        ) : (
          <TextoCargando texto="Cargando orden…" />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {volver}
          <h1 className="mt-2 text-2xl font-bold text-ink-950">Orden {orden.codigo}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-ink-700">
            <EstadoOrden estado={orden.estado} />
            <span>Línea {orden.linea}</span>
          </div>
          <p className="cifras mt-1 text-[0.9375rem] text-ink-700">
            {orden.fecha_inicio !== null && `Inició ${formatearFechaHora(orden.fecha_inicio)}`}
            {orden.fecha_fin !== null && ` · Finalizó ${formatearFechaHora(orden.fecha_fin)}`}
          </p>
          <p className="text-[0.9375rem] text-ink-700">
            Supervisores:{' '}
            {orden.supervisores.length === 0
              ? 'sin asignar'
              : orden.supervisores.map((s) => s.nombre).join(', ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {orden.estado === 'planeada' && (
            <Boton tamano="grande" onClick={() => setDialogo('iniciar')}>
              Iniciar orden
            </Boton>
          )}
          {orden.estado === 'en_proceso' && (
            <Boton tamano="grande" variante="peligro" onClick={() => setDialogo('finalizar')}>
              Finalizar orden
            </Boton>
          )}
          <Boton
            tamano="grande"
            variante="secundario"
            cargando={exportando}
            textoCargando="Descargando CSV…"
            onClick={() => void descargarCsv(orden.codigo)}
          >
            Exportar CSV
          </Boton>
        </div>
      </div>

      {pendientes !== null && (
        <Aviso
          tono="advertencia"
          titulo={`La orden tiene ${textoPendientes(pendientes)} de validar`}
          alCerrar={() => setPendientes(null)}
          anunciar
          accion={
            <div className="flex flex-wrap gap-3">
              <Link to={`/jefe?orden=${orden.id}`} className={CLASE_ENLACE}>
                Validar los pendientes
              </Link>
              <Boton variante="peligro" onClick={() => setDialogo('forzar')}>
                Finalizar de todos modos
              </Boton>
            </div>
          }
        >
          Lo recomendable es validarlos o rechazarlos antes de finalizar.
        </Aviso>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <PlanVsConsumo orden={orden} />
          <Link to={`/jefe?orden=${orden.id}`} className={CLASE_ENLACE}>
            Ver consumos por validar de esta orden
          </Link>
        </div>
        <div className="flex flex-col gap-6">
          <ResumenOrdenTarjeta orderId={orden.id} />
          <TrazabilidadOrden orderId={orden.id} />
        </div>
      </div>

      <DialogoConfirmacion
        abierto={dialogo === 'iniciar'}
        titulo="¿Iniciar la orden?"
        descripcion={`La orden ${orden.codigo} pasará a "En proceso" y los supervisores asignados podrán registrar consumos.`}
        textoConfirmar="Iniciar orden"
        cargando={accion.isPending}
        alConfirmar={() => accion.mutate('iniciar')}
        alCancelar={() => setDialogo(null)}
      />
      <DialogoConfirmacion
        abierto={dialogo === 'finalizar'}
        titulo="¿Finalizar la orden?"
        descripcion={`La orden ${orden.codigo} quedará finalizada y no se podrán registrar más consumos en ella.`}
        tono="peligro"
        textoConfirmar="Finalizar orden"
        cargando={accion.isPending}
        alConfirmar={() => accion.mutate('finalizar')}
        alCancelar={() => setDialogo(null)}
      />
      <DialogoConfirmacion
        abierto={dialogo === 'forzar'}
        titulo="¿Finalizar con consumos sin validar?"
        descripcion={`Quedarán ${textoPendientes(pendientes ?? 0)} sin validar en la orden ${orden.codigo}. La finalización forzada queda registrada en la auditoría y no se puede deshacer.`}
        tono="peligro"
        textoConfirmar="Sí, finalizar con pendientes"
        cargando={accion.isPending}
        alConfirmar={() => accion.mutate('forzar')}
        alCancelar={() => setDialogo(null)}
      />
    </div>
  );
}

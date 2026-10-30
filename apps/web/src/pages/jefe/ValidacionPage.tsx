import { esUuidV7, formatearCantidad, formatearHora, type ElementoCola } from '@catmetal/shared';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Aviso,
  Boton,
  Chip,
  DialogoConfirmacion,
  EstadoVacio,
  Tarjeta,
  TextoCargando,
  VisorImagen,
} from '../../components/ui';
import { ResumenOrdenTarjeta } from '../../features/ordenes/ResumenOrdenTarjeta';
import { TrazabilidadOrden } from '../../features/ordenes/TrazabilidadOrden';
import { FILTROS_VACIOS, type FiltrosCola } from '../../features/validacion/api';
import { FiltrosColaValidacion } from '../../features/validacion/FiltrosColaValidacion';
import { mensajeDeError } from '../../features/validacion/mensajes';
import { TarjetaConsumo } from '../../features/validacion/TarjetaConsumo';
import { useColaValidacion } from '../../features/validacion/useColaValidacion';
import { useDecisionConsumo } from '../../features/validacion/useDecision';
import { useVisorEvidencia } from '../../features/validacion/useVisorEvidencia';
import { nombreCorto } from '../../datos';

const CLASE_ENLACE =
  'inline-flex min-h-11 items-center font-semibold text-brand-600 underline underline-offset-4';

type Dialogo = { tipo: 'validar' | 'rechazar'; elemento: ElementoCola } | null;

function uuidDe(valor: string | null): string | null {
  return valor !== null && esUuidV7(valor) ? valor : null;
}

/** Filtros de la URL (`/jefe?orden=…&supervisor=…&con_novedad=true`): se pueden enlazar y recargar. */
function useFiltrosDeUrl(): [FiltrosCola, (filtros: FiltrosCola) => void] {
  const [parametros, setParametros] = useSearchParams();
  const orden = uuidDe(parametros.get('orden'));
  const supervisor = uuidDe(parametros.get('supervisor'));
  const conNovedad = parametros.get('con_novedad') === 'true';
  const filtros = useMemo(
    () => ({ orden, supervisor, conNovedad }),
    [orden, supervisor, conNovedad],
  );
  const cambiar = (nuevos: FiltrosCola) => {
    const siguiente = new URLSearchParams();
    if (nuevos.orden !== null) {
      siguiente.set('orden', nuevos.orden);
    }
    if (nuevos.supervisor !== null) {
      siguiente.set('supervisor', nuevos.supervisor);
    }
    if (nuevos.conNovedad) {
      siguiente.set('con_novedad', 'true');
    }
    setParametros(siguiente, { replace: true });
  };
  return [filtros, cambiar];
}

function descripcionConsumo(elemento: ElementoCola): string {
  return `${formatearCantidad(elemento.cantidad)} ${elemento.unidad} de ${elemento.material.nombre}, registrado por ${nombreCorto(elemento.supervisor.nombre)} en la orden ${elemento.orden.codigo}`;
}

/** `/jefe`: Validación de consumos (Figma "Jefe · Validación de Consumos"). */
export function ValidacionPage() {
  const [filtros, cambiarFiltros] = useFiltrosDeUrl();
  const cola = useColaValidacion(filtros);
  const decision = useDecisionConsumo();
  const visor = useVisorEvidencia();
  const [seleccionId, setSeleccionId] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo>(null);

  const elementos = cola.elementos;
  const seleccionado = elementos?.find((e) => e.id === seleccionId) ?? elementos?.[0] ?? null;
  const orderIdDerecha = filtros.orden ?? seleccionado?.order_id ?? null;
  const codigoFiltrado =
    filtros.orden === null
      ? null
      : (cola.paraOpciones.find((e) => e.order_id === filtros.orden)?.orden.codigo ?? null);
  const enCurso = decision.isPending ? decision.variables.elemento.id : null;
  const hayFiltros = filtros.orden !== null || filtros.supervisor !== null || filtros.conNovedad;

  function confirmar(motivo?: string) {
    if (dialogo === null) {
      return;
    }
    decision.mutate(
      {
        elemento: dialogo.elemento,
        decision: dialogo.tipo === 'validar' ? 'aprobado' : 'rechazado',
        motivo,
      },
      { onSettled: () => setDialogo(null) },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink-950">Validación de consumos</h1>
        <Link to="/jefe/ordenes" className={CLASE_ENLACE}>
          Órdenes de producción
        </Link>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Tarjeta
          titulo={codigoFiltrado !== null ? `Por validar — Orden ${codigoFiltrado}` : 'Por validar'}
          acento
          acciones={
            cola.pendientes !== undefined && <Chip estado="pendientes" cantidad={cola.pendientes} />
          }
        >
          <div className="flex flex-col gap-5">
            <FiltrosColaValidacion
              filtros={filtros}
              elementos={cola.paraOpciones}
              alCambiar={(nuevos) => {
                setSeleccionId(null);
                cambiarFiltros(nuevos);
              }}
            />

            {cola.fuente === 'tablet' && (
              <Aviso tono="advertencia" titulo="Sin conexión: cola guardada en esta tablet">
                Se muestran los consumos pendientes según la última sincronización. Sus decisiones
                se guardan aquí y se envían al servidor cuando vuelva la conexión.
              </Aviso>
            )}
            {cola.fuente === 'servidor' && cola.sinServidor && (
              <Aviso tono="advertencia" titulo="Sin conexión: última cola cargada">
                Datos de las {formatearHora(new Date(cola.actualizadaEn).toISOString())}. Sus
                decisiones se guardan en esta tablet y se envían al servidor cuando vuelva la
                conexión.
              </Aviso>
            )}
            {cola.fuente === null && cola.consulta.isError && (
              <Aviso
                tono="error"
                titulo="No se pudo cargar la cola"
                accion={
                  <Boton variante="secundario" onClick={() => void cola.consulta.refetch()}>
                    Reintentar
                  </Boton>
                }
              >
                {mensajeDeError(cola.consulta.error)}
              </Aviso>
            )}
            {elementos === undefined && !cola.consulta.isError && (
              // Alto reservado para la primera tarjeta de consumo (menos salto al cargar, CLS).
              <div className="min-h-56">
                <TextoCargando texto="Cargando consumos por validar…" />
              </div>
            )}

            {elementos !== undefined && elementos.length === 0 && (
              <EstadoVacio
                titulo="No hay consumos por validar"
                texto={
                  hayFiltros
                    ? 'Ningún consumo pendiente cumple los filtros elegidos.'
                    : 'Cuando un supervisor registre un consumo, aparecerá aquí.'
                }
                accion={
                  hayFiltros ? (
                    <Boton
                      variante="secundario"
                      onClick={() => {
                        setSeleccionId(null);
                        cambiarFiltros(FILTROS_VACIOS);
                      }}
                    >
                      Quitar filtros
                    </Boton>
                  ) : cola.fuente === 'servidor' && !cola.sinServidor ? (
                    <Boton
                      variante="secundario"
                      cargando={cola.consulta.isFetching}
                      textoCargando="Actualizando la cola…"
                      onClick={() => void cola.consulta.refetch()}
                    >
                      Actualizar la cola
                    </Boton>
                  ) : undefined
                }
              />
            )}
            {elementos !== undefined && elementos.length > 0 && (
              <ul aria-label="Consumos por validar" className="flex flex-col gap-4">
                {elementos.map((elemento) => (
                  <li key={elemento.id}>
                    <TarjetaConsumo
                      elemento={elemento}
                      seleccionada={seleccionado?.id === elemento.id}
                      alSeleccionar={() => setSeleccionId(elemento.id)}
                      decisionLocal={cola.decisionesLocales.get(elemento.id)}
                      ocupada={enCurso === elemento.id}
                      alValidar={() => {
                        setSeleccionId(elemento.id);
                        setDialogo({ tipo: 'validar', elemento });
                      }}
                      alRechazar={() => {
                        setSeleccionId(elemento.id);
                        setDialogo({ tipo: 'rechazar', elemento });
                      }}
                      alAbrirEvidencia={(evidencia) => void visor.abrir(evidencia)}
                      cargandoEvidenciaId={visor.cargandoId}
                    />
                  </li>
                ))}
              </ul>
            )}
            {cola.fuente === 'servidor' && cola.consulta.hasNextPage && (
              <Boton
                variante="secundario"
                cargando={cola.consulta.isFetchingNextPage}
                textoCargando="Cargando más consumos…"
                onClick={() => void cola.consulta.fetchNextPage()}
              >
                Cargar más consumos
              </Boton>
            )}
          </div>
        </Tarjeta>

        <div className="flex flex-col gap-6">
          <ResumenOrdenTarjeta
            orderId={orderIdDerecha}
            pie={
              orderIdDerecha !== null && (
                <Link to={`/jefe/ordenes/${orderIdDerecha}`} className={CLASE_ENLACE}>
                  Gestionar la orden
                </Link>
              )
            }
          />
          <TrazabilidadOrden orderId={orderIdDerecha} />
        </div>
      </div>

      <DialogoConfirmacion
        abierto={dialogo?.tipo === 'validar'}
        titulo="¿Validar este gasto?"
        descripcion={
          dialogo !== null &&
          `Se aprobará el consumo de ${descripcionConsumo(dialogo.elemento)}. La decisión queda en la auditoría y no se puede deshacer.`
        }
        tono="exito"
        textoConfirmar="Validar gasto"
        cargando={decision.isPending}
        alConfirmar={() => confirmar()}
        alCancelar={() => setDialogo(null)}
      />
      <DialogoConfirmacion
        abierto={dialogo?.tipo === 'rechazar'}
        titulo="Rechazar consumo"
        descripcion={
          dialogo !== null &&
          `Va a rechazar el consumo de ${descripcionConsumo(dialogo.elemento)}. El supervisor verá el motivo y podrá registrar una corrección.`
        }
        tono="peligro"
        textoConfirmar="Rechazar consumo"
        cargando={decision.isPending}
        motivo={{
          etiqueta: 'Motivo del rechazo',
          ayuda: 'Entre 3 y 500 caracteres. El supervisor lo verá en su tablet.',
          minimo: 3,
          maximo: 500,
        }}
        alConfirmar={(motivo) => confirmar(motivo)}
        alCancelar={() => setDialogo(null)}
      />
      <VisorImagen
        abierto={visor.abierta !== null}
        src={visor.abierta?.url ?? ''}
        alt={visor.abierta?.alt ?? ''}
        titulo={visor.abierta?.titulo ?? ''}
        alCerrar={visor.cerrar}
      />
    </div>
  );
}

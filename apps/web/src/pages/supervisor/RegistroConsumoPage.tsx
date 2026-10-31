import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useSincronizacion } from '../../app/contexto-sincronizacion';
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
  useAvisos,
} from '../../components/ui';
import {
  ErrorDatosLocales,
  novedadesDeConsumo,
  reenviarPerdido,
  type ConsumoLocal,
} from '../../datos';
import {
  consumoConMaterial,
  datosDeOrden,
  registrosDeHoyDeOrden,
  trazabilidadReciente,
} from '../../features/consumos/consultas';
import { DialogoConsumo, type AccionElegida } from '../../features/consumos/DialogoConsumo';
import { DialogoNovedad } from '../../features/consumos/DialogoNovedad';
import { accionesDeConsumo } from '../../features/consumos/estado-consumo';
import {
  FormularioConsumo,
  type ModoFormulario,
  type ResultadoGuardado,
} from '../../features/consumos/FormularioConsumo';
import { RegistrosDeHoy } from '../../features/consumos/RegistrosDeHoy';
import { TrazabilidadDispositivo } from '../../features/consumos/TrazabilidadDispositivo';

/** Parámetro de la URL → modo del formulario (así "Atrás" vuelve al registro nuevo). */
const PARAMETROS = {
  editar: 'editar',
  corrige: 'corregir',
  copia: 'copiar',
} as const satisfies Record<string, Exclude<ModoFormulario['tipo'], 'nuevo'>>;

type Parametro = keyof typeof PARAMETROS;

const PARAMETRO_DE_ACCION: Readonly<
  Record<Exclude<AccionElegida, 'justificar' | 'reenviar'>, Parametro>
> = {
  editar: 'editar',
  corregir: 'corrige',
  registrarDeNuevo: 'copia',
};

const TITULO_GUARDADO: Readonly<Record<ResultadoGuardado['modo'], string>> = {
  nuevo: 'Registro guardado en esta tablet',
  copiar: 'Registro guardado en esta tablet',
  corregir: 'Corrección guardada en esta tablet',
  editar: 'Cambios guardados en esta tablet',
};

function leerModoPedido(params: URLSearchParams): { parametro: Parametro; id: string } | null {
  for (const parametro of Object.keys(PARAMETROS) as Parametro[]) {
    const id = params.get(parametro);
    if (id) {
      return { parametro, id };
    }
  }
  return null;
}

/**
 * `/supervisor/ordenes/:id/registrar` (Figma "Supervisor · Registro de Consumo"): formulario a la
 * izquierda; registros de hoy y trazabilidad del dispositivo a la derecha (una columna en vertical).
 */
export function RegistroConsumoPage() {
  const { id: orderId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const userId = useSesion((estado) => estado.usuario?.id ?? '');
  const { cambioLocal } = useSincronizacion();
  const { mostrar } = useAvisos();
  const [abierto, setAbierto] = useState<ConsumoLocal | null>(null);
  const [justificando, setJustificando] = useState<ConsumoLocal | null>(null);

  const consultaOrden = useCallback(() => datosDeOrden(userId, orderId), [userId, orderId]);
  const consultaHoy = useCallback(() => registrosDeHoyDeOrden(userId, orderId), [userId, orderId]);
  const consultaTraza = useCallback(() => trazabilidadReciente(userId), [userId]);
  const { datos, error: errorOrden, reintentar: reintentarOrden } = useConsultaLocal(consultaOrden);
  const hoy = useConsultaLocal(consultaHoy);
  const traza = useConsultaLocal(consultaTraza);

  const pedido = leerModoPedido(params);
  const idPedido = pedido?.id ?? null;
  const consultaModo = useCallback(async () => {
    if (idPedido === null) {
      return null;
    }
    const encontrado = await consumoConMaterial(userId, idPedido);
    if (encontrado === null) {
      return null;
    }
    const novedades = await novedadesDeConsumo(userId, idPedido);
    return {
      ...encontrado,
      tieneNovedad: novedades.some((n) => n.estado_local !== 'rechazado_sync'),
    };
  }, [userId, idPedido]);
  const { datos: datosModo, cargando: cargandoModo } = useConsultaLocal(
    idPedido === null ? null : consultaModo,
  );

  const orden = datos?.orden ?? null;
  useSubtituloBarra(orden ? `Orden ${orden.codigo} · Línea ${orden.linea}` : null);

  // Modo pedido por la URL, solo si el consumo existe, es de esta orden y la acción está permitida.
  let modo: ModoFormulario = { tipo: 'nuevo' };
  let modoInvalido = false;
  if (pedido !== null && datosModo !== undefined) {
    const consumo = datosModo?.consumo;
    const acciones = consumo ? accionesDeConsumo(consumo, userId) : null;
    const tipo = PARAMETROS[pedido.parametro];
    const permitido =
      consumo !== undefined &&
      consumo.order_id === orderId &&
      acciones !== null &&
      ((tipo === 'editar' && acciones.editar) ||
        (tipo === 'corregir' && acciones.corregir) ||
        (tipo === 'copiar' && acciones.registrarDeNuevo));
    if (permitido && datosModo) {
      modo =
        tipo === 'editar'
          ? { tipo, consumo: datosModo.consumo, tieneNovedad: datosModo.tieneNovedad }
          : { tipo, consumo: datosModo.consumo };
    } else {
      modoInvalido = true;
    }
  }

  function volverANuevo() {
    setParams({}, { replace: true });
  }

  function alGuardar(resultado: ResultadoGuardado) {
    cambioLocal();
    mostrar({
      tono: 'exito',
      titulo: TITULO_GUARDADO[resultado.modo],
      mensaje: resultado.conNovedad
        ? 'Incluye la novedad. Se sincroniza al recuperar señal.'
        : 'Se sincroniza al recuperar señal.',
    });
    if (resultado.modo !== 'nuevo') {
      volverANuevo();
    }
  }

  function alFallar(mensaje: string) {
    mostrar({ tono: 'error', titulo: 'No se pudo guardar', mensaje });
  }

  /** Consumo que el servidor perdió en una restauración: se vuelve a encolar (ADR 0016). */
  async function reenviar(consumo: ConsumoLocal) {
    try {
      await reenviarPerdido(userId, consumo.id);
      cambioLocal();
      mostrar({
        tono: 'exito',
        titulo: 'Registro puesto en cola para enviar',
        mensaje: 'Se enviará al servidor en la próxima sincronización.',
      });
    } catch (error) {
      alFallar(
        error instanceof ErrorDatosLocales
          ? error.message
          : 'Ocurrió un error inesperado. El registro sigue guardado en esta tablet.',
      );
    }
  }

  function alElegir(accion: AccionElegida, consumo: ConsumoLocal) {
    setAbierto(null);
    if (accion === 'justificar') {
      setJustificando(consumo);
      return;
    }
    if (accion === 'reenviar') {
      void reenviar(consumo);
      return;
    }
    setParams({ [PARAMETRO_DE_ACCION[accion]]: consumo.id });
  }

  // El encabezado es el mismo elemento en todos los estados: el foco que la navegación puso en el
  // `<h1>` no se pierde cuando llegan los datos de la tablet.
  const encabezado = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-2xl font-bold text-ink-950">
        {orden !== null
          ? `Registro de consumo · ${orden.codigo}`
          : datos !== undefined
            ? 'Orden no disponible'
            : 'Registro de consumo'}
      </h1>
      {orden !== null && (
        <Link
          to=".."
          relative="path"
          className="inline-flex min-h-11 items-center font-semibold text-brand-600 underline-offset-4 active:underline"
        >
          Ver planeado vs consumido
        </Link>
      )}
    </div>
  );

  if (datos === undefined) {
    return (
      <div className="flex flex-col gap-6">
        {encabezado}
        {errorOrden !== undefined ? (
          <ErrorCarga
            titulo="No se pudo leer la orden guardada en esta tablet"
            alReintentar={reintentarOrden}
            accion={
              <EnlaceBoton to="/supervisor" variante="fantasma">
                Volver a mis órdenes
              </EnlaceBoton>
            }
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

  const nombreDe = (consumo: ConsumoLocal | null) =>
    consumo === null
      ? ''
      : (datos.materiales.get(consumo.material_id)?.nombre ?? 'Material sin catálogo local');

  /** "Ir al formulario" del estado vacío: lleva el foco al primer campo (en vertical está arriba). */
  function irAlFormulario() {
    document.getElementById(`formulario-consumo-${modo.tipo}-material`)?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      {encabezado}

      {modoInvalido && (
        <Aviso tono="advertencia" titulo="Esa acción ya no está disponible" alCerrar={volverANuevo}>
          El registro cambió o no pertenece a esta orden. Puede registrar un consumo nuevo.
        </Aviso>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {pedido !== null && cargandoModo ? (
          <TextoCargando texto="Cargando registro…" />
        ) : (
          <FormularioConsumo
            key={modo.tipo === 'nuevo' ? 'nuevo' : `${modo.tipo}-${modo.consumo.id}`}
            userId={userId}
            orden={orden}
            avance={datos.avance}
            materiales={datos.materiales}
            modo={modo}
            alGuardar={alGuardar}
            alFallar={alFallar}
            alCancelar={modo.tipo === 'nuevo' ? undefined : volverANuevo}
          />
        )}

        <div className="flex flex-col gap-6">
          <RegistrosDeHoy
            userId={userId}
            codigoOrden={orden.codigo}
            registros={hoy.datos}
            error={hoy.error}
            alReintentar={hoy.reintentar}
            alAbrir={setAbierto}
            alIrAlFormulario={irAlFormulario}
          />
          <TrazabilidadDispositivo
            eventos={traza.datos}
            error={traza.error}
            alReintentar={traza.reintentar}
          />
        </div>
      </div>

      <DialogoConsumo
        userId={userId}
        consumo={abierto}
        nombreMaterial={nombreDe(abierto)}
        alElegir={alElegir}
        alCerrar={() => setAbierto(null)}
      />
      <DialogoNovedad
        userId={userId}
        consumo={justificando}
        nombreMaterial={nombreDe(justificando)}
        alGuardar={() => {
          setJustificando(null);
          cambioLocal();
          mostrar({
            tono: 'exito',
            titulo: 'Novedad guardada en esta tablet',
            mensaje: 'Se sincroniza al recuperar señal.',
          });
        }}
        alFallar={alFallar}
        alCerrar={() => setJustificando(null)}
      />
    </div>
  );
}

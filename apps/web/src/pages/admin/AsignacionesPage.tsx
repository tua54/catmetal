import type { DetalleOrden, SupervisoresDeOrden, Usuario } from '@catmetal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Aviso,
  Boton,
  DialogoConfirmacion,
  EstadoVacio,
  SelectCorto,
  Tarjeta,
  useAvisos,
} from '../../components/ui';
import { apiAdmin, CLAVES_ADMIN } from '../../features/admin/api';
import {
  esCodigo,
  esSinConexion,
  MENSAJE_CONFLICTO_ASIGNACION,
  MENSAJE_SUPERVISOR_NO_VALIDO,
  mensajeDeError,
} from '../../features/admin/errores';
import { Cargando, ErrorConsulta, SinConexionAdmin } from '../../features/admin/EstadosConsulta';
import { NOMBRE_ESTADO_ORDEN } from '../../features/admin/formato';
import { useEnLinea } from '../../features/admin/formularios';

/** Solo se asignan órdenes que todavía se trabajan (las finalizadas o canceladas ya no). */
const ESTADOS_ASIGNABLES = ['planeada', 'en_proceso'] as const;

interface AvisoPagina {
  tono: 'error' | 'advertencia';
  titulo: string;
  mensaje: string;
}

function listaNombres(nombres: readonly string[]): string {
  return new Intl.ListFormat('es-CO', { type: 'conjunction' }).format(nombres);
}

/** `/admin/asignaciones`: qué supervisores ven y registran en cada orden (S2). */
export function AsignacionesPage() {
  const enLinea = useEnLinea();
  const queryClient = useQueryClient();
  const avisos = useAvisos();
  const [ordenId, setOrdenId] = useState('');
  const [aviso, setAviso] = useState<AvisoPagina | null>(null);

  const ordenes = useQuery({
    queryKey: CLAVES_ADMIN.ordenes,
    queryFn: () => apiAdmin.ordenesEn(ESTADOS_ASIGNABLES),
    enabled: enLinea,
  });
  const supervisores = useQuery({
    queryKey: CLAVES_ADMIN.supervisores,
    queryFn: () => apiAdmin.supervisoresActivos(),
    enabled: enLinea,
  });
  const detalle = useQuery({
    queryKey: CLAVES_ADMIN.orden(ordenId),
    queryFn: () => apiAdmin.detalleOrden(ordenId),
    enabled: enLinea && ordenId !== '',
  });

  function recargar() {
    void queryClient.invalidateQueries({ queryKey: CLAVES_ADMIN.orden(ordenId) });
    void queryClient.invalidateQueries({ queryKey: CLAVES_ADMIN.supervisores });
  }

  function alGuardado(respuesta: SupervisoresDeOrden, codigo: string) {
    setAviso(null);
    queryClient.setQueryData<DetalleOrden>(CLAVES_ADMIN.orden(respuesta.order_id), (previo) =>
      previo === undefined ? previo : { ...previo, supervisores: respuesta.supervisores },
    );
    const total = respuesta.supervisores.length;
    avisos.mostrar({
      tono: 'exito',
      titulo: 'Asignaciones guardadas',
      mensaje: `Orden ${codigo}: ${
        total === 0
          ? 'sin supervisores asignados'
          : total === 1
            ? '1 supervisor asignado'
            : `${total} supervisores asignados`
      }.`,
    });
    void queryClient.invalidateQueries({ queryKey: CLAVES_ADMIN.orden(respuesta.order_id) });
  }

  function alErrorGuardado(error: unknown) {
    if (esCodigo(error, 'CONFLICTO')) {
      setAviso({
        tono: 'advertencia',
        titulo: 'Las asignaciones cambiaron',
        mensaje: MENSAJE_CONFLICTO_ASIGNACION,
      });
    } else if (esCodigo(error, 'VALIDACION')) {
      setAviso({
        tono: 'advertencia',
        titulo: 'Revise la lista',
        mensaje: MENSAJE_SUPERVISOR_NO_VALIDO,
      });
    } else {
      setAviso({ tono: 'error', titulo: 'No se guardó', mensaje: mensajeDeError(error, true) });
    }
    if (!esSinConexion(error)) {
      recargar();
    }
  }

  let contenido;
  if (ordenes.data === undefined || supervisores.data === undefined) {
    const error = ordenes.error ?? supervisores.error;
    contenido = !enLinea ? (
      <SinConexionAdmin />
    ) : error !== null ? (
      <ErrorConsulta
        error={error}
        titulo="No se pudieron cargar las órdenes o los supervisores"
        alReintentar={() => {
          void ordenes.refetch();
          void supervisores.refetch();
        }}
      />
    ) : (
      <Cargando texto="Cargando órdenes y supervisores…" />
    );
  } else if (ordenes.data.length === 0) {
    contenido = (
      <EstadoVacio
        titulo="No hay órdenes planeadas ni en proceso"
        texto="Cuando el jefe cree una orden, podrá asignarle supervisores aquí."
      />
    );
  } else {
    const opciones = ordenes.data.map((orden) => ({
      valor: orden.id,
      etiqueta: `${orden.codigo} · Línea ${orden.linea} · ${NOMBRE_ESTADO_ORDEN[orden.estado]}`,
    }));
    contenido = (
      <div className="flex flex-col gap-6">
        <SelectCorto
          etiqueta="Orden de producción"
          textoVacio="Seleccione una orden…"
          ayuda="Se muestran las órdenes planeadas y en proceso."
          opciones={opciones}
          value={ordenId}
          onChange={(evento) => {
            setOrdenId(evento.target.value);
            setAviso(null);
          }}
        />
        {ordenId !== '' &&
          (detalle.data === undefined ? (
            !enLinea ? (
              <SinConexionAdmin />
            ) : detalle.isError ? (
              <ErrorConsulta
                error={detalle.error}
                titulo="No se pudo cargar la orden"
                alReintentar={() => void detalle.refetch()}
              />
            ) : (
              <Cargando texto="Cargando la orden…" />
            )
          ) : (
            <EditorAsignaciones
              // Al recargar la orden o los supervisores, la selección vuelve a lo del servidor.
              key={`${detalle.data.id}:${detalle.dataUpdatedAt}:${supervisores.dataUpdatedAt}`}
              orden={detalle.data}
              supervisores={supervisores.data}
              alGuardado={alGuardado}
              alError={alErrorGuardado}
            />
          ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {aviso && (
        <Aviso tono={aviso.tono} anunciar titulo={aviso.titulo} alCerrar={() => setAviso(null)}>
          {aviso.mensaje}
        </Aviso>
      )}
      <Tarjeta titulo="Asignación de supervisores" acento>
        <p className="mb-4 max-w-prose text-base text-ink-700">
          Un supervisor solo ve y registra consumos en las órdenes que tiene asignadas.
        </p>
        {contenido}
      </Tarjeta>
    </div>
  );
}

interface PropsEditorAsignaciones {
  orden: DetalleOrden;
  /** Supervisores activos (los únicos que se pueden asignar). */
  supervisores: Usuario[];
  alGuardado: (respuesta: SupervisoresDeOrden, codigo: string) => void;
  alError: (error: unknown) => void;
}

function EditorAsignaciones({ orden, supervisores, alGuardado, alError }: PropsEditorAsignaciones) {
  const asignados = new Set(orden.supervisores.map((s) => s.user_id));
  const elegibles = new Set(supervisores.map((s) => s.id));
  // Asignados que ya no son supervisores activos: el servidor no los acepta, se quitan al guardar.
  const noElegibles = orden.supervisores.filter((s) => !elegibles.has(s.user_id));
  const [seleccion, setSeleccion] = useState<ReadonlySet<string>>(
    () => new Set([...asignados].filter((id) => elegibles.has(id))),
  );
  const [confirmando, setConfirmando] = useState(false);

  const guardar = useMutation({
    mutationFn: (ids: string[]) => apiAdmin.reemplazarSupervisores(orden.id, ids),
  });

  const nombrePorId = new Map<string, string>([
    ...orden.supervisores.map((s) => [s.user_id, s.nombre] as const),
    ...supervisores.map((s) => [s.id, s.nombre] as const),
  ]);
  const agregados = supervisores.filter((s) => seleccion.has(s.id) && !asignados.has(s.id));
  const quitados = orden.supervisores.filter((s) => !seleccion.has(s.user_id));
  const sinCambios = agregados.length === 0 && quitados.length === 0;

  function alternar(id: string, elegido: boolean) {
    setSeleccion((previa) => {
      const nueva = new Set(previa);
      if (elegido) {
        nueva.add(id);
      } else {
        nueva.delete(id);
      }
      return nueva;
    });
  }

  function confirmar() {
    // Orden estable (el de la lista visible) para que la petición sea predecible.
    const ids = supervisores.filter((s) => seleccion.has(s.id)).map((s) => s.id);
    guardar.mutate(ids, {
      onSuccess: (respuesta) => {
        setConfirmando(false);
        alGuardado(respuesta, orden.codigo);
      },
      onError: (error) => {
        setConfirmando(false);
        alError(error);
      },
    });
  }

  const nombresQuitados = quitados.map((s) => nombrePorId.get(s.user_id) ?? s.nombre);

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby={`asignados-${orden.id}`} className="flex flex-col gap-2">
        <h3 id={`asignados-${orden.id}`} className="text-base font-semibold text-ink-950">
          Asignados ahora en la orden {orden.codigo}
        </h3>
        {orden.supervisores.length === 0 ? (
          <p className="text-base text-ink-700">Ningún supervisor tiene asignada esta orden.</p>
        ) : (
          <ul className="list-inside list-disc text-base text-ink-700">
            {orden.supervisores.map((s) => (
              <li key={s.user_id}>{s.nombre}</li>
            ))}
          </ul>
        )}
      </section>

      {noElegibles.length > 0 && (
        <Aviso tono="advertencia" titulo="Asignaciones que se quitarán">
          {`${listaNombres(noElegibles.map((s) => s.nombre))} ya no ${
            noElegibles.length === 1 ? 'es un supervisor activo' : 'son supervisores activos'
          }: al guardar se quitará su asignación.`}
        </Aviso>
      )}

      {supervisores.length === 0 ? (
        <EstadoVacio
          titulo="No hay supervisores activos"
          texto="Cree un usuario con rol Supervisor en la sección Usuarios para poder asignarlo."
        />
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-base font-semibold text-ink-950">
            Supervisores de la orden {orden.codigo}
          </legend>
          {supervisores.map((supervisor) => {
            const id = `supervisor-${orden.id}-${supervisor.id}`;
            return (
              <label
                key={supervisor.id}
                htmlFor={id}
                className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 active:bg-surface-200"
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={seleccion.has(supervisor.id)}
                  onChange={(evento) => alternar(supervisor.id, evento.target.checked)}
                  className="size-6 shrink-0 accent-brand-600"
                />
                <span className="text-base text-ink-950">{supervisor.nombre}</span>
                <span className="text-sm break-all text-ink-500">{supervisor.email}</span>
              </label>
            );
          })}
        </fieldset>
      )}

      <div>
        <Boton
          tamano="grande"
          motivoDeshabilitado={sinCambios ? 'No hay cambios para guardar.' : undefined}
          onClick={() => setConfirmando(true)}
        >
          Guardar asignaciones
        </Boton>
      </div>

      <DialogoConfirmacion
        abierto={confirmando}
        titulo={`¿Guardar las asignaciones de la orden ${orden.codigo}?`}
        descripcion={
          <div className="flex flex-col gap-2">
            {agregados.length > 0 && (
              <p>
                <strong>Se asigna a:</strong> {listaNombres(agregados.map((s) => s.nombre))}.
              </p>
            )}
            {quitados.length > 0 && (
              <p>
                <strong>Se quita a:</strong> {listaNombres(nombresQuitados)}.{' '}
                {quitados.length === 1
                  ? 'Dejará de ver esta orden en su tablet cuando sincronice.'
                  : 'Dejarán de ver esta orden en sus tablets cuando sincronicen.'}
              </p>
            )}
          </div>
        }
        textoConfirmar="Guardar asignaciones"
        tono={quitados.length > 0 ? 'peligro' : 'primario'}
        cargando={guardar.isPending}
        alCancelar={() => {
          if (!guardar.isPending) {
            setConfirmando(false);
          }
        }}
        alConfirmar={confirmar}
      />
    </div>
  );
}

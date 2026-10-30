import { formatearCOP, type Material } from '@catmetal/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { cx } from '../../components/ui/clases';
import { apiAdmin, CLAVES_ADMIN, type FiltroActivo } from '../../features/admin/api';
import { DialogoCrearMaterial, DialogoEditarMaterial } from '../../features/admin/DialogosMaterial';
import {
  esCodigo,
  esSinConexion,
  MENSAJE_CONFLICTO_MATERIAL,
  mensajeDeError,
} from '../../features/admin/errores';
import { Cargando, ErrorConsulta, SinConexionAdmin } from '../../features/admin/EstadosConsulta';
import { NOMBRE_UNIDAD } from '../../features/admin/formato';
import { useEnLinea } from '../../features/admin/formularios';

type Accion =
  { tipo: 'crear' } | { tipo: 'editar' | 'desactivar' | 'reactivar'; material: Material };

interface AvisoPagina {
  tono: 'error' | 'advertencia';
  titulo: string;
  mensaje: string;
}

const OPCIONES_FILTRO: { valor: FiltroActivo; etiqueta: string }[] = [
  { valor: 'todos', etiqueta: 'Todos' },
  { valor: 'activos', etiqueta: 'Solo activos' },
  { valor: 'inactivos', etiqueta: 'Solo inactivos' },
];

function esFiltro(valor: string): valor is FiltroActivo {
  return OPCIONES_FILTRO.some((opcion) => opcion.valor === valor);
}

/** `/admin/materiales`: catálogo. Nunca se borra un material: se desactiva. */
export function MaterialesPage() {
  const enLinea = useEnLinea();
  const queryClient = useQueryClient();
  const avisos = useAvisos();
  const [filtro, setFiltro] = useState<FiltroActivo>('todos');
  const [accion, setAccion] = useState<Accion | null>(null);
  const [aviso, setAviso] = useState<AvisoPagina | null>(null);

  const consulta = useInfiniteQuery({
    queryKey: CLAVES_ADMIN.materiales(filtro),
    queryFn: ({ pageParam }) => apiAdmin.listarMateriales(filtro, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (pagina) => pagina.siguiente_cursor ?? undefined,
    enabled: enLinea,
  });
  const materiales = consulta.data?.pages.flatMap((pagina) => pagina.materiales);

  const cambiarEstado = useMutation({
    mutationFn: ({ material, activo }: { material: Material; activo: boolean }) =>
      apiAdmin.editarMaterial(material.id, { activo }),
  });

  function recargar() {
    void queryClient.invalidateQueries({ queryKey: CLAVES_ADMIN.materialesTodos });
  }

  function terminar(titulo: string, mensaje: string) {
    setAccion(null);
    setAviso(null);
    avisos.mostrar({ tono: 'exito', titulo, mensaje });
    recargar();
  }

  function conflicto() {
    setAccion(null);
    setAviso({
      tono: 'advertencia',
      titulo: 'El material cambió',
      mensaje: MENSAJE_CONFLICTO_MATERIAL,
    });
    recargar();
  }

  function confirmarEstado(material: Material, activo: boolean) {
    cambiarEstado.mutate(
      { material, activo },
      {
        onSuccess: (guardado) =>
          terminar(
            activo ? 'Material reactivado' : 'Material desactivado',
            `${guardado.codigo} · ${guardado.nombre}`,
          ),
        onError: (error) => {
          if (esCodigo(error, 'CONFLICTO')) {
            conflicto();
            return;
          }
          setAccion(null);
          setAviso({ tono: 'error', titulo: 'No se guardó', mensaje: mensajeDeError(error, true) });
          if (!esSinConexion(error)) {
            recargar();
          }
        },
      },
    );
  }

  let contenido;
  if (materiales === undefined) {
    contenido = !enLinea ? (
      <SinConexionAdmin />
    ) : consulta.isError ? (
      <ErrorConsulta
        error={consulta.error}
        titulo="No se pudieron cargar los materiales"
        alReintentar={() => void consulta.refetch()}
      />
    ) : (
      <Cargando texto="Cargando materiales…" />
    );
  } else if (materiales.length === 0) {
    contenido = (
      <EstadoVacio
        titulo={
          filtro === 'inactivos'
            ? 'No hay materiales inactivos'
            : filtro === 'activos'
              ? 'No hay materiales activos'
              : 'No hay materiales'
        }
        texto={filtro === 'todos' ? 'Cree el primer material del catálogo.' : undefined}
      />
    );
  } else {
    contenido = (
      <>
        <ul aria-label="Materiales" className="flex flex-col divide-y divide-line-200">
          {materiales.map((material) => (
            <li
              key={material.id}
              className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between"
            >
              <div className="min-w-0">
                <p className="text-base font-semibold text-ink-950">
                  <span className="cifras">{material.codigo}</span> · {material.nombre}
                </p>
                <p className="cifras text-[0.9375rem] text-ink-700">
                  {formatearCOP(material.costo_unitario_cop)} por {material.unidad}
                  <span className="sr-only"> ({NOMBRE_UNIDAD[material.unidad]})</span>
                </p>
                <p className="mt-2">
                  <span
                    className={cx(
                      'inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-semibold',
                      material.activo
                        ? 'border-success-700/40 bg-success-100 text-success-700'
                        : 'border-ink-400 bg-surface-200 text-ink-700',
                    )}
                  >
                    {material.activo ? 'Activo' : 'Inactivo'}
                  </span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Boton
                  variante="secundario"
                  aria-label={`Editar el material ${material.codigo}`}
                  onClick={() => setAccion({ tipo: 'editar', material })}
                >
                  Editar
                </Boton>
                {material.activo ? (
                  <Boton
                    variante="peligro"
                    aria-label={`Desactivar el material ${material.codigo}`}
                    onClick={() => setAccion({ tipo: 'desactivar', material })}
                  >
                    Desactivar
                  </Boton>
                ) : (
                  <Boton
                    variante="secundario"
                    aria-label={`Reactivar el material ${material.codigo}`}
                    onClick={() => setAccion({ tipo: 'reactivar', material })}
                  >
                    Reactivar
                  </Boton>
                )}
              </div>
            </li>
          ))}
        </ul>
        {consulta.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Boton
              variante="secundario"
              cargando={consulta.isFetchingNextPage}
              textoCargando="Cargando más materiales…"
              onClick={() => void consulta.fetchNextPage()}
            >
              Cargar más materiales
            </Boton>
          </div>
        )}
        {consulta.isFetchNextPageError && (
          <p role="alert" className="mt-3 text-center text-danger-700">
            {mensajeDeError(consulta.error)}
          </p>
        )}
      </>
    );
  }

  const estado =
    accion?.tipo === 'desactivar' || accion?.tipo === 'reactivar'
      ? { material: accion.material, activo: accion.tipo === 'reactivar' }
      : null;

  return (
    <div className="flex flex-col gap-4">
      {aviso && (
        <Aviso tono={aviso.tono} anunciar titulo={aviso.titulo} alCerrar={() => setAviso(null)}>
          {aviso.mensaje}
        </Aviso>
      )}
      <Tarjeta
        titulo="Materiales"
        acento
        acciones={
          <Boton onClick={() => setAccion({ tipo: 'crear' })} disabled={!enLinea}>
            Crear material
          </Boton>
        }
      >
        <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-prose text-base text-ink-700">
            Los materiales nunca se borran: si ya no se usa, desactívelo.
          </p>
          <SelectCorto
            etiqueta="Mostrar"
            className="sm:w-56"
            opciones={OPCIONES_FILTRO}
            value={filtro}
            onChange={(evento) => {
              if (esFiltro(evento.target.value)) {
                setFiltro(evento.target.value);
              }
            }}
          />
        </div>
        {contenido}
      </Tarjeta>

      {accion?.tipo === 'crear' && (
        <DialogoCrearMaterial
          alCancelar={() => setAccion(null)}
          alCrear={(creado) => terminar('Material creado', `${creado.codigo} · ${creado.nombre}`)}
        />
      )}
      {accion?.tipo === 'editar' && (
        <DialogoEditarMaterial
          material={accion.material}
          alCancelar={() => setAccion(null)}
          alConflicto={conflicto}
          alGuardar={(guardado) =>
            terminar('Material actualizado', `${guardado.codigo} · ${guardado.nombre}`)
          }
        />
      )}
      <DialogoConfirmacion
        abierto={estado !== null}
        titulo={
          estado === null
            ? ''
            : `¿${estado.activo ? 'Reactivar' : 'Desactivar'} el material ${estado.material.codigo} · ${estado.material.nombre}?`
        }
        descripcion={
          estado === null
            ? undefined
            : estado.activo
              ? 'Se podrá usar de nuevo en consumos y en planes de órdenes.'
              : 'No se podrá usar en consumos ni en planes de órdenes nuevos. Lo ya registrado se conserva. Si alguna tablet tiene consumos de este material sin sincronizar, el servidor los rechazará al recibirlos.'
        }
        textoConfirmar={estado?.activo ? 'Reactivar material' : 'Desactivar material'}
        tono={estado?.activo ? 'primario' : 'peligro'}
        cargando={cambiarEstado.isPending}
        alCancelar={() => {
          if (!cambiarEstado.isPending) {
            setAccion(null);
          }
        }}
        alConfirmar={() => {
          if (estado) {
            confirmarEstado(estado.material, estado.activo);
          }
        }}
      />
    </div>
  );
}

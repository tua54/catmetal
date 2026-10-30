import type { EditarUsuario, Usuario } from '@catmetal/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSesion } from '../../auth';
import {
  Aviso,
  Boton,
  DialogoConfirmacion,
  EstadoVacio,
  Tarjeta,
  useAvisos,
} from '../../components/ui';
import { cx } from '../../components/ui/clases';
import { NOMBRE_ROL } from '../../rutas/acceso';
import { apiAdmin, CLAVES_ADMIN } from '../../features/admin/api';
import { DialogoCrearUsuario } from '../../features/admin/DialogoCrearUsuario';
import {
  DialogoContrasenaUsuario,
  DialogoEditarUsuario,
} from '../../features/admin/DialogoEditarUsuario';
import {
  esCodigo,
  esSinConexion,
  MENSAJE_CONFLICTO_USUARIO,
  MENSAJE_ULTIMO_ADMIN,
  mensajeDeError,
} from '../../features/admin/errores';
import { Cargando, ErrorConsulta, SinConexionAdmin } from '../../features/admin/EstadosConsulta';
import { textoBloqueo } from '../../features/admin/formato';
import { useEnLinea } from '../../features/admin/formularios';

type TipoConfirmacion = 'desactivar' | 'reactivar' | 'desbloquear';

type Accion =
  { tipo: 'crear' } | { tipo: 'editar' | 'contrasena' | TipoConfirmacion; usuario: Usuario };

interface AvisoPagina {
  tono: 'error' | 'advertencia';
  titulo: string;
  mensaje: string;
}

const CAMBIO_POR_CONFIRMACION: Readonly<Record<TipoConfirmacion, EditarUsuario>> = {
  desactivar: { activo: false },
  reactivar: { activo: true },
  desbloquear: { desbloquear: true },
};

const ETIQUETA_ESTADO =
  'inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-semibold';

function textosConfirmacion(tipo: TipoConfirmacion, usuario: Usuario, esPropio: boolean) {
  const propio = esPropio
    ? ' Es su propia cuenta: también se cerrará su sesión en este dispositivo.'
    : '';
  switch (tipo) {
    case 'desactivar':
      return {
        titulo: `¿Desactivar a ${usuario.nombre}?`,
        descripcion: `No podrá iniciar sesión y se cerrarán todas sus sesiones abiertas en todos sus dispositivos. Sus registros se conservan y puede reactivarlo cuando quiera.${propio}`,
        textoConfirmar: 'Desactivar usuario',
        tono: 'peligro' as const,
        exito: {
          titulo: 'Usuario desactivado',
          mensaje: `${usuario.nombre} ya no puede iniciar sesión.`,
        },
      };
    case 'reactivar':
      return {
        titulo: `¿Reactivar a ${usuario.nombre}?`,
        descripcion: 'Podrá volver a iniciar sesión con su contraseña actual.',
        textoConfirmar: 'Reactivar usuario',
        tono: 'primario' as const,
        exito: {
          titulo: 'Usuario reactivado',
          mensaje: `${usuario.nombre} ya puede iniciar sesión.`,
        },
      };
    case 'desbloquear':
      return {
        titulo: `¿Desbloquear a ${usuario.nombre}?`,
        descripcion:
          'Se borran sus intentos fallidos y podrá iniciar sesión de inmediato, sin esperar a que termine el bloqueo.',
        textoConfirmar: 'Desbloquear usuario',
        tono: 'primario' as const,
        exito: {
          titulo: 'Usuario desbloqueado',
          mensaje: `${usuario.nombre} ya puede iniciar sesión.`,
        },
      };
  }
}

/** `/admin`: usuarios. Nunca se borra un usuario: se desactiva (docs/spec.md §3). */
export function UsuariosPage() {
  const enLinea = useEnLinea();
  const idPropio = useSesion((estado) => estado.usuario?.id ?? null);
  const queryClient = useQueryClient();
  const avisos = useAvisos();
  const [accion, setAccion] = useState<Accion | null>(null);
  const [aviso, setAviso] = useState<AvisoPagina | null>(null);

  const consulta = useInfiniteQuery({
    queryKey: CLAVES_ADMIN.usuarios,
    queryFn: ({ pageParam }) => apiAdmin.listarUsuarios(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (pagina) => pagina.siguiente_cursor ?? undefined,
    enabled: enLinea,
  });
  const usuarios = consulta.data?.pages.flatMap((pagina) => pagina.usuarios);

  const cambiarEstado = useMutation({
    mutationFn: ({ usuario, cambios }: { usuario: Usuario; cambios: EditarUsuario }) =>
      apiAdmin.editarUsuario(usuario.id, cambios),
  });

  function recargar() {
    void queryClient.invalidateQueries({ queryKey: CLAVES_ADMIN.usuarios });
    void queryClient.invalidateQueries({ queryKey: CLAVES_ADMIN.supervisores });
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
      titulo: 'El usuario cambió',
      mensaje: MENSAJE_CONFLICTO_USUARIO,
    });
    recargar();
  }

  function confirmar(tipo: TipoConfirmacion, usuario: Usuario) {
    const { exito } = textosConfirmacion(tipo, usuario, usuario.id === idPropio);
    cambiarEstado.mutate(
      { usuario, cambios: CAMBIO_POR_CONFIRMACION[tipo] },
      {
        onSuccess: () => terminar(exito.titulo, exito.mensaje),
        onError: (error) => {
          if (esCodigo(error, 'CONFLICTO')) {
            conflicto();
            return;
          }
          setAccion(null);
          setAviso({
            tono: 'error',
            titulo: esCodigo(error, 'ULTIMO_ADMIN')
              ? 'Debe quedar un administrador'
              : 'No se guardó',
            mensaje: esCodigo(error, 'ULTIMO_ADMIN')
              ? MENSAJE_ULTIMO_ADMIN
              : mensajeDeError(error, true),
          });
          if (!esSinConexion(error)) {
            recargar();
          }
        },
      },
    );
  }

  let contenido;
  if (usuarios === undefined) {
    contenido = !enLinea ? (
      <SinConexionAdmin />
    ) : consulta.isError ? (
      <ErrorConsulta
        error={consulta.error}
        titulo="No se pudieron cargar los usuarios"
        alReintentar={() => void consulta.refetch()}
      />
    ) : (
      <Cargando texto="Cargando usuarios…" />
    );
  } else if (usuarios.length === 0) {
    contenido = <EstadoVacio titulo="No hay usuarios" />;
  } else {
    contenido = (
      <>
        <ul aria-label="Usuarios" className="flex flex-col divide-y divide-line-200">
          {usuarios.map((usuario) => (
            <FilaUsuario
              key={usuario.id}
              usuario={usuario}
              esPropio={usuario.id === idPropio}
              alAccion={(tipo) => setAccion({ tipo, usuario })}
            />
          ))}
        </ul>
        {consulta.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Boton
              variante="secundario"
              cargando={consulta.isFetchingNextPage}
              textoCargando="Cargando más usuarios…"
              onClick={() => void consulta.fetchNextPage()}
            >
              Cargar más usuarios
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

  const confirmacion =
    accion !== null &&
    (accion.tipo === 'desactivar' || accion.tipo === 'reactivar' || accion.tipo === 'desbloquear')
      ? { tipo: accion.tipo, usuario: accion.usuario }
      : null;
  const textos = confirmacion
    ? textosConfirmacion(
        confirmacion.tipo,
        confirmacion.usuario,
        confirmacion.usuario.id === idPropio,
      )
    : null;

  return (
    <div className="flex flex-col gap-4">
      {aviso && (
        <Aviso tono={aviso.tono} anunciar titulo={aviso.titulo} alCerrar={() => setAviso(null)}>
          {aviso.mensaje}
        </Aviso>
      )}
      <Tarjeta
        titulo="Usuarios"
        acento
        acciones={
          <Boton onClick={() => setAccion({ tipo: 'crear' })} disabled={!enLinea}>
            Crear usuario
          </Boton>
        }
      >
        <p className="mb-4 text-base text-ink-700">
          Los usuarios nunca se borran: si alguien deja la empresa, desactívelo. Cambiar el rol,
          desactivar o restablecer la contraseña cierra todas las sesiones de ese usuario.
        </p>
        {contenido}
      </Tarjeta>

      {accion?.tipo === 'crear' && (
        <DialogoCrearUsuario
          alCancelar={() => setAccion(null)}
          alCrear={(creado) =>
            terminar('Usuario creado', `${creado.nombre} ya puede iniciar sesión con su correo.`)
          }
        />
      )}
      {accion?.tipo === 'editar' && (
        <DialogoEditarUsuario
          usuario={accion.usuario}
          esPropio={accion.usuario.id === idPropio}
          alCancelar={() => setAccion(null)}
          alConflicto={conflicto}
          alGuardar={(guardado) =>
            terminar(
              'Cambios guardados',
              guardado.rol === accion.usuario.rol
                ? `Se actualizaron los datos de ${guardado.nombre}.`
                : `${guardado.nombre} ahora es ${NOMBRE_ROL[guardado.rol]}. Se cerraron sus sesiones.`,
            )
          }
        />
      )}
      {accion?.tipo === 'contrasena' && (
        <DialogoContrasenaUsuario
          usuario={accion.usuario}
          esPropio={accion.usuario.id === idPropio}
          alCancelar={() => setAccion(null)}
          alConflicto={conflicto}
          alGuardar={(guardado) =>
            terminar(
              'Contraseña restablecida',
              `Se cerraron las sesiones de ${guardado.nombre}. Ya puede entrar con la nueva contraseña.`,
            )
          }
        />
      )}
      <DialogoConfirmacion
        abierto={confirmacion !== null}
        titulo={textos?.titulo ?? ''}
        descripcion={textos?.descripcion}
        textoConfirmar={textos?.textoConfirmar ?? ''}
        tono={textos?.tono}
        cargando={cambiarEstado.isPending}
        alCancelar={() => {
          if (!cambiarEstado.isPending) {
            setAccion(null);
          }
        }}
        alConfirmar={() => {
          if (confirmacion) {
            confirmar(confirmacion.tipo, confirmacion.usuario);
          }
        }}
      />
    </div>
  );
}

function FilaUsuario({
  usuario,
  esPropio,
  alAccion,
}: {
  usuario: Usuario;
  esPropio: boolean;
  alAccion: (tipo: 'editar' | 'contrasena' | TipoConfirmacion) => void;
}) {
  const bloqueo = textoBloqueo(usuario);
  return (
    <li className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <p className="text-base font-semibold text-ink-950">
          {usuario.nombre}
          {esPropio && <span className="font-normal text-ink-700"> (usted)</span>}
        </p>
        <p className="text-[0.9375rem] break-all text-ink-700">{usuario.email}</p>
        <p className="mt-2 flex flex-wrap gap-2">
          <span className={cx(ETIQUETA_ESTADO, 'border-line-200 bg-surface-50 text-ink-700')}>
            {NOMBRE_ROL[usuario.rol]}
          </span>
          <span
            className={cx(
              ETIQUETA_ESTADO,
              usuario.activo
                ? 'border-success-700/40 bg-success-100 text-success-700'
                : 'border-ink-400 bg-surface-200 text-ink-700',
            )}
          >
            {usuario.activo ? 'Activo' : 'Inactivo'}
          </span>
          {bloqueo && (
            <span
              className={cx(ETIQUETA_ESTADO, 'border-warning-500 bg-warning-100 text-warning-800')}
            >
              {bloqueo}
            </span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Boton
          variante="secundario"
          aria-label={`Editar a ${usuario.nombre}`}
          onClick={() => alAccion('editar')}
        >
          Editar
        </Boton>
        <Boton
          variante="secundario"
          aria-label={`Restablecer la contraseña de ${usuario.nombre}`}
          onClick={() => alAccion('contrasena')}
        >
          Restablecer contraseña
        </Boton>
        {bloqueo && (
          <Boton
            variante="secundario"
            aria-label={`Desbloquear a ${usuario.nombre}`}
            onClick={() => alAccion('desbloquear')}
          >
            Desbloquear
          </Boton>
        )}
        {usuario.activo ? (
          <Boton
            variante="peligro"
            aria-label={`Desactivar a ${usuario.nombre}`}
            onClick={() => alAccion('desactivar')}
          >
            Desactivar
          </Boton>
        ) : (
          <Boton
            variante="secundario"
            aria-label={`Reactivar a ${usuario.nombre}`}
            onClick={() => alAccion('reactivar')}
          >
            Reactivar
          </Boton>
        )}
      </div>
    </li>
  );
}

import {
  crearUsuarioSchema,
  passwordSchema,
  ROLES,
  type EditarUsuario,
  type Rol,
  type Usuario,
} from '@catmetal/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Aviso, Campo, SelectCorto } from '../../components/ui';
import { NOMBRE_ROL } from '../../rutas/acceso';
import { apiAdmin } from './api';
import { CampoContrasena } from './CampoContrasena';
import { DialogoFormulario } from './DialogoFormulario';
import { esCodigo, erroresDeCampo, mensajeDeError } from './errores';
import { OPCIONES_ROL } from './formato';
import { resolverDe } from './formularios';

export interface PropsEdicionUsuario {
  usuario: Usuario;
  /** El usuario editado es quien tiene la sesión abierta. */
  esPropio: boolean;
  alGuardar: (usuario: Usuario) => void;
  /** 409 `CONFLICTO`: otro admin cambió el usuario; la página recarga y lo explica. */
  alConflicto: () => void;
  alCancelar: () => void;
}

// ---------------------------------------------------------------------------------------------
// Nombre y rol
// ---------------------------------------------------------------------------------------------

interface ValoresDatos {
  nombre: string;
  rol: Rol;
}

const esquemaDatos = z.object({
  nombre: crearUsuarioSchema.shape.nombre,
  rol: z.enum(ROLES, { error: 'Elija el rol.' }),
});

const resolverDatos = resolverDe<ValoresDatos>(esquemaDatos);

/** Envía solo lo que cambió (el servidor escribe solo los campos enviados). */
async function guardarCambios(
  id: string,
  cambios: EditarUsuario,
  alGuardar: (usuario: Usuario) => void,
  alConflicto: () => void,
  alError: (mensaje: string, porCampo: Record<string, string>) => void,
): Promise<void> {
  try {
    alGuardar(await apiAdmin.editarUsuario(id, cambios));
  } catch (error) {
    if (esCodigo(error, 'CONFLICTO')) {
      alConflicto();
      return;
    }
    alError(mensajeDeError(error, true), erroresDeCampo(error));
  }
}

/** "Editar usuario": nombre y rol (`PATCH /users/:id`). Cambiar el rol cierra sus sesiones. */
export function DialogoEditarUsuario({
  usuario,
  esPropio,
  alGuardar,
  alConflicto,
  alCancelar,
}: PropsEdicionUsuario) {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ValoresDatos>({
    defaultValues: { nombre: usuario.nombre, rol: usuario.rol },
    resolver: resolverDatos,
  });
  const rol = useWatch({ control, name: 'rol' });
  const cambiaRol = rol !== usuario.rol;

  const guardar = useMutation({
    mutationFn: (cambios: EditarUsuario) =>
      guardarCambios(usuario.id, cambios, alGuardar, alConflicto, (mensaje, porCampo) => {
        const nombre = porCampo.nombre;
        if (nombre !== undefined) {
          setError('nombre', { type: 'server', message: nombre });
        } else {
          setErrorGeneral(mensaje);
        }
      }),
  });

  const enviar = handleSubmit((valores) => {
    setErrorGeneral(null);
    const cambios: EditarUsuario = {
      ...(valores.nombre !== usuario.nombre ? { nombre: valores.nombre } : {}),
      ...(valores.rol !== usuario.rol ? { rol: valores.rol } : {}),
    };
    if (Object.keys(cambios).length === 0) {
      setErrorGeneral('No hay cambios para guardar.');
      return;
    }
    guardar.mutate(cambios);
  });

  return (
    <DialogoFormulario
      titulo={`Editar a ${usuario.nombre}`}
      descripcion={`Correo: ${usuario.email}. El correo no se puede cambiar.`}
      textoConfirmar="Guardar cambios"
      enviando={guardar.isPending}
      error={errorGeneral}
      alEnviar={(evento) => void enviar(evento)}
      alCancelar={alCancelar}
    >
      <Campo
        etiqueta="Nombre completo"
        requerido
        autoComplete="off"
        error={errors.nombre?.message}
        {...register('nombre')}
      />
      <SelectCorto
        etiqueta="Rol"
        requerido
        opciones={OPCIONES_ROL}
        ayuda="Cambiar el rol cierra todas las sesiones abiertas de este usuario."
        error={errors.rol?.message}
        {...register('rol')}
      />
      {cambiaRol && (
        <Aviso tono="advertencia" titulo="Se cerrarán sus sesiones">
          {`Al pasar de ${NOMBRE_ROL[usuario.rol]} a ${NOMBRE_ROL[rol]}, ${usuario.nombre} tendrá que iniciar sesión de nuevo en todos sus dispositivos.`}
          {esPropio && ' Es su propia cuenta: también se cerrará su sesión en este dispositivo.'}
        </Aviso>
      )}
    </DialogoFormulario>
  );
}

// ---------------------------------------------------------------------------------------------
// Restablecer contraseña
// ---------------------------------------------------------------------------------------------

interface ValoresContrasena {
  password: string;
}

const esquemaContrasena = z.object({
  password: passwordSchema,
});

const resolverContrasena = resolverDe<ValoresContrasena>(esquemaContrasena);

/** "Restablecer contraseña" (`PATCH /users/:id` con `password`): cierra todas sus sesiones. */
export function DialogoContrasenaUsuario({
  usuario,
  esPropio,
  alGuardar,
  alConflicto,
  alCancelar,
}: PropsEdicionUsuario) {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ValoresContrasena>({ defaultValues: { password: '' }, resolver: resolverContrasena });
  const password = useWatch({ control, name: 'password' });

  const guardar = useMutation({
    mutationFn: (nueva: string) =>
      guardarCambios(
        usuario.id,
        { password: nueva },
        alGuardar,
        alConflicto,
        (mensaje, porCampo) => {
          const campo = porCampo.password;
          if (campo !== undefined) {
            setError('password', { type: 'server', message: campo });
          } else {
            setErrorGeneral(mensaje);
          }
        },
      ),
  });

  const enviar = handleSubmit((valores) => {
    setErrorGeneral(null);
    guardar.mutate(valores.password);
  });

  return (
    <DialogoFormulario
      titulo={`Restablecer la contraseña de ${usuario.nombre}`}
      descripcion={
        <>
          <p>
            Se cerrarán todas las sesiones abiertas de {usuario.nombre} en todos sus dispositivos.
            Entréguele la nueva contraseña de forma segura.
          </p>
          {esPropio && (
            <p className="mt-2 font-semibold">
              Es su propia cuenta: también se cerrará su sesión en este dispositivo.
            </p>
          )}
        </>
      }
      textoConfirmar="Restablecer contraseña"
      tono="peligro"
      enviando={guardar.isPending}
      error={errorGeneral}
      alEnviar={(evento) => void enviar(evento)}
      alCancelar={alCancelar}
    >
      <CampoContrasena
        etiqueta="Nueva contraseña"
        valor={password}
        error={errors.password?.message}
        registro={register('password')}
      />
    </DialogoFormulario>
  );
}

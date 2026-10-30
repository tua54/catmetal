import { crearUsuarioSchema, ROLES, type Rol, type Usuario } from '@catmetal/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Campo, SelectCorto } from '../../components/ui';
import { apiAdmin } from './api';
import { CampoContrasena } from './CampoContrasena';
import { DialogoFormulario } from './DialogoFormulario';
import {
  campoDuplicado,
  erroresDeCampo,
  MENSAJE_CORREO_DUPLICADO,
  mensajeDeError,
} from './errores';
import { OPCIONES_ROL } from './formato';
import { resolverDe } from './formularios';

interface Valores {
  nombre: string;
  email: string;
  rol: Rol | '';
  password: string;
}

const esquema = z.object({
  nombre: crearUsuarioSchema.shape.nombre,
  email: crearUsuarioSchema.shape.email,
  rol: z.enum(ROLES, { error: 'Elija el rol.' }),
  password: crearUsuarioSchema.shape.password,
});

const resolver = resolverDe<Valores>(esquema);

const CAMPOS: readonly (keyof Valores)[] = ['nombre', 'email', 'rol', 'password'];

function esCampo(campo: string): campo is keyof Valores {
  return (CAMPOS as readonly string[]).includes(campo);
}

export interface PropsDialogoCrearUsuario {
  alCrear: (usuario: Usuario) => void;
  alCancelar: () => void;
}

/** "Crear usuario" (`POST /users`). El correo repetido (409) se marca en su campo. */
export function DialogoCrearUsuario({ alCrear, alCancelar }: PropsDialogoCrearUsuario) {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<Valores>({
    defaultValues: { nombre: '', email: '', rol: '', password: '' },
    resolver,
  });
  const password = useWatch({ control, name: 'password' });

  const crear = useMutation({
    mutationFn: (valores: Valores) =>
      apiAdmin.crearUsuario({
        nombre: valores.nombre,
        email: valores.email,
        rol: valores.rol as Rol,
        password: valores.password,
      }),
  });

  const enviar = handleSubmit(async (valores) => {
    setErrorGeneral(null);
    try {
      alCrear(await crear.mutateAsync(valores));
    } catch (error) {
      if (campoDuplicado(error) === 'email') {
        setError('email', { type: 'server', message: MENSAJE_CORREO_DUPLICADO });
        setFocus('email');
        return;
      }
      const porCampo = Object.entries(erroresDeCampo(error)).filter(([campo]) => esCampo(campo));
      for (const [campo, mensaje] of porCampo) {
        setError(campo as keyof Valores, { type: 'server', message: mensaje });
      }
      if (porCampo.length === 0) {
        setErrorGeneral(mensajeDeError(error, true));
      }
    }
  });

  return (
    <DialogoFormulario
      titulo="Crear usuario"
      descripcion="El usuario podrá iniciar sesión con su correo y la contraseña que escriba aquí. Entréguele la contraseña de forma segura."
      textoConfirmar="Crear usuario"
      enviando={crear.isPending}
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
      <Campo
        etiqueta="Correo"
        requerido
        type="email"
        autoComplete="off"
        spellCheck={false}
        error={errors.email?.message}
        {...register('email')}
      />
      <SelectCorto
        etiqueta="Rol"
        requerido
        textoVacio="Seleccione…"
        opciones={OPCIONES_ROL}
        error={errors.rol?.message}
        {...register('rol')}
      />
      <CampoContrasena
        etiqueta="Contraseña"
        valor={password}
        error={errors.password?.message}
        registro={register('password')}
      />
    </DialogoFormulario>
  );
}

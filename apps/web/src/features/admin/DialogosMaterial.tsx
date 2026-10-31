import {
  crearMaterialSchema,
  formatearCOP,
  UNIDADES,
  type Material,
  type Unidad,
} from '@catmetal/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Aviso, Campo, SelectCorto } from '../../components/ui';
import { apiAdmin } from './api';
import { DialogoFormulario } from './DialogoFormulario';
import {
  campoDuplicado,
  erroresDeCampo,
  esCodigo,
  MENSAJE_CODIGO_DUPLICADO,
  mensajeDeError,
} from './errores';
import { MENSAJE_COSTO, NOMBRE_UNIDAD, parsearCostoCop } from './formato';
import { resolverDe } from './formularios';

export const TEXTO_CODIGO_UNIDAD_FIJOS =
  'El código y la unidad no se pueden cambiar después de crear el material: los usan los planes de las órdenes y los consumos ya registrados.';

export const TEXTO_COSTO_HISTORICO =
  'El costo de los consumos ya registrados no cambia: cada consumo guarda el costo vigente cuando el servidor lo recibió. Los consumos que aún estén sin sincronizar en alguna tablet tomarán el costo nuevo al llegar.';

const OPCIONES_UNIDAD = UNIDADES.map((unidad) => ({
  valor: unidad,
  etiqueta: NOMBRE_UNIDAD[unidad],
}));

/** Costo escrito como texto ("4.182") → entero en pesos, con los límites del contrato. */
const costoSchema = z.string().transform((texto, ctx) => {
  if (texto.trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'Escriba el costo unitario.' });
    return z.NEVER;
  }
  const valor = parsearCostoCop(texto);
  if (valor === null) {
    ctx.addIssue({ code: 'custom', message: MENSAJE_COSTO });
    return z.NEVER;
  }
  const resultado = crearMaterialSchema.shape.costo_unitario_cop.safeParse(valor);
  if (!resultado.success) {
    ctx.addIssue({
      code: 'custom',
      message: resultado.error.issues[0]?.message ?? MENSAJE_COSTO,
    });
    return z.NEVER;
  }
  return String(resultado.data);
});

/** Ayuda del costo: la vista previa en COP si el texto es válido. */
function ayudaCosto(texto: string): string {
  const valor = parsearCostoCop(texto);
  return valor === null
    ? 'En pesos colombianos, sin decimales.'
    : `Vista previa: ${formatearCOP(valor)}`;
}

// ---------------------------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------------------------

interface ValoresCrear {
  codigo: string;
  nombre: string;
  unidad: Unidad | '';
  costo: string;
}

const esquemaCrear = z.object({
  codigo: crearMaterialSchema.shape.codigo,
  nombre: crearMaterialSchema.shape.nombre,
  unidad: z.enum(UNIDADES, { error: 'Elija la unidad.' }),
  costo: costoSchema,
});

const resolverCrear = resolverDe<ValoresCrear>(esquemaCrear);

export interface PropsDialogoCrearMaterial {
  alCrear: (material: Material) => void;
  alCancelar: () => void;
}

/** "Crear material" (`POST /materials`). El código repetido (409) se marca en su campo. */
export function DialogoCrearMaterial({ alCrear, alCancelar }: PropsDialogoCrearMaterial) {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<ValoresCrear>({
    defaultValues: { codigo: '', nombre: '', unidad: '', costo: '' },
    resolver: resolverCrear,
  });
  const costo = useWatch({ control, name: 'costo' });

  const crear = useMutation({
    mutationFn: (valores: ValoresCrear) =>
      apiAdmin.crearMaterial({
        codigo: valores.codigo,
        nombre: valores.nombre,
        unidad: valores.unidad as Unidad,
        costo_unitario_cop: Number(valores.costo),
      }),
  });

  const enviar = handleSubmit(async (valores) => {
    setErrorGeneral(null);
    try {
      alCrear(await crear.mutateAsync(valores));
    } catch (error) {
      if (campoDuplicado(error) === 'codigo') {
        setError('codigo', { type: 'server', message: MENSAJE_CODIGO_DUPLICADO });
        setFocus('codigo');
        return;
      }
      const porCampo = erroresDeCampo(error);
      const campos: Partial<Record<string, keyof ValoresCrear>> = {
        codigo: 'codigo',
        nombre: 'nombre',
        unidad: 'unidad',
        costo_unitario_cop: 'costo',
      };
      let marcados = 0;
      for (const [campo, mensaje] of Object.entries(porCampo)) {
        const destino = campos[campo];
        if (destino !== undefined) {
          setError(destino, { type: 'server', message: mensaje });
          marcados += 1;
        }
      }
      if (marcados === 0) {
        setErrorGeneral(mensajeDeError(error, true));
      }
    }
  });

  return (
    <DialogoFormulario
      titulo="Crear material"
      descripcion={TEXTO_CODIGO_UNIDAD_FIJOS}
      textoConfirmar="Crear material"
      enviando={crear.isPending}
      error={errorGeneral}
      alEnviar={(evento) => void enviar(evento)}
      alCancelar={alCancelar}
    >
      <Campo
        etiqueta="Código"
        requerido
        autoComplete="off"
        spellCheck={false}
        placeholder="MP-010"
        error={errors.codigo?.message}
        {...register('codigo')}
      />
      <Campo
        etiqueta="Nombre"
        requerido
        autoComplete="off"
        error={errors.nombre?.message}
        {...register('nombre')}
      />
      <SelectCorto
        etiqueta="Unidad"
        requerido
        textoVacio="Seleccione…"
        opciones={OPCIONES_UNIDAD}
        error={errors.unidad?.message}
        {...register('unidad')}
      />
      <Campo
        etiqueta="Costo unitario (COP)"
        requerido
        inputMode="numeric"
        autoComplete="off"
        ayuda={ayudaCosto(costo)}
        error={errors.costo?.message}
        {...register('costo')}
      />
    </DialogoFormulario>
  );
}

// ---------------------------------------------------------------------------------------------
// Editar (nombre y costo)
// ---------------------------------------------------------------------------------------------

interface ValoresEditar {
  nombre: string;
  costo: string;
}

const esquemaEditar = z.object({
  nombre: crearMaterialSchema.shape.nombre,
  costo: costoSchema,
});

const resolverEditar = resolverDe<ValoresEditar>(esquemaEditar);

export interface PropsDialogoEditarMaterial {
  material: Material;
  alGuardar: (material: Material) => void;
  /** 409 `CONFLICTO`: otro admin cambió el material; la página recarga y lo explica. */
  alConflicto: () => void;
  alCancelar: () => void;
}

/** "Editar material": nombre y costo (`PATCH /materials/:id`). Código y unidad no se editan. */
export function DialogoEditarMaterial({
  material,
  alGuardar,
  alConflicto,
  alCancelar,
}: PropsDialogoEditarMaterial) {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ValoresEditar>({
    defaultValues: { nombre: material.nombre, costo: String(material.costo_unitario_cop) },
    resolver: resolverEditar,
  });
  const costo = useWatch({ control, name: 'costo' });
  const costoNuevo = parsearCostoCop(costo);
  const cambiaCosto = costoNuevo !== null && costoNuevo !== material.costo_unitario_cop;

  const guardar = useMutation({
    mutationFn: (valores: ValoresEditar) => {
      const costoEntero = Number(valores.costo);
      return apiAdmin.editarMaterial(material.id, {
        ...(valores.nombre !== material.nombre ? { nombre: valores.nombre } : {}),
        ...(costoEntero !== material.costo_unitario_cop ? { costo_unitario_cop: costoEntero } : {}),
      });
    },
  });

  const enviar = handleSubmit(async (valores) => {
    setErrorGeneral(null);
    if (
      valores.nombre === material.nombre &&
      Number(valores.costo) === material.costo_unitario_cop
    ) {
      setErrorGeneral('No hay cambios para guardar.');
      return;
    }
    try {
      alGuardar(await guardar.mutateAsync(valores));
    } catch (error) {
      if (esCodigo(error, 'CONFLICTO')) {
        alConflicto();
        return;
      }
      const porCampo = erroresDeCampo(error);
      if (porCampo.nombre !== undefined) {
        setError('nombre', { type: 'server', message: porCampo.nombre });
      } else if (porCampo.costo_unitario_cop !== undefined) {
        setError('costo', { type: 'server', message: porCampo.costo_unitario_cop });
      } else {
        setErrorGeneral(mensajeDeError(error, true));
      }
    }
  });

  return (
    <DialogoFormulario
      titulo={`Editar el material ${material.codigo}`}
      textoConfirmar="Guardar cambios"
      enviando={guardar.isPending}
      error={errorGeneral}
      alEnviar={(evento) => void enviar(evento)}
      alCancelar={alCancelar}
    >
      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-line-200 bg-surface-50 p-4">
        <div>
          <dt className="text-sm font-semibold text-ink-700">Código</dt>
          <dd className="text-base text-ink-950">{material.codigo}</dd>
        </div>
        <div>
          <dt className="text-sm font-semibold text-ink-700">Unidad</dt>
          <dd className="text-base text-ink-950">{NOMBRE_UNIDAD[material.unidad]}</dd>
        </div>
        <p className="col-span-2 text-sm text-ink-700">{TEXTO_CODIGO_UNIDAD_FIJOS}</p>
      </dl>
      <Campo
        etiqueta="Nombre"
        requerido
        autoComplete="off"
        error={errors.nombre?.message}
        {...register('nombre')}
      />
      <Campo
        etiqueta="Costo unitario (COP)"
        requerido
        inputMode="numeric"
        autoComplete="off"
        ayuda={ayudaCosto(costo)}
        error={errors.costo?.message}
        {...register('costo')}
      />
      <Aviso tono={cambiaCosto ? 'advertencia' : 'info'} titulo="Costo de los consumos registrados">
        {cambiaCosto && costoNuevo !== null && (
          <span className="cifras block font-semibold">
            {`El costo pasa de ${formatearCOP(material.costo_unitario_cop)} a ${formatearCOP(costoNuevo)}.`}
          </span>
        )}
        {TEXTO_COSTO_HISTORICO}
      </Aviso>
    </DialogoFormulario>
  );
}

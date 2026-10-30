import { zodResolver } from '@hookform/resolvers/zod';
import { UNIDADES, uuidv7, type Material } from '@catmetal/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch, type Control } from 'react-hook-form';
import { ErrorApi } from '../../auth';
import {
  Aviso,
  Boton,
  Campo,
  SelectBuscable,
  SelectCorto,
  Tarjeta,
  type OpcionBuscable,
} from '../../components/ui';
import { unidadesConvertibles } from '../consumos/reglas';
import { CLAVES_JEFE } from '../validacion/api';
import { mensajeDeError, reintentarConsulta } from '../validacion/mensajes';
import { crearOrden, listarMaterialesActivos } from './api';
import {
  aCuerpoOrden,
  campoDelError,
  esquemaFormulario,
  FILA_VACIA,
  type ValoresOrden,
} from './formulario-orden';

function FilaMaterialPlaneado({
  indice,
  control,
  materiales,
  ocupados,
  alQuitar,
  puedeQuitar,
  alElegirMaterial,
}: {
  indice: number;
  control: Control<ValoresOrden>;
  materiales: readonly Material[];
  ocupados: ReadonlySet<string>;
  alQuitar: () => void;
  puedeQuitar: boolean;
  alElegirMaterial: (material: Material) => void;
}) {
  const materialId = useWatch({ control, name: `materiales.${indice}.material_id` });
  const material = materiales.find((m) => m.id === materialId);
  const opciones: OpcionBuscable[] = materiales.map((m) => ({
    valor: m.id,
    etiqueta: m.nombre,
    secundario: m.codigo,
    deshabilitada: m.id !== materialId && ocupados.has(m.id),
  }));
  const unidades = material ? unidadesConvertibles(material.unidad) : [...UNIDADES];
  const numero = indice + 1;

  return (
    <li className="rounded-lg border border-line-200 p-4">
      <fieldset className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.8fr)] md:items-start">
        <legend className="mb-2 font-semibold text-ink-950">Material planeado {numero}</legend>
        <Controller
          control={control}
          name={`materiales.${indice}.material_id`}
          render={({ field, fieldState }) => (
            <SelectBuscable
              etiqueta={`Material ${numero}`}
              opciones={opciones}
              valor={field.value === '' ? null : field.value}
              alCambiar={(valor) => {
                field.onChange(valor);
                const elegido = materiales.find((m) => m.id === valor);
                if (elegido) {
                  alElegirMaterial(elegido);
                }
              }}
              alSalir={field.onBlur}
              error={fieldState.error?.message}
              requerido
            />
          )}
        />
        <Controller
          control={control}
          name={`materiales.${indice}.cantidad`}
          render={({ field, fieldState }) => (
            <Campo
              etiqueta={`Cantidad planeada ${numero}`}
              numerico
              requerido
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
              error={fieldState.error?.message}
            />
          )}
        />
        <Controller
          control={control}
          name={`materiales.${indice}.unidad`}
          render={({ field, fieldState }) => (
            <SelectCorto
              etiqueta={`Unidad ${numero}`}
              opciones={unidades.map((u) => ({ valor: u, etiqueta: u }))}
              requerido
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
              error={fieldState.error?.message}
              ayuda={material ? `Convertible con ${material.unidad}.` : undefined}
            />
          )}
        />
      </fieldset>
      {puedeQuitar && (
        <Boton variante="fantasma" className="mt-3" onClick={alQuitar}>
          Quitar material {numero}
        </Boton>
      )}
    </li>
  );
}

export interface PropsFormularioOrden {
  /** Recibe el id de la orden creada (o ya existente, si un envío anterior la creó). */
  alCrear: (id: string) => void;
  alCancelar: () => void;
}

/** "Nueva orden de producción": código OP-AAAA-NNNN, línea y materiales planeados (`POST /orders`). */
export function FormularioOrden({ alCrear, alCancelar }: PropsFormularioOrden) {
  const clienteQuery = useQueryClient();
  // Id de la orden generado una vez por formulario: reenviar tras un corte no la duplica.
  const [idOrden] = useState(uuidv7);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const materiales = useQuery({
    retry: reintentarConsulta,
    queryKey: CLAVES_JEFE.materiales,
    queryFn: ({ signal }) => listarMaterialesActivos(signal),
    staleTime: 5 * 60_000,
  });

  const { control, handleSubmit, setValue, setError, formState } = useForm<ValoresOrden>({
    resolver: zodResolver(esquemaFormulario),
    defaultValues: { codigo: '', linea: '', materiales: [FILA_VACIA] },
    mode: 'onTouched',
  });
  const filas = useFieldArray({ control, name: 'materiales' });
  const elegidos = useWatch({ control, name: 'materiales' });
  const ocupados = new Set(elegidos.map((m) => m.material_id).filter((id) => id !== ''));

  const creacion = useMutation({
    networkMode: 'always',
    mutationFn: (valores: ValoresOrden) => crearOrden(aCuerpoOrden(idOrden, valores)),
    onSuccess: (orden) => {
      void clienteQuery.invalidateQueries({ queryKey: CLAVES_JEFE.ordenes });
      alCrear(orden.id);
    },
    onError: (error) => {
      if (error instanceof ErrorApi) {
        if (error.code === 'ID_DUPLICADO') {
          // Un envío anterior ya la creó (se perdió la respuesta): se abre la orden existente.
          alCrear(idOrden);
          return;
        }
        const campos = campoDelError(error);
        for (const { campo, mensaje } of campos) {
          setError(campo, { type: 'server', message: mensaje }, { shouldFocus: true });
        }
        setErrorGeneral(campos.length > 0 ? 'Revise los campos marcados.' : error.message);
        return;
      }
      setErrorGeneral(mensajeDeError(error));
    },
  });

  return (
    <Tarjeta titulo="Datos de la orden" acento>
      <form
        noValidate
        aria-label="Datos de la orden"
        className="flex flex-col gap-6"
        onSubmit={(evento) => {
          setErrorGeneral(null);
          void handleSubmit((valores) => creacion.mutate(valores))(evento);
        }}
      >
        {errorGeneral !== null && (
          <Aviso tono="error" titulo="No se pudo crear la orden" anunciar>
            {errorGeneral}
          </Aviso>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Controller
            control={control}
            name="codigo"
            render={({ field, fieldState }) => (
              <Campo
                etiqueta="Código de la orden"
                ayuda="Formato OP-AAAA-NNNN, por ejemplo OP-2026-0587."
                placeholder="OP-2026-0587"
                autoComplete="off"
                autoCapitalize="characters"
                requerido
                name={field.name}
                value={field.value}
                onChange={(evento) => field.onChange(evento.target.value.toUpperCase())}
                onBlur={field.onBlur}
                ref={field.ref}
                error={fieldState.error?.message}
              />
            )}
          />
          <Controller
            control={control}
            name="linea"
            render={({ field, fieldState }) => (
              <Campo
                etiqueta="Línea de producción"
                placeholder="Moldeo 1"
                requerido
                maxLength={80}
                name={field.name}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                ref={field.ref}
                error={fieldState.error?.message}
              />
            )}
          />
        </div>

        <section aria-labelledby="titulo-materiales" className="flex flex-col gap-4">
          <h3 id="titulo-materiales" className="text-lg font-semibold text-ink-950">
            Materiales planeados
          </h3>
          {materiales.isError && (
            <Aviso
              tono="error"
              titulo="No se pudo cargar el catálogo de materiales"
              accion={
                <Boton variante="secundario" onClick={() => void materiales.refetch()}>
                  Reintentar
                </Boton>
              }
            >
              {mensajeDeError(materiales.error)}
            </Aviso>
          )}
          {materiales.isPending && (
            <p role="status" className="text-ink-500">
              Cargando materiales…
            </p>
          )}
          {formState.errors.materiales?.root?.message !== undefined && (
            <p role="alert" className="font-semibold text-danger-700">
              {formState.errors.materiales.root.message}
            </p>
          )}
          <ul aria-label="Materiales planeados" className="flex flex-col gap-4">
            {filas.fields.map((fila, indice) => (
              <FilaMaterialPlaneado
                key={fila.id}
                indice={indice}
                control={control}
                materiales={materiales.data ?? []}
                ocupados={ocupados}
                puedeQuitar={filas.fields.length > 1}
                alQuitar={() => filas.remove(indice)}
                alElegirMaterial={(material) =>
                  setValue(`materiales.${indice}.unidad`, material.unidad, {
                    shouldValidate: formState.isSubmitted,
                  })
                }
              />
            ))}
          </ul>
          {filas.fields.length < 50 && (
            <Boton variante="secundario" onClick={() => filas.append({ ...FILA_VACIA })}>
              Agregar material
            </Boton>
          )}
        </section>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Boton variante="secundario" tamano="grande" onClick={alCancelar}>
            Cancelar
          </Boton>
          <Boton
            type="submit"
            tamano="grande"
            cargando={creacion.isPending}
            textoCargando="Creando orden…"
          >
            Crear orden
          </Boton>
        </div>
      </form>
    </Tarjeta>
  );
}

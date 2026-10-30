import {
  cantidadSchema,
  crearConsumoSchema,
  crearNovedadSchema,
  formatearCantidad,
  parsearCantidad,
  TIPOS_NOVEDAD,
  UNIDADES,
  type TipoNovedad,
  type Unidad,
} from '@catmetal/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useController, useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import {
  Aviso,
  BloqueNovedad,
  Boton,
  Campo,
  Interruptor,
  SelectBuscable,
  SelectCorto,
  Tarjeta,
  type OpcionBuscable,
} from '../../components/ui';
import {
  editarConsumoLocal,
  ErrorDatosLocales,
  ErrorValidacionLocal,
  registrarConsumoConNovedadLocal,
  registrarConsumoLocal,
  registrarNovedadLocal,
  type ConsumoLocal,
  type MaterialLocal,
  type OrdenLocal,
  type PlaneadoVsConsumidoLocal,
} from '../../datos';
import { CamposNovedad } from './CamposNovedad';
import { evaluarNovedad, unidadesConvertibles, type EvaluacionNovedad } from './reglas';
import { useFotosEvidencia } from './useFotosEvidencia';

/** Qué hace el formulario: registrar, editar un pendiente (S4) o crear un consumo a partir de otro. */
export type ModoFormulario =
  | { tipo: 'nuevo' }
  | { tipo: 'editar'; consumo: ConsumoLocal; tieneNovedad: boolean }
  /** S3: consumo corregido de uno rechazado por el jefe (`corrige_a`). */
  | { tipo: 'corregir'; consumo: ConsumoLocal }
  /** El servidor rechazó la creación: se registra de nuevo con los datos precargados. */
  | { tipo: 'copiar'; consumo: ConsumoLocal };

export interface ValoresFormulario {
  material_id: string;
  cantidad: string;
  unidad: Unidad;
  lote: string;
  /** El usuario activó el interruptor (si la novedad es obligatoria, se activa sola). */
  novedad: boolean;
  tipo: TipoNovedad | '';
  descripcion: string;
}

const MENSAJE_CANTIDAD = 'Escriba una cantidad válida, con hasta 3 decimales (por ejemplo 125,5).';

/** Campos del consumo, adaptados del contrato de shared (`crearConsumoSchema`) al formulario. */
const esquemaConsumo = z.object({
  material_id: z.string().min(1, { error: 'Elija la materia prima.' }),
  cantidad: z.string().superRefine((texto, ctx) => {
    if (texto.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'Escriba la cantidad.' });
      return;
    }
    const numero = parsearCantidad(texto);
    if (numero === null) {
      ctx.addIssue({ code: 'custom', message: MENSAJE_CANTIDAD });
      return;
    }
    const resultado = cantidadSchema.safeParse(numero);
    if (!resultado.success) {
      ctx.addIssue({
        code: 'custom',
        message: resultado.error.issues[0]?.message ?? MENSAJE_CANTIDAD,
      });
    }
  }),
  unidad: z.enum(UNIDADES, { error: 'Elija la unidad.' }),
  lote: crearConsumoSchema.shape.lote,
});

/** Campos de la novedad (`crearNovedadSchema`), exigidos solo si la novedad está activa. */
const esquemaNovedad = z.object({
  tipo: z.enum(TIPOS_NOVEDAD, { error: 'Elija el tipo de novedad.' }),
  descripcion: crearNovedadSchema.shape.descripcion,
});

function aErrores(
  problemas: readonly { path: readonly PropertyKey[]; message: string }[],
): FieldErrors<ValoresFormulario> {
  const errores: Record<string, { type: string; message: string }> = {};
  for (const problema of problemas) {
    const campo = String(problema.path[0] ?? '');
    if (campo !== '' && errores[campo] === undefined) {
      errores[campo] = { type: 'validate', message: problema.message };
    }
  }
  return errores;
}

function valoresIniciales(modo: ModoFormulario): ValoresFormulario {
  if (modo.tipo === 'nuevo') {
    return {
      material_id: '',
      cantidad: '',
      unidad: 'kg',
      lote: '',
      novedad: false,
      tipo: '',
      descripcion: '',
    };
  }
  const c = modo.consumo;
  return {
    material_id: c.material_id,
    cantidad: formatearCantidad(c.cantidad),
    unidad: c.unidad,
    lote: c.lote,
    novedad: false,
    tipo: '',
    descripcion: '',
  };
}

const TITULOS: Readonly<Record<ModoFormulario['tipo'], string>> = {
  nuevo: 'Nuevo registro de material',
  editar: 'Editar registro pendiente',
  corregir: 'Corrección del consumo rechazado',
  copiar: 'Registrar de nuevo',
};

export type ResultadoGuardado = { modo: ModoFormulario['tipo']; conNovedad: boolean };

export interface PropsFormularioConsumo {
  userId: string;
  orden: OrdenLocal;
  avance: PlaneadoVsConsumidoLocal;
  materiales: ReadonlyMap<string, MaterialLocal>;
  modo: ModoFormulario;
  /** Se llama después de escribir en Dexie (la página avisa y programa la sincronización). */
  alGuardar: (resultado: ResultadoGuardado) => void;
  /** Error al guardar en la tablet (mensaje ya en español). */
  alFallar: (mensaje: string) => void;
  alCancelar?: () => void;
}

function mensajeError(error: unknown): string {
  if (error instanceof ErrorValidacionLocal) {
    const detalle = error.detalles[0];
    return detalle ? detalle.mensaje : error.message;
  }
  if (error instanceof ErrorDatosLocales) {
    return error.message;
  }
  return 'Ocurrió un error inesperado al guardar en esta tablet. Intente de nuevo.';
}

/**
 * "Nuevo registro de material" (Figma, columna izquierda). Todo se escribe primero en esta tablet
 * (Dexie + outbox): guardar nunca espera al servidor ni falla por falta de señal.
 */
export function FormularioConsumo({
  userId,
  orden,
  avance,
  materiales,
  modo,
  alGuardar,
  alFallar,
  alCancelar,
}: PropsFormularioConsumo) {
  const idFormulario = `formulario-consumo-${modo.tipo}`;
  const idMaterial = `${idFormulario}-material`;
  const fotos = useFotosEvidencia();
  const [guardando, setGuardando] = useState(false);

  // El consumo que se edita no se cuenta dos veces en el acumulado.
  const excluir = modo.tipo === 'editar' ? modo.consumo : undefined;
  const pideNovedad = !(modo.tipo === 'editar' && modo.tieneNovedad);

  // El resolver lee el avance más reciente (Dexie en vivo) sin recrearse.
  const refContexto = useRef({ avance, excluir, pideNovedad });
  useEffect(() => {
    refContexto.current = { avance, excluir, pideNovedad };
  }, [avance, excluir, pideNovedad]);

  const resolver = useMemo<Resolver<ValoresFormulario>>(
    () => (valores) => {
      const contexto = refContexto.current;
      const problemas = [...(esquemaConsumo.safeParse(valores).error?.issues ?? [])];
      const evaluacion = evaluarNovedad(
        contexto.avance,
        {
          material_id: valores.material_id || null,
          cantidad: parsearCantidad(valores.cantidad),
          unidad: valores.unidad,
        },
        contexto.excluir,
      );
      if (contexto.pideNovedad && (valores.novedad || evaluacion.obligatoria)) {
        problemas.push(...(esquemaNovedad.safeParse(valores).error?.issues ?? []));
      }
      return problemas.length === 0
        ? { values: valores, errors: {} }
        : { values: {}, errors: aErrores(problemas) };
    },
    [],
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<ValoresFormulario>({
    defaultValues: valoresIniciales(modo),
    resolver,
  });
  const campoMaterial = useController({ control, name: 'material_id' });
  const campoTipo = useController({ control, name: 'tipo' });
  const campoDescripcion = useController({ control, name: 'descripcion' });
  const [materialId, cantidadTexto, unidad, novedadElegida] = useWatch({
    control,
    name: ['material_id', 'cantidad', 'unidad', 'novedad'],
  });

  // Al abrir una edición o corrección, el foco va al primer campo (el usuario llegó desde un diálogo).
  useEffect(() => {
    if (modo.tipo !== 'nuevo') {
      document.getElementById(idMaterial)?.focus();
    }
  }, [modo.tipo, idMaterial]);

  const material = materiales.get(materialId) ?? null;
  const cantidad = parsearCantidad(cantidadTexto);
  const evaluacion: EvaluacionNovedad = evaluarNovedad(
    avance,
    { material_id: materialId || null, cantidad, unidad },
    excluir,
  );
  const referencia: Unidad | null = evaluacion.plan?.unidad ?? material?.unidad ?? null;
  const unidades = referencia === null ? [...UNIDADES] : unidadesConvertibles(referencia);
  const novedadActiva = pideNovedad && (evaluacion.obligatoria || novedadElegida);

  const opcionesMaterial: OpcionBuscable[] = [...materiales.values()]
    .filter((m) => m.activo || m.id === materialId)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    .map((m) => ({ valor: m.id, etiqueta: m.nombre, secundario: `${m.codigo} — ${m.unidad}` }));

  function elegirMaterial(id: string) {
    campoMaterial.field.onChange(id);
    const elegido = materiales.get(id);
    const plan = avance.materiales.find((m) => m.material_id === id);
    const nuevaReferencia = plan?.unidad ?? elegido?.unidad;
    if (nuevaReferencia !== undefined && !unidadesConvertibles(nuevaReferencia).includes(unidad)) {
      setValue('unidad', nuevaReferencia);
    }
  }

  async function guardar(valores: ValoresFormulario) {
    const cantidadFinal = parsearCantidad(valores.cantidad);
    if (cantidadFinal === null) {
      return;
    }
    const conNovedad = novedadActiva;
    const novedad = { tipo: valores.tipo as TipoNovedad, descripcion: valores.descripcion };
    const blobs = fotos.fotos.map((foto) => foto.blob);
    setGuardando(true);
    try {
      if (modo.tipo === 'editar') {
        const c = modo.consumo;
        const cambios = {
          ...(valores.material_id !== c.material_id ? { material_id: valores.material_id } : {}),
          ...(cantidadFinal !== c.cantidad ? { cantidad: cantidadFinal } : {}),
          ...(valores.unidad !== c.unidad ? { unidad: valores.unidad } : {}),
          ...(valores.lote.trim() !== c.lote ? { lote: valores.lote } : {}),
        };
        if (Object.keys(cambios).length === 0 && !conNovedad) {
          alFallar('No hay cambios para guardar.');
          return;
        }
        if (Object.keys(cambios).length > 0) {
          await editarConsumoLocal(userId, { id: c.id, ...cambios });
        }
        if (conNovedad) {
          await registrarNovedadLocal(userId, { consumption_id: c.id, ...novedad }, blobs);
        }
      } else {
        const entrada = {
          order_id: orden.id,
          material_id: valores.material_id,
          cantidad: cantidadFinal,
          unidad: valores.unidad,
          lote: valores.lote,
          ...(modo.tipo === 'corregir' ? { corrige_a: modo.consumo.id } : {}),
        };
        if (conNovedad) {
          await registrarConsumoConNovedadLocal(userId, entrada, novedad, blobs);
        } else {
          await registrarConsumoLocal(userId, entrada);
        }
      }
      reset(valoresIniciales({ tipo: 'nuevo' }));
      fotos.limpiar();
      alGuardar({ modo: modo.tipo, conNovedad });
      document.getElementById(idMaterial)?.focus();
    } catch (error) {
      alFallar(mensajeError(error));
    } finally {
      setGuardando(false);
    }
  }

  const plan = evaluacion.plan;
  const ayudaCantidad = [
    cantidad !== null && !errors.cantidad
      ? `Se registrará: ${formatearCantidad(cantidad)} ${unidad}`
      : null,
    plan
      ? `Plan: ${formatearCantidad(plan.planeada)} ${plan.unidad} · llevado en esta tablet: ${formatearCantidad(plan.consumido)} ${plan.unidad} · límite con tolerancia (${formatearCantidad(plan.toleranciaPct)} %): ${formatearCantidad(plan.limite)} ${plan.unidad}`
      : null,
  ].filter((texto): texto is string => texto !== null);

  return (
    <Tarjeta
      titulo={TITULOS[modo.tipo]}
      acento
      pie={
        <div className="flex flex-col gap-3">
          <Boton
            type="submit"
            form={idFormulario}
            tamano="grande"
            anchoCompleto
            cargando={guardando || fotos.procesando}
            textoCargando={fotos.procesando ? 'Procesando foto…' : 'Guardando registro…'}
          >
            {modo.tipo === 'editar'
              ? 'Guardar cambios (se sincroniza al recuperar señal)'
              : 'Guardar registro (se sincroniza al recuperar señal)'}
          </Boton>
          {alCancelar && (
            <Boton variante="secundario" anchoCompleto onClick={alCancelar}>
              Cancelar
            </Boton>
          )}
        </div>
      }
    >
      <form
        id={idFormulario}
        noValidate
        onSubmit={(evento) => void handleSubmit(guardar)(evento)}
        className="flex flex-col gap-5"
      >
        {modo.tipo === 'corregir' && (
          <Aviso tono="info" titulo="Corrige un consumo rechazado">
            El registro nuevo quedará enlazado al rechazado. El rechazado no se modifica.
          </Aviso>
        )}
        {modo.tipo === 'editar' && (
          <Aviso tono="info" titulo="Editar un registro pendiente">
            El cambio queda en la auditoría. Si el jefe ya lo validó, el servidor no aceptará la
            edición.
          </Aviso>
        )}
        {orden.estado !== 'en_proceso' && (
          <Aviso tono="advertencia" titulo="La orden no está en proceso">
            El registro se guardará igual y el servidor lo marcará como tardío para que el jefe lo
            revise.
          </Aviso>
        )}

        <SelectBuscable
          id={idMaterial}
          etiqueta="Materia prima"
          requerido
          opciones={opcionesMaterial}
          valor={materialId || null}
          alCambiar={elegirMaterial}
          alSalir={campoMaterial.field.onBlur}
          error={errors.material_id?.message}
          placeholder="Busque por nombre o código"
          textoSinResultados="Ningún material activo coincide"
        />

        <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-4">
          <Campo
            etiqueta="Cantidad utilizada"
            numerico
            requerido
            sufijo={unidad}
            ayuda={ayudaCantidad.length > 0 ? ayudaCantidad.join('. ') : undefined}
            error={errors.cantidad?.message}
            {...register('cantidad')}
          />
          <SelectCorto
            etiqueta="Unidad"
            requerido
            opciones={unidades.map((u) => ({ valor: u, etiqueta: u }))}
            ayuda={referencia ? `Convertible a ${referencia}` : undefined}
            error={errors.unidad?.message}
            {...register('unidad')}
          />
        </div>

        <Campo
          etiqueta="Lote"
          requerido
          autoComplete="off"
          maxLength={64}
          error={errors.lote?.message}
          {...register('lote')}
        />

        {pideNovedad ? (
          <BloqueNovedad
            titulo={
              <Interruptor
                etiqueta="¿Hay una novedad en este consumo?"
                activado={novedadActiva}
                alCambiar={(valor) => setValue('novedad', valor)}
                bloqueado={evaluacion.obligatoria}
                motivoBloqueo={evaluacion.motivo ?? undefined}
              />
            }
          >
            {novedadActiva && (
              <CamposNovedad
                tipo={campoTipo.field.value}
                alCambiarTipo={campoTipo.field.onChange}
                descripcion={campoDescripcion.field.value}
                alCambiarDescripcion={campoDescripcion.field.onChange}
                errorTipo={errors.tipo?.message}
                errorDescripcion={errors.descripcion?.message}
                fotos={fotos}
              />
            )}
          </BloqueNovedad>
        ) : (
          <p className="text-ink-700">Este consumo ya tiene una novedad registrada.</p>
        )}
      </form>
    </Tarjeta>
  );
}

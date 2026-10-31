import { crearNovedadSchema, TIPOS_NOVEDAD, type TipoNovedad } from '@catmetal/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Boton, CapaModal } from '../../components/ui';
import { ErrorDatosLocales, registrarNovedadLocal, type ConsumoLocal } from '../../datos';
import { CamposNovedad } from './CamposNovedad';
import { useFotosEvidencia } from './useFotosEvidencia';

const esquema = z.object({
  tipo: z.enum(TIPOS_NOVEDAD, { error: 'Elija el tipo de novedad.' }),
  descripcion: crearNovedadSchema.shape.descripcion,
});

export interface PropsDialogoNovedad {
  userId: string;
  /** Consumo al que le falta la novedad (`null` = cerrado). */
  consumo: ConsumoLocal | null;
  nombreMaterial: string;
  alGuardar: () => void;
  alFallar: (mensaje: string) => void;
  alCerrar: () => void;
}

/** "Justificar novedad" de un consumo que el servidor marcó con `requiere_novedad` (S7). */
export function DialogoNovedad(props: PropsDialogoNovedad) {
  if (props.consumo === null) {
    return null;
  }
  return <Contenido {...props} consumo={props.consumo} />;
}

function Contenido({
  userId,
  consumo,
  nombreMaterial,
  alGuardar,
  alFallar,
  alCerrar,
}: PropsDialogoNovedad & { consumo: ConsumoLocal }) {
  const idTitulo = useId();
  const refInicio = useRef<HTMLHeadingElement>(null);
  const fotos = useFotosEvidencia();
  const [tipo, setTipo] = useState<TipoNovedad | ''>('');
  const [descripcion, setDescripcion] = useState('');
  const [errores, setErrores] = useState<{ tipo?: string; descripcion?: string }>({});
  const [guardando, setGuardando] = useState(false);
  const refFormulario = useRef<HTMLFormElement>(null);
  /** Envíos rechazados por validación: cada uno lleva el foco al primer campo con error. */
  const [intentosFallidos, setIntentosFallidos] = useState(0);

  useEffect(() => {
    if (intentosFallidos > 0) {
      refFormulario.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [intentosFallidos]);

  async function guardar(evento: FormEvent) {
    evento.preventDefault();
    const resultado = esquema.safeParse({ tipo, descripcion });
    if (!resultado.success) {
      const nuevos: typeof errores = {};
      for (const problema of resultado.error.issues) {
        const campo = problema.path[0];
        if ((campo === 'tipo' || campo === 'descripcion') && nuevos[campo] === undefined) {
          nuevos[campo] = problema.message;
        }
      }
      setErrores(nuevos);
      setIntentosFallidos((n) => n + 1);
      return;
    }
    setErrores({});
    setGuardando(true);
    try {
      await registrarNovedadLocal(
        userId,
        { consumption_id: consumo.id, ...resultado.data },
        fotos.fotos.map((foto) => foto.blob),
      );
      fotos.limpiar();
      alGuardar();
    } catch (error) {
      alFallar(
        error instanceof ErrorDatosLocales
          ? error.message
          : 'No se pudo guardar la novedad en esta tablet. Intente de nuevo.',
      );
    } finally {
      setGuardando(false);
    }
  }

  return (
    <CapaModal
      abierto
      alCerrar={alCerrar}
      idTitulo={idTitulo}
      refFocoInicial={refInicio}
      className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
    >
      <h2 id={idTitulo} ref={refInicio} tabIndex={-1} className="text-xl font-bold text-ink-950">
        Justificar novedad
      </h2>
      <p className="mt-2 text-ink-700">
        {nombreMaterial}: el consumo supera lo planeado más la tolerancia. El jefe no puede
        validarlo hasta que tenga una novedad.
      </p>
      <form
        ref={refFormulario}
        noValidate
        onSubmit={(evento) => void guardar(evento)}
        className="mt-6 flex flex-col gap-5"
      >
        <CamposNovedad
          tipo={tipo}
          alCambiarTipo={setTipo}
          descripcion={descripcion}
          alCambiarDescripcion={setDescripcion}
          errorTipo={errores.tipo}
          errorDescripcion={errores.descripcion}
          fotos={fotos}
        />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Boton variante="secundario" tamano="grande" onClick={alCerrar}>
            Cancelar
          </Boton>
          <Boton
            type="submit"
            tamano="grande"
            cargando={guardando || fotos.procesando}
            textoCargando={fotos.procesando ? 'Procesando foto…' : 'Guardando…'}
          >
            Guardar novedad
          </Boton>
        </div>
      </form>
    </CapaModal>
  );
}

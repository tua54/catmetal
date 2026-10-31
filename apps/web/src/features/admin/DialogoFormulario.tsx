import { useId, type FormEventHandler, type ReactNode } from 'react';
import { Aviso, Boton, CapaModal } from '../../components/ui';

export interface PropsDialogoFormulario {
  titulo: string;
  /** Texto bajo el título (consecuencias de la acción). */
  descripcion?: ReactNode;
  /** Error general del envío (no de un campo). Se anuncia con `role="alert"`. */
  error?: string | null;
  textoConfirmar: string;
  /** `peligro` cuando la acción corta el acceso de alguien (restablecer contraseña). */
  tono?: 'primario' | 'peligro';
  enviando: boolean;
  alEnviar: FormEventHandler<HTMLFormElement>;
  alCancelar: () => void;
  children: ReactNode;
}

/**
 * Diálogo modal con un formulario (crear y editar). El foco inicial va al primer campo; Escape y
 * "Cancelar" cierran sin guardar (no se cierra mientras se envía).
 */
export function DialogoFormulario({
  titulo,
  descripcion,
  error,
  textoConfirmar,
  tono = 'primario',
  enviando,
  alEnviar,
  alCancelar,
  children,
}: PropsDialogoFormulario) {
  const idTitulo = useId();
  const idDescripcion = useId();

  function cancelar() {
    if (!enviando) {
      alCancelar();
    }
  }

  return (
    <CapaModal
      abierto
      alCerrar={cancelar}
      idTitulo={idTitulo}
      idDescripcion={descripcion ? idDescripcion : undefined}
      className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
    >
      <h2 id={idTitulo} className="text-xl font-bold text-ink-950">
        {titulo}
      </h2>
      {descripcion && (
        <div id={idDescripcion} className="mt-2 text-base text-ink-700">
          {descripcion}
        </div>
      )}
      <form noValidate className="mt-6 flex flex-col gap-5" onSubmit={alEnviar}>
        {children}
        {error && (
          <Aviso tono="error" anunciar titulo="No se guardó">
            {error}
          </Aviso>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Boton variante="secundario" tamano="grande" onClick={cancelar} disabled={enviando}>
            Cancelar
          </Boton>
          <Boton
            type="submit"
            variante={tono === 'peligro' ? 'peligroRelleno' : 'primario'}
            tamano="grande"
            cargando={enviando}
            textoCargando="Guardando…"
          >
            {textoConfirmar}
          </Boton>
        </div>
      </form>
    </CapaModal>
  );
}

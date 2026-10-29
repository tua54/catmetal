import { useId, useRef, useState, type ReactNode } from 'react';
import { Boton, type VarianteBoton } from './Boton';
import { AreaTexto } from './Campo';
import { CapaModal } from './CapaModal';

export interface ConfigMotivo {
  /** Etiqueta del campo (por defecto "Motivo"). */
  etiqueta?: string;
  ayuda?: string;
  /** Mínimo de caracteres sin espacios al inicio/final (por defecto 3, como el esquema de rechazo). */
  minimo?: number;
  /** Máximo de caracteres (por defecto 500, como el esquema de rechazo). */
  maximo?: number;
  placeholder?: string;
}

export interface PropsDialogoConfirmacion {
  abierto: boolean;
  titulo: string;
  /** Explicación de la consecuencia de la acción. */
  descripcion?: ReactNode;
  /** Contenido adicional (p. ej. el resumen del consumo). */
  children?: ReactNode;
  textoConfirmar: string;
  textoCancelar?: string;
  /** `peligro` para acciones destructivas (botón rojo relleno), `exito` para "Validar gasto". */
  tono?: 'primario' | 'exito' | 'peligro';
  /** Muestra el botón de confirmar en estado cargando. */
  cargando?: boolean;
  /**
   * Si se pasa, el diálogo pide un motivo obligatorio (p. ej. "Rechazar") y lo entrega recortado
   * en `alConfirmar`. No confirma mientras el motivo no cumpla el mínimo.
   */
  motivo?: ConfigMotivo;
  alConfirmar: (motivo?: string) => void;
  alCancelar: () => void;
}

const VARIANTE_TONO: Record<NonNullable<PropsDialogoConfirmacion['tono']>, VarianteBoton> = {
  primario: 'primario',
  exito: 'exito',
  peligro: 'peligroRelleno',
};

/**
 * Diálogo de confirmación (`alertdialog`). El foco inicial va al campo de motivo si existe; si no,
 * a "Cancelar" (la opción menos destructiva). Escape cancela y el foco vuelve al disparador.
 */
export function DialogoConfirmacion(props: PropsDialogoConfirmacion) {
  if (!props.abierto) {
    return null;
  }
  // El contenido se monta al abrir, así el motivo y su error empiezan vacíos cada vez.
  return <ContenidoDialogo {...props} />;
}

function ContenidoDialogo({
  titulo,
  descripcion,
  children,
  textoConfirmar,
  textoCancelar = 'Cancelar',
  tono = 'primario',
  cargando = false,
  motivo,
  alConfirmar,
  alCancelar,
}: PropsDialogoConfirmacion) {
  const idTitulo = useId();
  const idDescripcion = useId();
  const refMotivo = useRef<HTMLTextAreaElement>(null);
  const refCancelar = useRef<HTMLButtonElement>(null);
  const [textoMotivo, setTextoMotivo] = useState('');
  const [errorMotivo, setErrorMotivo] = useState<string | null>(null);

  const minimo = motivo?.minimo ?? 3;
  const maximo = motivo?.maximo ?? 500;

  function confirmar() {
    if (cargando) {
      return;
    }
    if (!motivo) {
      alConfirmar();
      return;
    }
    const recortado = textoMotivo.trim();
    if (recortado.length < minimo) {
      setErrorMotivo(
        recortado.length === 0
          ? `${motivo.etiqueta ?? 'El motivo'} es obligatorio.`
          : `Escriba al menos ${minimo} caracteres.`,
      );
      refMotivo.current?.focus();
      return;
    }
    alConfirmar(recortado);
  }

  return (
    <CapaModal
      abierto
      alCerrar={alCancelar}
      idTitulo={idTitulo}
      idDescripcion={descripcion ? idDescripcion : undefined}
      rol="alertdialog"
      refFocoInicial={motivo ? refMotivo : refCancelar}
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
      {children && <div className="mt-4">{children}</div>}

      <form
        noValidate
        className="mt-6 flex flex-col gap-6"
        onSubmit={(evento) => {
          evento.preventDefault();
          confirmar();
        }}
      >
        {motivo && (
          <AreaTexto
            ref={refMotivo}
            etiqueta={motivo.etiqueta ?? 'Motivo'}
            ayuda={motivo.ayuda}
            placeholder={motivo.placeholder}
            requerido
            maxLength={maximo}
            mostrarContador
            value={textoMotivo}
            error={errorMotivo ?? undefined}
            onChange={(evento) => {
              setTextoMotivo(evento.target.value);
              if (errorMotivo && evento.target.value.trim().length >= minimo) {
                setErrorMotivo(null);
              }
            }}
          />
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Boton ref={refCancelar} variante="secundario" tamano="grande" onClick={alCancelar}>
            {textoCancelar}
          </Boton>
          <Boton type="submit" variante={VARIANTE_TONO[tono]} tamano="grande" cargando={cargando}>
            {textoConfirmar}
          </Boton>
        </div>
      </form>
    </CapaModal>
  );
}

import { useId, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import { clasesControl, cx, unirIds } from './clases';
import { EnvolturaCampo } from './EnvolturaCampo';
import { IconoChevronAbajo } from './iconos';

export interface OpcionSelectCorto {
  valor: string;
  etiqueta: string;
}

export interface PropsSelectCorto extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'required' | 'children'
> {
  etiqueta: ReactNode;
  opciones: readonly OpcionSelectCorto[];
  /** Primera opción vacía (p. ej. "Seleccione…"). Si se omite, no hay opción vacía. */
  textoVacio?: string;
  ayuda?: ReactNode;
  error?: ReactNode;
  requerido?: boolean;
  etiquetaOculta?: boolean;
  className?: string;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * Select nativo estilizado para listas cortas (unidad, tipo de novedad). El nativo da el mejor
 * selector táctil en tablets y es accesible sin ARIA adicional.
 */
export function SelectCorto({
  etiqueta,
  opciones,
  textoVacio,
  ayuda,
  error,
  requerido,
  etiquetaOculta,
  className,
  id,
  'aria-describedby': describedBy,
  ref,
  ...props
}: PropsSelectCorto) {
  const idGenerado = useId();
  const idControl = id ?? `select-${idGenerado}`;
  const idAyuda = `${idControl}-ayuda`;
  const idError = `${idControl}-error`;
  const conError = Boolean(error);

  return (
    <EnvolturaCampo
      idControl={idControl}
      idAyuda={idAyuda}
      idError={idError}
      etiqueta={etiqueta}
      ayuda={ayuda}
      error={error}
      requerido={requerido}
      etiquetaOculta={etiquetaOculta}
      className={className}
    >
      <div className="relative">
        <select
          ref={ref}
          id={idControl}
          required={requerido}
          aria-invalid={conError ? true : undefined}
          aria-describedby={unirIds(describedBy, ayuda && idAyuda, conError && idError)}
          className={cx(clasesControl(conError), 'min-h-12 appearance-none py-2 pr-11')}
          {...props}
        >
          {textoVacio !== undefined && <option value="">{textoVacio}</option>}
          {opciones.map((opcion) => (
            <option key={opcion.valor} value={opcion.valor}>
              {opcion.etiqueta}
            </option>
          ))}
        </select>
        <IconoChevronAbajo className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-ink-700" />
      </div>
    </EnvolturaCampo>
  );
}

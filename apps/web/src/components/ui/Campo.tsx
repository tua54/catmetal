import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { clasesControl, cx, unirIds } from './clases';
import { EnvolturaCampo } from './EnvolturaCampo';

interface PropsComunes {
  /** Etiqueta visible, asociada con `<label for>`. */
  etiqueta: ReactNode;
  /** Texto de ayuda bajo el control (enlazado con `aria-describedby`). */
  ayuda?: ReactNode;
  /** Mensaje de error: activa `aria-invalid` y se enlaza con `aria-describedby`. */
  error?: ReactNode;
  /** Marca el campo como obligatorio (asterisco visible + texto para lectores de pantalla). */
  requerido?: boolean;
  etiquetaOculta?: boolean;
  /** Clases del contenedor (no del control). */
  className?: string;
}

export interface PropsCampo
  extends PropsComunes, Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'required'> {
  /**
   * Variante numérica para cantidades: `inputMode="decimal"` (teclado numérico con coma o punto),
   * cifras tabulares y `type="text"` para no perder la coma decimal (se interpreta con
   * `parsearCantidad` de @catmetal/shared).
   */
  numerico?: boolean;
  /** Texto fijo a la derecha del control (p. ej. la unidad "kg"). Decorativo. */
  sufijo?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** Campo de texto con etiqueta, ayuda y error accesibles. Compatible con `register` de react-hook-form. */
export function Campo({
  etiqueta,
  ayuda,
  error,
  requerido,
  etiquetaOculta,
  className,
  numerico = false,
  sufijo,
  id,
  type = 'text',
  'aria-describedby': describedBy,
  ref,
  ...props
}: PropsCampo) {
  const idGenerado = useId();
  const idControl = id ?? `campo-${idGenerado}`;
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
        <input
          ref={ref}
          id={idControl}
          type={numerico ? 'text' : type}
          inputMode={numerico ? 'decimal' : props.inputMode}
          autoComplete={numerico ? 'off' : props.autoComplete}
          required={requerido}
          aria-required={requerido ? true : undefined}
          aria-invalid={conError ? true : undefined}
          aria-describedby={unirIds(describedBy, ayuda && idAyuda, conError && idError)}
          className={cx(
            clasesControl(conError),
            'min-h-12 py-2',
            numerico && 'cifras text-lg',
            sufijo ? 'pr-14' : undefined,
          )}
          {...props}
        />
        {sufijo && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-base font-medium text-ink-500"
          >
            {sufijo}
          </span>
        )}
      </div>
    </EnvolturaCampo>
  );
}

export interface PropsAreaTexto
  extends
    PropsComunes,
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'required'> {
  /** Muestra "N/máx caracteres" si se pasa `maxLength` y el valor es controlado. */
  mostrarContador?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Área de texto (justificaciones, motivos) con la misma estructura accesible que `Campo`. */
export function AreaTexto({
  etiqueta,
  ayuda,
  error,
  requerido,
  etiquetaOculta,
  className,
  mostrarContador = false,
  id,
  rows = 3,
  'aria-describedby': describedBy,
  ref,
  ...props
}: PropsAreaTexto) {
  const idGenerado = useId();
  const idControl = id ?? `area-${idGenerado}`;
  const idAyuda = `${idControl}-ayuda`;
  const idError = `${idControl}-error`;
  const idContador = `${idControl}-contador`;
  const conError = Boolean(error);
  const longitud = typeof props.value === 'string' ? props.value.length : null;
  const conContador = mostrarContador && props.maxLength !== undefined && longitud !== null;

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
      <textarea
        ref={ref}
        id={idControl}
        rows={rows}
        required={requerido}
        aria-required={requerido ? true : undefined}
        aria-invalid={conError ? true : undefined}
        aria-describedby={unirIds(
          describedBy,
          ayuda && idAyuda,
          conError && idError,
          conContador && idContador,
        )}
        className={cx(clasesControl(conError), 'min-h-24 resize-y py-3 leading-relaxed')}
        {...props}
      />
      {conContador && (
        <p id={idContador} className="cifras self-end text-sm text-ink-700">
          {longitud}/{props.maxLength} caracteres
        </p>
      )}
    </EnvolturaCampo>
  );
}

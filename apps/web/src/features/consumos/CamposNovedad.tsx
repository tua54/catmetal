import { TIPOS_NOVEDAD, type TipoNovedad } from '@catmetal/shared';
import { useId, type ChangeEvent } from 'react';
import { AreaTexto, IconoClip, IconoX, SelectCorto } from '../../components/ui';
import { ETIQUETAS_TIPO_NOVEDAD } from './reglas';
import { MAX_FOTOS } from './fotos';
import type { EstadoFotos } from './useFotosEvidencia';

export const MAX_DESCRIPCION_NOVEDAD = 2000;

const OPCIONES_TIPO = TIPOS_NOVEDAD.map((tipo) => ({
  valor: tipo,
  etiqueta: ETIQUETAS_TIPO_NOVEDAD[tipo],
}));

export interface PropsCamposNovedad {
  tipo: TipoNovedad | '';
  alCambiarTipo: (tipo: TipoNovedad | '') => void;
  descripcion: string;
  alCambiarDescripcion: (descripcion: string) => void;
  errorTipo?: string;
  errorDescripcion?: string;
  fotos: EstadoFotos;
}

function textoFotos(cantidad: number): string {
  if (cantidad === 0) {
    return 'Sin fotos adjuntas';
  }
  return cantidad === 1 ? '1 foto adjunta' : `${cantidad} fotos adjuntas`;
}

/**
 * Campos de la novedad (tipo, justificación y fotos). Las fotos se toman con la cámara trasera o se
 * eligen de la galería; se recomprimen a JPEG sin metadatos antes de guardarlas.
 */
export function CamposNovedad({
  tipo,
  alCambiarTipo,
  descripcion,
  alCambiarDescripcion,
  errorTipo,
  errorDescripcion,
  fotos,
}: PropsCamposNovedad) {
  const idEstadoFotos = useId();
  const lleno = fotos.fotos.length >= MAX_FOTOS;

  function alElegir(evento: ChangeEvent<HTMLInputElement>) {
    const archivos = Array.from(evento.target.files ?? []);
    // Se vacía para que elegir la misma foto otra vez vuelva a disparar `change`.
    evento.target.value = '';
    if (archivos.length > 0) {
      void fotos.agregar(archivos);
    }
  }

  return (
    <>
      <SelectCorto
        etiqueta="Tipo de novedad"
        requerido
        opciones={OPCIONES_TIPO}
        textoVacio="Seleccione…"
        value={tipo}
        error={errorTipo}
        onChange={(evento) => alCambiarTipo(evento.target.value as TipoNovedad | '')}
      />
      <AreaTexto
        etiqueta="Justificación"
        requerido
        ayuda="Explique qué pasó (por ejemplo: reproceso por sellado defectuoso en el lote anterior)."
        maxLength={MAX_DESCRIPCION_NOVEDAD}
        mostrarContador
        value={descripcion}
        error={errorDescripcion}
        onChange={(evento) => alCambiarDescripcion(evento.target.value)}
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* El input es el control (enfocable con teclado); la etiqueta lo presenta como botón. */}
          <label
            className={
              lleno || fotos.procesando
                ? 'inline-flex min-h-11 cursor-not-allowed items-center gap-2 rounded-lg border border-line-200 bg-surface-200 px-5 py-2 font-semibold text-ink-500'
                : 'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-ink-400 bg-white px-5 py-2 font-semibold text-ink-700 active:bg-surface-200 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500'
            }
          >
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              disabled={lleno || fotos.procesando}
              aria-describedby={idEstadoFotos}
              onChange={alElegir}
              className="sr-only"
            />
            <IconoClip className="size-5" />
            Adjuntar evidencia
          </label>
          <span id={idEstadoFotos} role="status" className="text-sm font-medium text-ink-700">
            {fotos.procesando ? 'Procesando foto…' : textoFotos(fotos.fotos.length)}
            {lleno && ` (máximo ${MAX_FOTOS})`}
          </span>
        </div>
        {fotos.error && (
          <p role="alert" className="text-sm font-medium text-danger-700">
            {fotos.error}
          </p>
        )}
        {fotos.fotos.length > 0 && (
          <ul aria-label="Fotos adjuntas" className="flex flex-wrap gap-3">
            {fotos.fotos.map((foto, indice) => (
              <li key={foto.id} className="relative">
                {foto.url ? (
                  <img
                    src={foto.url}
                    alt={`Foto ${indice + 1} de la evidencia`}
                    className="size-20 rounded-lg border border-ink-400 object-cover"
                  />
                ) : (
                  <span className="flex size-20 items-center justify-center rounded-lg border border-ink-400 bg-white text-sm text-ink-700">
                    Foto {indice + 1}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => fotos.quitar(foto.id)}
                  aria-label={`Quitar foto ${indice + 1}`}
                  className="absolute -top-3 -right-3 inline-flex size-11 items-center justify-center rounded-full border border-ink-400 bg-white text-ink-700 shadow-sm active:bg-surface-200"
                >
                  <IconoX className="size-5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

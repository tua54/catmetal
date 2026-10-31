import { useId, useRef, useState } from 'react';
import { cx } from './clases';
import { CapaModal } from './CapaModal';
import { IconoAmpliar, IconoX } from './iconos';

export interface PropsVisorImagen {
  abierto: boolean;
  /** URL de la imagen; admite `blob:` (evidencia guardada en el dispositivo) y rutas del mismo origen. */
  src: string;
  /** Texto alternativo que describe la evidencia. */
  alt: string;
  /** Título visible, p. ej. el nombre del archivo "evidencia_sellado_4471.jpg". */
  titulo: string;
  alCerrar: () => void;
}

const BOTON_OSCURO =
  'inline-flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-lg border border-white/30 px-4 text-base font-semibold text-white active:bg-white/25';

/**
 * Visor de evidencias a pantalla completa. "Ampliar" (botón de alternar con `aria-pressed`) cambia
 * entre ajustar a la pantalla y ver al doble de tamaño con desplazamiento táctil; "Cerrar" (56 px)
 * y Escape cierran y devuelven el foco al disparador.
 */
export function VisorImagen(props: PropsVisorImagen) {
  if (!props.abierto) {
    return null;
  }
  // Se monta al abrir: cada apertura empieza ajustada a la pantalla.
  return <ContenidoVisor {...props} />;
}

function ContenidoVisor({ src, alt, titulo, alCerrar }: PropsVisorImagen) {
  const idTitulo = useId();
  const refCerrar = useRef<HTMLButtonElement>(null);
  const [ampliada, setAmpliada] = useState(false);

  return (
    <CapaModal
      abierto
      alCerrar={alCerrar}
      idTitulo={idTitulo}
      refFocoInicial={refCerrar}
      claseFondo="bg-ink-950/95"
      className="flex h-dvh w-full flex-col"
    >
      <div className="flex items-center gap-3 border-b-[3px] border-brand-600 bg-ink-950 px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <h2
          id={idTitulo}
          title={titulo}
          className="min-w-0 flex-1 truncate text-base font-semibold text-white"
        >
          {titulo}
        </h2>
        <button
          type="button"
          aria-pressed={ampliada}
          onClick={() => setAmpliada((valor) => !valor)}
          className={cx(BOTON_OSCURO, ampliada ? 'bg-brand-600' : 'bg-white/10')}
        >
          <IconoAmpliar className="size-6 shrink-0" />
          <span>Ampliar</span>
        </button>
        <button
          ref={refCerrar}
          type="button"
          onClick={alCerrar}
          className={cx(BOTON_OSCURO, 'bg-white/10')}
        >
          <IconoX className="size-6 shrink-0" />
          <span>Cerrar</span>
        </button>
      </div>
      <div
        className={cx(
          'min-h-0 flex-1 overflow-auto overscroll-contain',
          !ampliada && 'flex items-center justify-center p-4',
        )}
      >
        <img
          src={src}
          alt={alt}
          className={ampliada ? 'w-[200%] max-w-none' : 'max-h-full max-w-full object-contain'}
        />
      </div>
    </CapaModal>
  );
}

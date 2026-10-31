import logoCatmetal from '../../assets/brand/logo-catmetal.png';
import { IconoGiro } from '../../components/ui';

/**
 * Pantalla mientras la app restaura la sesión al abrir. `index.html` trae una copia estática de esta
 * misma pantalla dentro de `#root` (se ve antes de que cargue el JavaScript); si se cambia aquí, hay
 * que cambiarla allá para que el paso de una a otra no parpadee.
 */
export function PantallaCarga() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-ink-950 px-4 text-white">
      <img src={logoCatmetal} alt="Catmetal" width={180} height={36} className="h-10 w-auto" />
      <div className="flex items-center gap-3">
        <IconoGiro className="size-8 motion-safe:animate-spin" />
        <p role="status" className="text-lg font-medium">
          Cargando…
        </p>
      </div>
    </div>
  );
}

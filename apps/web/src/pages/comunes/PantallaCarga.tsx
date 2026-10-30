import { IconoGiro } from '../../components/ui';

/** Pantalla mientras la app restaura la sesión al abrir. */
export function PantallaCarga() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-ink-950 px-4 text-white">
      <IconoGiro className="size-10 motion-safe:animate-spin" />
      <p role="status" className="text-lg font-medium">
        Cargando…
      </p>
    </div>
  );
}

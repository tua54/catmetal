import { Link, Outlet } from 'react-router';
import logoCatmetal from '../../assets/brand/logo-catmetal.png';

/**
 * Estructura común: barra superior en ink-950 con el logo de Catmetal y una línea inferior de 3 px
 * en brand-600 (adaptación de marca de docs/diseno/README.md), y el contenido sobre surface-50.
 */
export function AppLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-brand-600"
      >
        Saltar al contenido
      </a>

      <header className="border-b-[3px] border-brand-600 bg-ink-950 pt-[env(safe-area-inset-top)] text-white">
        <div className="mx-auto flex min-h-[74px] w-full max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link
            to="/"
            className="flex min-h-11 items-center rounded-sm"
            aria-label="Catmetal · Inicio"
          >
            <img src={logoCatmetal} alt="Catmetal" width={180} height={36} className="h-9 w-auto" />
          </Link>
          <span aria-hidden="true" className="hidden h-8 w-px bg-white/25 sm:block" />
          <p className="hidden text-base font-semibold sm:block">Control de Materia Prima</p>
        </div>
      </header>

      <main
        id="contenido"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none sm:px-6"
      >
        <Outlet />
      </main>
    </div>
  );
}

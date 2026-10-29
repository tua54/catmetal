import { Outlet, useMatches } from 'react-router';
import { BarraSuperior } from '../ui/BarraSuperior';
import { ProveedorAvisos } from '../ui/ProveedorAvisos';

/** Datos opcionales que cada ruta puede declarar en `handle` para la barra superior. */
export interface HandleRuta {
  titulo?: string;
  subtitulo?: string;
}

function esHandleRuta(valor: unknown): valor is HandleRuta {
  return typeof valor === 'object' && valor !== null && 'titulo' in valor;
}

const TITULO_POR_DEFECTO = 'Control de Materia Prima';
const SUBTITULO_POR_DEFECTO = 'Catmetal S.A.S.';

/**
 * Estructura común: barra superior (ADR 0011) y contenido sobre surface-50. El título y el
 * subtítulo salen del `handle` de la ruta más profunda que los declare. La píldora de conexión y el
 * avatar se conectan en la Fase 4, cuando existan el motor de sync y la sesión.
 */
export function AppLayout() {
  const matches = useMatches();
  const handle = [...matches]
    .reverse()
    .map((match) => match.handle)
    .find(esHandleRuta);

  return (
    <ProveedorAvisos>
      <div className="flex min-h-dvh flex-col">
        <a
          href="#contenido"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-brand-600"
        >
          Saltar al contenido
        </a>

        <BarraSuperior
          titulo={handle?.titulo ?? TITULO_POR_DEFECTO}
          subtitulo={handle?.subtitulo ?? SUBTITULO_POR_DEFECTO}
        />

        <main
          id="contenido"
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none sm:px-6"
        >
          <Outlet />
        </main>
      </div>
    </ProveedorAvisos>
  );
}

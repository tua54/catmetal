import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useRouteError } from 'react-router';
import { useTituloDocumento } from '../app/navegacion-accesible';
import { Boton, IconoSinConexion, IconoXCirculo } from '../components/ui';
import { clasificarErrorRuta, type TipoErrorRuta } from '../rutas/errores-ruta';

const TEXTOS: Readonly<Record<TipoErrorRuta, { titulo: string; texto: string }>> = {
  no_encontrada: {
    titulo: 'Página no encontrada',
    texto: 'La dirección que abrió no existe en esta aplicación.',
  },
  sin_conexion: {
    titulo: 'Sin conexión',
    texto:
      'Esta pantalla todavía no está guardada en la tablet y no hay conexión para descargarla. Sus registros siguen guardados. Vuelva a intentarlo cuando haya señal.',
  },
  carga: {
    titulo: 'No se pudo cargar esta pantalla',
    texto:
      'Puede que haya una versión nueva de la aplicación. Reintente para cargarla; sus registros siguen guardados en esta tablet.',
  },
  inesperado: {
    titulo: 'Algo salió mal',
    texto:
      'Ocurrió un error inesperado al mostrar esta pantalla. Sus registros siguen guardados en esta tablet. Reintente o vuelva a la pantalla anterior.',
  },
};

export interface PropsRouteErrorPage {
  /**
   * `pagina` (por defecto): límite raíz, ocupa toda la pantalla y trae su propio `<main>`.
   * `seccion`: límite dentro de `AppLayout` (conserva la barra superior y el `<main>` del layout).
   */
  variante?: 'pagina' | 'seccion';
}

/**
 * Límite de error de las rutas (`errorElement`). No muestra detalles técnicos: explica qué pasó en
 * español y ofrece "Reintentar" (recarga) y "Volver" (pantalla anterior, o el inicio si no hay).
 * El `<h1>` recibe el foco al aparecer, así el lector de pantalla anuncia el problema.
 */
export function RouteErrorPage({ variante = 'pagina' }: PropsRouteErrorPage) {
  const error = useRouteError();
  const navegar = useNavigate();
  const { key } = useLocation();
  const refTitulo = useRef<HTMLHeadingElement>(null);
  const enLinea = globalThis.navigator?.onLine ?? true;
  const tipo = clasificarErrorRuta(error, enLinea);
  const { titulo, texto } = TEXTOS[tipo];
  // Sin entrada anterior en el historial (se abrió la URL directamente): "Volver" lleva al inicio.
  const hayAnterior = key !== 'default';

  useTituloDocumento(titulo);
  useEffect(() => {
    refTitulo.current?.focus();
  }, []);

  const contenido = (
    <section
      aria-labelledby="titulo-error-ruta"
      className="rounded-xl border border-line-200 bg-white p-6 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-1 shrink-0 text-danger-700">
          {tipo === 'sin_conexion' ? (
            <IconoSinConexion className="size-7" />
          ) : (
            <IconoXCirculo className="size-7" />
          )}
        </span>
        <div className="min-w-0">
          <h1
            id="titulo-error-ruta"
            ref={refTitulo}
            tabIndex={-1}
            className="text-2xl font-bold text-ink-950"
          >
            {titulo}
          </h1>
          <p className="mt-3 text-ink-700">{texto}</p>
        </div>
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {tipo !== 'no_encontrada' && (
          <Boton tamano="grande" onClick={() => window.location.reload()}>
            Reintentar
          </Boton>
        )}
        <Boton
          tamano="grande"
          variante={tipo === 'no_encontrada' ? 'primario' : 'secundario'}
          onClick={() => void (hayAnterior ? navegar(-1) : navegar('/', { replace: true }))}
        >
          {hayAnterior ? 'Volver' : 'Ir al inicio'}
        </Boton>
      </div>
    </section>
  );

  if (variante === 'seccion') {
    return contenido;
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-4 py-6">
      {contenido}
    </main>
  );
}

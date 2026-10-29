import { Link, isRouteErrorResponse, useRouteError } from 'react-router';

/**
 * Límite de error de las rutas. No muestra detalles técnicos al usuario; solo un mensaje claro
 * y una salida.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const estado = isRouteErrorResponse(error) ? error.status : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-4 py-6">
      <section role="alert" className="rounded-xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-ink-950">Algo salió mal</h1>
        <p className="mt-3 text-ink-700">
          {estado === null
            ? 'Ocurrió un error inesperado al mostrar esta pantalla.'
            : `La pantalla respondió con el código ${estado}.`}
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 font-semibold text-white active:bg-brand-700"
        >
          Volver al inicio
        </Link>
      </section>
    </main>
  );
}

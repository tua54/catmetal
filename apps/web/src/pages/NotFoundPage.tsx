import { Link } from 'react-router';

/** Ruta comodín: cualquier URL que no corresponde a una pantalla de la aplicación. */
export function NotFoundPage() {
  return (
    <section aria-labelledby="titulo-404" className="rounded-xl bg-white p-6 shadow-sm">
      <p className="cifras text-sm font-semibold text-ink-500">Error 404</p>
      <h1 id="titulo-404" className="mt-1 text-2xl font-bold text-ink-950">
        Página no encontrada
      </h1>
      <p className="mt-3 text-ink-700">La dirección que abriste no existe en esta aplicación.</p>
      <Link
        to="/"
        className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 font-semibold text-white active:bg-brand-700"
      >
        Volver al inicio
      </Link>
    </section>
  );
}

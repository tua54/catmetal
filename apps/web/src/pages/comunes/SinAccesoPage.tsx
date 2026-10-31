import { Link } from 'react-router';
import { useSesion } from '../../auth';
import { inicioDe, NOMBRE_ROL } from '../../rutas/acceso';

/** Se muestra cuando el rol del usuario no permite abrir la pantalla pedida. */
export function SinAccesoPage() {
  const usuario = useSesion((estado) => estado.usuario);
  const permisos = useSesion((estado) => estado.permisos);
  const rol = usuario ? NOMBRE_ROL[usuario.rol] : null;

  return (
    <section aria-labelledby="titulo-sin-acceso" className="rounded-xl bg-white p-6 shadow-sm">
      <h1 id="titulo-sin-acceso" className="text-2xl font-bold text-ink-950">
        No tiene acceso a esta pantalla
      </h1>
      <p className="mt-3 text-ink-700">
        {rol
          ? `Su rol (${rol}) no permite abrir esta sección.`
          : 'Su usuario no permite abrir esta sección.'}
      </p>
      <Link
        to={inicioDe({ usuario, permisos })}
        className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 font-semibold text-white active:bg-brand-700"
      >
        Ir a mi inicio
      </Link>
    </section>
  );
}

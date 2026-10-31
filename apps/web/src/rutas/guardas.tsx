import { Navigate, Outlet, useLocation } from 'react-router';
import { useSesion } from '../auth';
import { useArranque } from '../app/estado-arranque';
import { PantallaCarga } from '../pages/comunes/PantallaCarga';
import { SinAccesoPage } from '../pages/comunes/SinAccesoPage';
import { inicioDe, puedeVerArea, RUTAS, type Area } from './acceso';

/** Estado de navegación hacia el login: la ruta que se intentaba abrir. */
export interface EstadoLogin {
  desde?: string;
}

/**
 * Exige una sesión (`online` u `offline`). Sin sesión, manda al login recordando la ruta pedida.
 * Mientras la app restaura la sesión al abrir, muestra "Cargando…".
 */
export function RequiereSesion() {
  const listo = useArranque((estado) => estado.listo);
  const modo = useSesion((estado) => estado.modo);
  const hayUsuario = useSesion((estado) => estado.usuario !== null);
  const ubicacion = useLocation();

  if (!listo) {
    return <PantallaCarga />;
  }
  if (modo === 'sin_sesion' || !hayUsuario) {
    const desde = `${ubicacion.pathname}${ubicacion.search}${ubicacion.hash}`;
    return (
      <Navigate
        to={RUTAS.login}
        replace
        state={(desde === '/' ? {} : { desde }) satisfies EstadoLogin}
      />
    );
  }
  return <Outlet />;
}

/** Exige el permiso del área (con los permisos cacheados). Si no, explica que no tiene acceso. */
export function RequiereArea({ area }: { area: Area }) {
  const usuario = useSesion((estado) => estado.usuario);
  const permisos = useSesion((estado) => estado.permisos);
  if (!puedeVerArea({ usuario, permisos }, area)) {
    return <SinAccesoPage />;
  }
  return <Outlet />;
}

/** `/`: redirige a la pantalla inicial del rol. */
export function InicioPorRol() {
  const usuario = useSesion((estado) => estado.usuario);
  const permisos = useSesion((estado) => estado.permisos);
  return <Navigate to={inicioDe({ usuario, permisos })} replace />;
}

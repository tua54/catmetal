// Reglas de acceso a las pantallas por rol y permiso (docs/spec.md §3). El cliente solo oculta
// pantallas y botones: la autorización real la hace SIEMPRE el Worker en cada petición.

import { tienePermiso, type Permiso, type Rol } from '@catmetal/shared';
import type { EstadoSesion } from '../auth';

export const RUTAS = {
  login: '/login',
  supervisor: '/supervisor',
  jefe: '/jefe',
  admin: '/admin',
  sincronizacion: '/sincronizacion',
} as const;

/** Permiso que exige cada área (el que distingue al rol que la usa). */
export const PERMISO_DE_AREA = {
  // `consumos.editar_propio` solo lo tiene el supervisor: el jefe también registra consumos, pero
  // su pantalla es la de validación.
  supervisor: 'consumos.editar_propio',
  jefe: 'consumos.validar',
  admin: 'admin.gestionar',
} as const satisfies Record<string, Permiso>;

export type Area = keyof typeof PERMISO_DE_AREA;

const INICIO_POR_ROL: Readonly<Record<Rol, string>> = {
  supervisor: RUTAS.supervisor,
  jefe: RUTAS.jefe,
  admin: RUTAS.admin,
};

export const NOMBRE_ROL: Readonly<Record<Rol, string>> = {
  supervisor: 'Supervisor',
  jefe: 'Jefe de producción',
  admin: 'Administrador',
};

type SesionParaAcceso = Pick<EstadoSesion, 'usuario' | 'permisos'>;

/**
 * El usuario tiene el permiso en sus permisos CACHEADOS (los que dio el servidor al iniciar sesión
 * y que sirven sin conexión) y además su rol lo concede según la tabla de shared. Exigir las dos
 * cosas evita abrir pantallas con una lista local de permisos alterada o desactualizada.
 */
export function tienePermisoCacheado(sesion: SesionParaAcceso, permiso: Permiso): boolean {
  if (sesion.usuario === null) {
    return false;
  }
  return sesion.permisos.includes(permiso) && tienePermiso(sesion.usuario.rol, permiso);
}

export function puedeVerArea(sesion: SesionParaAcceso, area: Area): boolean {
  return tienePermisoCacheado(sesion, PERMISO_DE_AREA[area]);
}

/** Pantalla inicial del usuario según su rol (o la de sincronización si no reconoce el rol). */
export function inicioDe(sesion: SesionParaAcceso): string {
  const rol = sesion.usuario?.rol;
  if (rol === undefined || !Object.hasOwn(INICIO_POR_ROL, rol)) {
    return RUTAS.sincronizacion;
  }
  const inicio = INICIO_POR_ROL[rol];
  const area = (Object.keys(PERMISO_DE_AREA) as Area[]).find((a) => RUTAS[a] === inicio);
  return area !== undefined && puedeVerArea(sesion, area) ? inicio : RUTAS.sincronizacion;
}

/** Área protegida a la que pertenece una ruta (`/jefe/orden/1` → `jefe`), si alguna. */
export function areaDeRuta(pathname: string): Area | null {
  const area = (Object.keys(PERMISO_DE_AREA) as Area[]).find(
    (a) => pathname === RUTAS[a] || pathname.startsWith(`${RUTAS[a]}/`),
  );
  return area ?? null;
}

/**
 * Destino tras iniciar sesión: la ruta que el usuario intentaba abrir si puede verla (y no es el
 * login), o su inicio por rol.
 */
export function destinoTrasLogin(sesion: SesionParaAcceso, desde: string | null): string {
  if (desde === null || !desde.startsWith('/') || desde.startsWith('//')) {
    return inicioDe(sesion);
  }
  const ruta = desde.split(/[?#]/)[0] ?? '/';
  if (ruta === '/' || ruta === RUTAS.login) {
    return inicioDe(sesion);
  }
  const area = areaDeRuta(ruta);
  if (area !== null && !puedeVerArea(sesion, area)) {
    return inicioDe(sesion);
  }
  return desde;
}

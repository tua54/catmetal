// Permisos por rol según la tabla de docs/spec.md §3.
//
// Estos permisos responden "¿este rol puede hacer este tipo de acción?". Hay restricciones de la
// tabla que NO son permisos sino reglas de datos, y las aplica siempre el Worker sobre cada registro:
//   - El supervisor solo ve y registra en las órdenes que tiene asignadas (y en proceso), y solo ve
//     su propia auditoría. Por eso no tiene `ordenes.ver_todas` ni `auditoria.ver_todo`.
//   - `consumos.editar_propio` solo aplica a consumos propios en estado `pendiente` (S4).
//   - `consumos.validar` nunca aplica a un consumo registrado por el mismo usuario (S9, AUTOAPROBACION),
//     ni a uno con `requiere_novedad = 1` sin novedad (REQUIERE_NOVEDAD).
// El cliente usa estos permisos solo para ocultar botones; el Worker los revalida en cada petición.

import type { Rol } from './dominio';

export const PERMISOS = [
  'ordenes.ver_todas',
  'ordenes.gestionar',
  'consumos.registrar',
  'consumos.editar_propio',
  'novedades.registrar',
  'consumos.validar',
  'auditoria.ver_todo',
  'admin.gestionar',
] as const;
export type Permiso = (typeof PERMISOS)[number];

export const PERMISOS_POR_ROL: Readonly<Record<Rol, readonly Permiso[]>> = {
  supervisor: ['consumos.registrar', 'consumos.editar_propio', 'novedades.registrar'],
  jefe: [
    'ordenes.ver_todas',
    'ordenes.gestionar',
    'consumos.registrar',
    'novedades.registrar',
    'consumos.validar',
    'auditoria.ver_todo',
  ],
  admin: ['ordenes.ver_todas', 'ordenes.gestionar', 'auditoria.ver_todo', 'admin.gestionar'],
};

/** Permisos del rol; vacío si el rol no es válido (por ejemplo, datos locales corruptos). */
function permisosInternos(rol: Rol): readonly Permiso[] {
  return Object.hasOwn(PERMISOS_POR_ROL, rol) ? PERMISOS_POR_ROL[rol] : [];
}

/** Indica si el rol tiene el permiso. Un rol desconocido no tiene ninguno. */
export function tienePermiso(rol: Rol, permiso: Permiso): boolean {
  return permisosInternos(rol).includes(permiso);
}

/** Lista de permisos del rol (copia), por ejemplo para `GET /auth/me`. */
export function permisosDeRol(rol: Rol): Permiso[] {
  return [...permisosInternos(rol)];
}

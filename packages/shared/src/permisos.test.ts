import { describe, expect, it } from 'vitest';
import type { Rol } from './dominio';
import { PERMISOS, PERMISOS_POR_ROL, type Permiso, permisosDeRol, tienePermiso } from './permisos';

// Matriz esperada (docs/spec.md §3). Cada celda genera una prueba positiva o negativa.
const MATRIZ: Record<Permiso, Record<Rol, boolean>> = {
  'ordenes.ver_todas': { supervisor: false, jefe: true, admin: true },
  'ordenes.gestionar': { supervisor: false, jefe: true, admin: true },
  'consumos.registrar': { supervisor: true, jefe: true, admin: false },
  'consumos.editar_propio': { supervisor: true, jefe: false, admin: false },
  'novedades.registrar': { supervisor: true, jefe: true, admin: false },
  'consumos.validar': { supervisor: false, jefe: true, admin: false },
  'auditoria.ver_todo': { supervisor: false, jefe: true, admin: true },
  'admin.gestionar': { supervisor: false, jefe: false, admin: true },
};

const ROLES_PRUEBA: Rol[] = ['supervisor', 'jefe', 'admin'];

describe('permisos', () => {
  it('la matriz de la prueba cubre todos los permisos', () => {
    expect(Object.keys(MATRIZ).sort()).toEqual([...PERMISOS].sort());
  });

  for (const permiso of PERMISOS) {
    for (const rol of ROLES_PRUEBA) {
      const esperado = MATRIZ[permiso][rol];
      it(`${rol} ${esperado ? 'tiene' : 'NO tiene'} ${permiso}`, () => {
        expect(tienePermiso(rol, permiso)).toBe(esperado);
      });
    }
  }

  it('PERMISOS_POR_ROL no tiene permisos repetidos ni desconocidos', () => {
    for (const rol of ROLES_PRUEBA) {
      const lista = PERMISOS_POR_ROL[rol];
      expect(new Set(lista).size).toBe(lista.length);
      for (const permiso of lista) {
        expect(PERMISOS).toContain(permiso);
      }
    }
  });

  it('permisosDeRol devuelve una copia que no altera la tabla', () => {
    const lista = permisosDeRol('supervisor');
    expect(lista).toEqual(['consumos.registrar', 'consumos.editar_propio', 'novedades.registrar']);
    lista.push('admin.gestionar');
    expect(tienePermiso('supervisor', 'admin.gestionar')).toBe(false);
  });

  it('un rol desconocido (por ejemplo, datos locales corruptos) no tiene permisos', () => {
    const rolInvalido = 'constructor' as Rol;
    expect(tienePermiso(rolInvalido, 'admin.gestionar')).toBe(false);
    expect(permisosDeRol(rolInvalido)).toEqual([]);
    expect(permisosDeRol('superadmin' as Rol)).toEqual([]);
  });
});

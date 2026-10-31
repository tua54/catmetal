import { permisosDeRol, type Permiso, type Perfil, type Rol } from '@catmetal/shared';
import { describe, expect, it } from 'vitest';
import {
  areaDeRuta,
  destinoTrasLogin,
  inicioDe,
  puedeVerArea,
  tienePermisoCacheado,
} from './acceso';

function sesionDe(rol: Rol, permisos: Permiso[] = permisosDeRol(rol)) {
  const usuario: Perfil = { id: 'u', nombre: 'X', email: 'x@catmetal.test', rol, permisos };
  return { usuario, permisos };
}

describe('acceso por rol', () => {
  it('cada rol entra solo a su área', () => {
    expect(puedeVerArea(sesionDe('supervisor'), 'supervisor')).toBe(true);
    expect(puedeVerArea(sesionDe('supervisor'), 'jefe')).toBe(false);
    expect(puedeVerArea(sesionDe('supervisor'), 'admin')).toBe(false);
    expect(puedeVerArea(sesionDe('jefe'), 'jefe')).toBe(true);
    expect(puedeVerArea(sesionDe('jefe'), 'supervisor')).toBe(false);
    expect(puedeVerArea(sesionDe('jefe'), 'admin')).toBe(false);
    expect(puedeVerArea(sesionDe('admin'), 'admin')).toBe(true);
    expect(puedeVerArea(sesionDe('admin'), 'jefe')).toBe(false);
  });

  it('exige el permiso en la caché Y en la tabla del rol (una caché alterada no abre pantallas)', () => {
    const alterada = sesionDe('supervisor', [...permisosDeRol('supervisor'), 'consumos.validar']);
    expect(tienePermisoCacheado(alterada, 'consumos.validar')).toBe(false);
    const sinPermisos = sesionDe('jefe', []);
    expect(tienePermisoCacheado(sinPermisos, 'consumos.validar')).toBe(false);
    expect(tienePermisoCacheado({ usuario: null, permisos: [] }, 'consumos.validar')).toBe(false);
  });

  it('el inicio depende del rol; sin permiso o rol desconocido va a sincronización', () => {
    expect(inicioDe(sesionDe('supervisor'))).toBe('/supervisor');
    expect(inicioDe(sesionDe('jefe'))).toBe('/jefe');
    expect(inicioDe(sesionDe('admin'))).toBe('/admin');
    expect(inicioDe(sesionDe('jefe', []))).toBe('/sincronizacion');
    expect(inicioDe({ usuario: null, permisos: [] })).toBe('/sincronizacion');
    const rara = sesionDe('supervisor');
    expect(inicioDe({ ...rara, usuario: { ...rara.usuario, rol: 'otro' as unknown as Rol } })).toBe(
      '/sincronizacion',
    );
  });

  it('reconoce el área de una ruta', () => {
    expect(areaDeRuta('/jefe')).toBe('jefe');
    expect(areaDeRuta('/jefe/orden/1')).toBe('jefe');
    expect(areaDeRuta('/jefecito')).toBeNull();
    expect(areaDeRuta('/sincronizacion')).toBeNull();
  });

  it('tras el login va a la ruta pedida solo si el rol la permite', () => {
    const supervisor = sesionDe('supervisor');
    expect(destinoTrasLogin(supervisor, null)).toBe('/supervisor');
    expect(destinoTrasLogin(supervisor, '/')).toBe('/supervisor');
    expect(destinoTrasLogin(supervisor, '/login')).toBe('/supervisor');
    expect(destinoTrasLogin(supervisor, '/jefe')).toBe('/supervisor');
    expect(destinoTrasLogin(supervisor, '/sincronizacion')).toBe('/sincronizacion');
    expect(destinoTrasLogin(supervisor, '/supervisor/orden/1?x=1')).toBe('/supervisor/orden/1?x=1');
    // Nunca a otro origen.
    expect(destinoTrasLogin(supervisor, '//evil.example/x')).toBe('/supervisor');
    expect(destinoTrasLogin(supervisor, 'https://evil.example')).toBe('/supervisor');
  });
});

// Sesión simulada para las pruebas del motor: el token es `tok-<user_id>` (lo entiende el servidor
// de sync falso) y `marcarRequiereContrasena` pasa a offline como el `GestorSesion` real.

import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { crearClienteApi } from '../../auth/cliente-api';
import type { EstadoSesion } from '../../auth/sesion';
import type { SesionParaSync } from '../motor';
import type { ServidorSync } from './servidor-sync';

export interface SesionFalsa extends SesionParaSync {
  usuario: Perfil | null;
  modo: EstadoSesion['modo'];
  requiere: boolean;
}

export function perfilFalso(nombre: string): Perfil {
  const id = uuidv7();
  return {
    id,
    nombre,
    email: `${id}@catmetal.co`,
    rol: 'supervisor',
    permisos: permisosDeRol('supervisor'),
  };
}

export function sesionFalsa(servidor: ServidorSync, usuario: Perfil | null): SesionFalsa {
  const s: SesionFalsa = {
    usuario,
    modo: 'online',
    requiere: false,
    estado: () => ({
      modo: s.usuario === null ? 'sin_sesion' : s.modo,
      usuario: s.usuario,
      permisos: s.usuario?.permisos ?? [],
      device_id: null,
      requiere_contrasena: s.requiere,
      bloqueada: false,
    }),
    usuarioDeLaSesion: () => s.usuario,
    obtenerAccessToken: () =>
      Promise.resolve(
        s.usuario === null || s.modo !== 'online' || s.requiere ? null : `tok-${s.usuario.id}`,
      ),
    marcarRequiereContrasena: () => {
      s.requiere = true;
      s.modo = 'offline';
    },
    api: crearClienteApi({
      fetch: (entrada, init) => servidor.fetch(entrada, init),
      proveedor: {
        obtenerAccessToken: () => s.obtenerAccessToken(),
        refrescar: () => Promise.resolve(null),
      },
    }),
  };
  return s;
}

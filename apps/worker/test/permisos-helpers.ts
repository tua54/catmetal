// Utilidades de las pruebas de permisos: app Hono de prueba con los middlewares REALES y sesiones
// reales (login por /api/v1/auth/login contra la D1 local).
import { PERMISOS, type Permiso, type Rol } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { manejarError, manejarNoEncontrado } from '../src/errores';
import { autenticar, requierePermiso } from '../src/middleware/autenticar';
import type { AppEnv } from '../src/tipos';
import { crearUsuarioConClave, iniciarSesion, type UsuarioPrueba } from './auth-helpers';

export const rutaPrueba = (permiso: Permiso): string => `/protegida/${permiso}`;

/** Una ruta por permiso, protegida con `autenticar` + `requierePermiso` reales. */
export function crearAppDePrueba(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(manejarError);
  app.notFound(manejarNoEncontrado);
  for (const permiso of PERMISOS) {
    app.get(rutaPrueba(permiso), autenticar, requierePermiso(permiso), (c) =>
      c.json({ ok: true, permiso, rol: c.get('sesion').rol }),
    );
  }
  return app;
}

/** Ejecuta la app de prueba con el `env` real del pool (D1 local con migraciones). */
export async function llamar(
  app: Hono<AppEnv>,
  permiso: Permiso,
  token?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const cabeceras = new Headers(headers);
  if (token !== undefined) {
    cabeceras.set('Authorization', `Bearer ${token}`);
  }
  return app.request(rutaPrueba(permiso), { headers: cabeceras }, env);
}

export interface SesionDeRol {
  usuario: UsuarioPrueba;
  token: string;
  deviceId: string;
}

/** Crea un usuario real del rol y hace login real (un login por usuario: límite 5/min por email). */
export async function sesionReal(rol: Rol): Promise<SesionDeRol> {
  const usuario = await crearUsuarioConClave(rol);
  const sesion = await iniciarSesion(usuario);
  return { usuario, token: sesion.cuerpo.access_token, deviceId: sesion.deviceId };
}

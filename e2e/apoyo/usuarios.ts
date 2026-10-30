// Usuarios del seed local (scripts/seed.mjs). Todos comparten la contraseña de prueba E2E
// (scripts/e2e-config.mjs): la base E2E es desechable y local, no es un secreto real.

import { CONTRASENA_E2E } from '../../scripts/e2e-config.mjs';

export type RolSeed = 'admin' | 'jefe' | 'supervisor';

export interface UsuarioSeed {
  readonly email: string;
  readonly nombre: string;
  readonly rol: RolSeed;
  /** Ruta a la que redirige el login según el rol. */
  readonly inicio: string;
}

export const CONTRASENA = CONTRASENA_E2E;

export const ADMIN: UsuarioSeed = {
  email: 'admin@catmetal.test',
  nombre: 'Administrador Catmetal',
  rol: 'admin',
  inicio: '/admin',
};

export const JEFE: UsuarioSeed = {
  email: 'jefe@catmetal.test',
  nombre: 'Roberto Martínez',
  rol: 'jefe',
  inicio: '/jefe',
};

export const SUPERVISOR_1: UsuarioSeed = {
  email: 'supervisor1@catmetal.test',
  nombre: 'Juan Sánchez',
  rol: 'supervisor',
  inicio: '/supervisor',
};

export const SUPERVISOR_2: UsuarioSeed = {
  email: 'supervisor2@catmetal.test',
  nombre: 'Laura Gómez',
  rol: 'supervisor',
  inicio: '/supervisor',
};

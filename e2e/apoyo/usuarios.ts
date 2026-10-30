// Usuarios del seed local (scripts/seed.mjs). Todos comparten la contraseña de prueba E2E
// (scripts/e2e-config.mjs): la base E2E es desechable y local, no es un secreto real.

import { CONTRASENA_E2E } from '../../scripts/e2e-config.mjs';

export type RolSeed = 'admin' | 'jefe' | 'supervisor';

export interface UsuarioSeed {
  /** Id fijo del seed (UUID v7): es el `registrado_por` de sus consumos. */
  readonly id: string;
  readonly email: string;
  readonly nombre: string;
  readonly rol: RolSeed;
  /** Ruta a la que redirige el login según el rol. */
  readonly inicio: string;
}

export const CONTRASENA = CONTRASENA_E2E;

export const ADMIN: UsuarioSeed = {
  id: '019a3000-0001-7000-8000-000000000001',
  email: 'admin@catmetal.test',
  nombre: 'Administrador Catmetal',
  rol: 'admin',
  inicio: '/admin',
};

export const JEFE: UsuarioSeed = {
  id: '019a3000-0001-7000-8000-000000000002',
  email: 'jefe@catmetal.test',
  nombre: 'Roberto Martínez',
  rol: 'jefe',
  inicio: '/jefe',
};

export const SUPERVISOR_1: UsuarioSeed = {
  id: '019a3000-0001-7000-8000-000000000003',
  email: 'supervisor1@catmetal.test',
  nombre: 'Juan Sánchez',
  rol: 'supervisor',
  inicio: '/supervisor',
};

export const SUPERVISOR_2: UsuarioSeed = {
  id: '019a3000-0001-7000-8000-000000000004',
  email: 'supervisor2@catmetal.test',
  nombre: 'Laura Gómez',
  rol: 'supervisor',
  inicio: '/supervisor',
};

/** Orden del seed en proceso, con ambos supervisores asignados (OP-2026-0587, línea Moldeo 1). */
export const ORDEN_0587 = {
  id: '019a3000-0003-7000-8000-000000000001',
  codigo: 'OP-2026-0587',
} as const;

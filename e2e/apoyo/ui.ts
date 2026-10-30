// Interacciones con la interfaz compartidas por las pruebas.

import { expect, type Page } from '@playwright/test';
import { CONTRASENA, type UsuarioSeed } from './usuarios';

/** Texto de CREDENCIALES_INVALIDAS (packages/shared/src/errores.ts): genérico, sin revelar la causa. */
export const MENSAJE_CREDENCIALES = /Correo o contraseña incorrectos/;

/** Texto de SIN_LOGIN_PREVIO (apps/web/src/pages/comunes/mensajes-login.ts). */
export const MENSAJE_SIN_LOGIN_PREVIO = /primero inicie sesión con conexión/;

/** Botón del avatar con el menú de la cuenta (solo existe con sesión). */
export function botonCuenta(page: Page, usuario: UsuarioSeed) {
  return page.getByRole('button', { name: `Cuenta de ${usuario.nombre}` });
}

/** Abre la pantalla de login y espera a que el formulario esté listo. */
export async function abrirLogin(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(
    page.getByRole('heading', { name: 'Control de Materia Prima', level: 1 }),
  ).toBeVisible();
}

/** Rellena y envía el formulario de login (sin esperar el resultado). */
export async function enviarLogin(
  page: Page,
  email: string,
  contrasena: string = CONTRASENA,
): Promise<void> {
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(contrasena);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
}

/** Login por la UI y espera de la pantalla de inicio del rol. */
export async function iniciarSesionPorUI(
  page: Page,
  usuario: UsuarioSeed,
  contrasena: string = CONTRASENA,
): Promise<void> {
  await abrirLogin(page);
  await enviarLogin(page, usuario.email, contrasena);
  await expect(page).toHaveURL(new RegExp(`${usuario.inicio}$`));
  await expect(botonCuenta(page, usuario)).toBeVisible();
}

/** Cierra la sesión desde el menú de la cuenta, confirmando el diálogo. */
export async function cerrarSesionPorUI(page: Page, usuario: UsuarioSeed): Promise<void> {
  await botonCuenta(page, usuario).click();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

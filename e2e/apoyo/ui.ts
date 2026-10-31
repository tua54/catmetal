// Interacciones con la interfaz compartidas por las pruebas.

import { expect, test, type Locator, type Page } from '@playwright/test';
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

/** Texto de DEMASIADOS_INTENTOS (packages/shared/src/errores.ts). */
const MENSAJE_DEMASIADOS_INTENTOS = /Demasiados intentos seguidos/;

/** Ventana del Rate Limiting del login (wrangler.jsonc: 5 intentos por 60 s, por IP y correo). */
const ESPERA_LIMITE_LOGIN_MS = 62_000;

/**
 * Login por la UI y espera de la pantalla de inicio del rol.
 *
 * El login admite 5 intentos por minuto y por correo (ADR 0008). Las pruebas reparten sus entradas
 * entre los 4 usuarios del seed para no llegar a ese límite; si aun así el servidor responde
 * "Demasiados intentos", se espera una ventana completa (62 s) y se reintenta una vez.
 */
export async function iniciarSesionPorUI(
  page: Page,
  usuario: UsuarioSeed,
  contrasena: string = CONTRASENA,
): Promise<void> {
  await abrirLogin(page);
  await enviarLogin(page, usuario.email, contrasena);
  const limite = page.getByRole('alert').filter({ hasText: MENSAJE_DEMASIADOS_INTENTOS });
  await expect(botonCuenta(page, usuario).or(limite)).toBeVisible();
  if (await limite.isVisible()) {
    console.warn(
      `[e2e] Límite de login de ${usuario.email}: se espera ${ESPERA_LIMITE_LOGIN_MS} ms.`,
    );
    test.setTimeout(test.info().timeout + ESPERA_LIMITE_LOGIN_MS);
    await page.waitForTimeout(ESPERA_LIMITE_LOGIN_MS);
    await enviarLogin(page, usuario.email, contrasena);
  }
  await expect(page).toHaveURL(new RegExp(`${usuario.inicio}$`));
  await expect(botonCuenta(page, usuario)).toBeVisible();
}

/** Abre el menú de la cuenta y el diálogo de confirmación de "Cerrar sesión". */
export async function abrirDialogoCerrarSesion(page: Page, usuario: UsuarioSeed): Promise<Locator> {
  await botonCuenta(page, usuario).click();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  const dialogo = page.getByRole('alertdialog');
  await expect(dialogo).toBeVisible();
  return dialogo;
}

/** Cierra la sesión desde el menú de la cuenta, confirmando el diálogo. */
export async function cerrarSesionPorUI(page: Page, usuario: UsuarioSeed): Promise<void> {
  const dialogo = await abrirDialogoCerrarSesion(page, usuario);
  await dialogo.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

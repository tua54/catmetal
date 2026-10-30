import { expect, test, type Page } from '@playwright/test';
import { cortarRed, restablecerRed } from './apoyo/red';
import { JEFE, SUPERVISOR_1, SUPERVISOR_2 } from './apoyo/usuarios';
import {
  abrirLogin,
  botonCuenta,
  cerrarSesionPorUI,
  enviarLogin,
  iniciarSesionPorUI,
  MENSAJE_CREDENCIALES,
  MENSAJE_SIN_LOGIN_PREVIO,
} from './apoyo/ui';

/** El SW debe haber precacheado el shell antes de cortar la red. */
async function esperarShellPrecacheado(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

test.describe('Login sin conexión (verificador local, ADR 0012)', () => {
  test('@humo quien ya entró con conexión puede volver a entrar sin conexión, y solo con su contraseña', async ({
    page,
    context,
  }, testInfo) => {
    // 1. Login con conexión y cierre de sesión: el dispositivo conserva el perfil y el verificador.
    await iniciarSesionPorUI(page, JEFE);
    await esperarShellPrecacheado(page);
    await cerrarSesionPorUI(page, JEFE);
    await expect(page.getByText('Puede entrar sin conexión')).toBeVisible();

    // 2. Sin red (se recarga para comprobar que el shell también abre sin conexión).
    await cortarRed(context);
    try {
      await page.reload();
      await expect(page.getByText('Solo pueden entrar quienes ya iniciaron sesión')).toBeVisible();

      // 3. Contraseña incorrecta: el mismo mensaje genérico, sin entrar.
      await enviarLogin(page, JEFE.email, 'contraseña-equivocada-1');
      await expect(page.getByRole('alert').filter({ hasText: MENSAJE_CREDENCIALES })).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
      await expect(botonCuenta(page, JEFE)).toHaveCount(0);

      // 4. Contraseña correcta: entra. Se mide el tiempo del verificador (600.000 iteraciones).
      const inicio = Date.now();
      await enviarLogin(page, JEFE.email);
      await expect(page).toHaveURL(new RegExp(`${JEFE.inicio}$`));
      await expect(botonCuenta(page, JEFE)).toBeVisible();
      const duracionMs = Date.now() - inicio;

      console.log(`[medida] login offline (${testInfo.project.name}): ${duracionMs} ms`);
      testInfo.annotations.push({ type: 'login-offline-ms', description: String(duracionMs) });
      await testInfo.attach('tiempo-login-offline.txt', {
        body: `${duracionMs} ms`,
        contentType: 'text/plain',
      });
    } finally {
      await restablecerRed(context);
    }
  });

  test('un usuario que nunca entró con conexión en esa tablet no puede entrar sin conexión', async ({
    page,
    context,
  }) => {
    // La tablet ya la usó el supervisor 2 (con conexión); el supervisor 1 nunca entró en ella.
    await iniciarSesionPorUI(page, SUPERVISOR_2);
    await esperarShellPrecacheado(page);
    await cerrarSesionPorUI(page, SUPERVISOR_2);

    await cortarRed(context);
    try {
      await page.reload();
      await enviarLogin(page, SUPERVISOR_1.email);

      await expect(
        page.getByRole('alert').filter({ hasText: MENSAJE_SIN_LOGIN_PREVIO }),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
      await expect(botonCuenta(page, SUPERVISOR_1)).toHaveCount(0);
    } finally {
      await restablecerRed(context);
    }
  });

  test('en una tablet sin ningún inicio de sesión previo, nadie entra sin conexión', async ({
    page,
    context,
  }) => {
    await abrirLogin(page);
    await esperarShellPrecacheado(page);

    await cortarRed(context);
    try {
      await page.reload();
      await enviarLogin(page, JEFE.email);

      await expect(
        page.getByRole('alert').filter({ hasText: MENSAJE_SIN_LOGIN_PREVIO }),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
    } finally {
      await restablecerRed(context);
    }
  });
});

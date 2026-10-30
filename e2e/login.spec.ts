import { expect, test } from '@playwright/test';
import { ADMIN, SUPERVISOR_1, SUPERVISOR_2 } from './apoyo/usuarios';
import {
  abrirLogin,
  botonCuenta,
  enviarLogin,
  iniciarSesionPorUI,
  MENSAJE_CREDENCIALES,
} from './apoyo/ui';

test.describe('Login con conexión', () => {
  test('@humo el supervisor entra y llega a su pantalla de inicio', async ({ page }) => {
    await iniciarSesionPorUI(page, SUPERVISOR_1);

    await expect(page).toHaveURL(/\/supervisor$/);
    await expect(botonCuenta(page, SUPERVISOR_1)).toBeVisible();
  });

  test('@humo la contraseña incorrecta muestra el mensaje genérico y no entra', async ({
    page,
  }) => {
    // Un solo intento fallido con el admin y luego el correcto, que reinicia el contador: 5 fallos
    // seguidos bloquearían la cuenta 15 minutos (ADR 0008) si se reutiliza un servidor ya levantado.
    await abrirLogin(page);
    await enviarLogin(page, ADMIN.email, 'contraseña-equivocada-1');

    await expect(page.getByRole('alert').filter({ hasText: MENSAJE_CREDENCIALES })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(botonCuenta(page, ADMIN)).toHaveCount(0);

    // Con la contraseña correcta entra, y el contador de intentos fallidos vuelve a cero.
    await enviarLogin(page, ADMIN.email);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(botonCuenta(page, ADMIN)).toBeVisible();
  });

  test('un correo inexistente recibe el mismo mensaje genérico (no revela si la cuenta existe)', async ({
    page,
  }) => {
    await abrirLogin(page);
    await enviarLogin(page, 'nadie@catmetal.test', 'contraseña-equivocada-1');

    await expect(page.getByRole('alert').filter({ hasText: MENSAJE_CREDENCIALES })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sin escribir correo ni contraseña el formulario lo indica y no llama al servidor', async ({
    page,
  }) => {
    const peticionesLogin: string[] = [];
    page.on('request', (peticion) => {
      if (peticion.url().includes('/auth/login')) {
        peticionesLogin.push(peticion.url());
      }
    });
    await abrirLogin(page);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();

    await expect(page.getByText('Escriba su correo.')).toBeVisible();
    expect(peticionesLogin).toHaveLength(0);
  });
});

test.describe('Sesión persistente', () => {
  test('al recargar la página la sesión se recupera con la cookie de refresco (Chromium)', async ({
    page,
  }) => {
    // La cookie `mp_refresh` es HttpOnly + Secure + SameSite=Strict (ADR 0008). Chromium la acepta y
    // la envía en http://localhost. WebKit NO la reenvía por http: ver la prueba @humo siguiente.
    await iniciarSesionPorUI(page, SUPERVISOR_2);

    await page.reload();

    await expect(page).toHaveURL(/\/supervisor$/);
    await expect(botonCuenta(page, SUPERVISOR_2)).toBeVisible();
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === 'mp_refresh' && c.httpOnly && c.secure)).toBe(true);
  });

  test('@humo al recargar la app no queda en blanco: recupera la sesión o vuelve al login con el perfil de la tablet', async ({
    page,
  }) => {
    // En WebKit (Playwright, http://localhost) la cookie Secure de refresco no se envía: /auth/refresh
    // responde 401 y la app vuelve al login ofreciendo el perfil del dispositivo (login offline).
    // Se aceptan ambos desenlaces válidos; lo que no puede pasar es una pantalla vacía o con error.
    await iniciarSesionPorUI(page, SUPERVISOR_2);

    await page.reload();

    const sesionRecuperada = botonCuenta(page, SUPERVISOR_2);
    const perfilEnLogin = page.getByRole('button', {
      name: /Laura Gómez\s+supervisor2@catmetal\.test/,
    });
    await expect(sesionRecuperada.or(perfilEnLogin)).toBeVisible();
  });
});

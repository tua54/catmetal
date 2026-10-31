// Ítem M7 (ADR 0023): cerrar sesión o bloquearse por inactividad en una pestaña se propaga a las
// demás pestañas del mismo navegador en menos de 2 s. Chromium.
//
// Ítem A2 (ADR 0023, enmienda 1): la inactividad es del USUARIO, no de la pestaña. Con actividad en
// una pestaña, la otra (sin interacción propia) no se bloquea; sin actividad en ninguna, se
// bloquean las dos en menos de 2 s.
//
// Las dos páginas comparten el contexto (cookies, IndexedDB, localStorage y BroadcastChannel), como
// dos pestañas de la misma tablet. `page.clock` es el reloj del CONTEXTO: lo comparten las dos.

import { expect, test, type Page } from '@playwright/test';
import { abrirDialogoCerrarSesion, botonCuenta, iniciarSesionPorUI } from './apoyo/ui';
import { SUPERVISOR_1, SUPERVISOR_2, type UsuarioSeed } from './apoyo/usuarios';

/** Plazo de la aceptación: las demás pestañas reaccionan en menos de 2 s. */
const PLAZO_MS = 2_000;

/** Abre una segunda pestaña que recupera la sesión con la cookie y espera a que esté dentro. */
async function segundaPestana(page: Page, usuario: UsuarioSeed): Promise<Page> {
  const otra = await page.context().newPage();
  await otra.goto(usuario.inicio);
  await expect(botonCuenta(otra, usuario)).toBeVisible();
  await expect(otra).toHaveURL(new RegExp(`${usuario.inicio}$`));
  return otra;
}

/** Pantalla de bloqueo "Confirme que es <nombre>" de una pestaña. */
function pantallaBloqueo(page: Page, usuario: UsuarioSeed) {
  return page.getByRole('heading', { name: `Confirme que es ${usuario.nombre}` });
}

test.describe('Sesión entre pestañas', () => {
  test('cerrar sesión en una pestaña manda la otra al login en menos de 2 s', async ({ page }) => {
    await iniciarSesionPorUI(page, SUPERVISOR_2);
    const otra = await segundaPestana(page, SUPERVISOR_2);

    const dialogo = await abrirDialogoCerrarSesion(page, SUPERVISOR_2);
    await dialogo.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(otra).toHaveURL(/\/login$/, { timeout: PLAZO_MS });
    await expect(botonCuenta(otra, SUPERVISOR_2)).toHaveCount(0);
    await expect(page).toHaveURL(/\/login$/);

    // Recargar la otra pestaña no recupera la sesión: la del servidor quedó revocada.
    await otra.reload();
    await expect(otra).toHaveURL(/\/login$/);
    await expect(botonCuenta(otra, SUPERVISOR_2)).toHaveCount(0);
  });

  test('con actividad en la otra pestaña, la primera no se bloquea por inactividad', async ({
    page,
  }) => {
    // Se adelanta el reloj de a un minuto durante 15 minutos y solo se usa la otra pestaña: la
    // primera pasa 15 minutos sin interacción propia, pero el usuario sigue trabajando.
    await page.clock.install();
    await iniciarSesionPorUI(page, SUPERVISOR_1);
    const otra = await segundaPestana(page, SUPERVISOR_1);

    for (let minuto = 1; minuto <= 15; minuto += 1) {
      await otra.keyboard.press('Shift');
      await page.clock.fastForward('01:00');
    }
    // Con la regla anterior la primera se bloqueaba al minuto 10 (y avisaba a la otra).
    await expect(pantallaBloqueo(page, SUPERVISOR_1)).toHaveCount(0);
    await expect(pantallaBloqueo(otra, SUPERVISOR_1)).toHaveCount(0);
    await expect(botonCuenta(page, SUPERVISOR_1)).toBeVisible();
    await expect(botonCuenta(otra, SUPERVISOR_1)).toBeVisible();

    // Cuando nadie la usa durante 10 minutos, se bloquean las dos.
    await page.clock.fastForward('10:00');
    await expect(pantallaBloqueo(page, SUPERVISOR_1)).toBeVisible({ timeout: PLAZO_MS });
    await expect(pantallaBloqueo(otra, SUPERVISOR_1)).toBeVisible({ timeout: PLAZO_MS });
  });

  test('sin actividad en ninguna pestaña, se bloquean las dos en menos de 2 s', async ({
    page,
  }) => {
    await page.clock.install();
    await iniciarSesionPorUI(page, SUPERVISOR_1);
    const otra = await segundaPestana(page, SUPERVISOR_1);
    await expect(pantallaBloqueo(page, SUPERVISOR_1)).toHaveCount(0);
    await expect(pantallaBloqueo(otra, SUPERVISOR_1)).toHaveCount(0);

    // Un minuto de margen sobre el límite de 10 por la interacción del propio login.
    await page.clock.fastForward('11:00');
    await expect(pantallaBloqueo(page, SUPERVISOR_1)).toBeVisible({ timeout: PLAZO_MS });
    await expect(pantallaBloqueo(otra, SUPERVISOR_1)).toBeVisible({ timeout: PLAZO_MS });
  });
});

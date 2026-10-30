// Ítem M7 (ADR 0023): cerrar sesión o bloquearse por inactividad en una pestaña se propaga a las
// demás pestañas del mismo navegador en menos de 2 s. Chromium.
//
// Las dos páginas comparten el contexto (cookies, IndexedDB y BroadcastChannel), como dos pestañas
// de la misma tablet.

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

  test('el bloqueo por inactividad en una pestaña bloquea la otra en menos de 2 s', async ({
    page,
  }) => {
    // El reloj controlado es del CONTEXTO (las dos pestañas). Se adelanta de a un minuto y la otra
    // pestaña se usa en cada paso: así solo la primera llega a 10 minutos sin interacción, y el
    // bloqueo de la otra solo puede venir del aviso entre pestañas.
    await page.clock.install();
    await iniciarSesionPorUI(page, SUPERVISOR_1);
    const otra = await segundaPestana(page, SUPERVISOR_1);
    const titulo = `Confirme que es ${SUPERVISOR_1.nombre}`;
    const bloqueoOtra = otra.getByRole('heading', { name: titulo });
    await expect(bloqueoOtra).toHaveCount(0);

    for (let minuto = 1; minuto <= 11; minuto += 1) {
      await otra.keyboard.press('Shift');
      await page.clock.fastForward('01:00');
    }
    await expect(page.getByRole('heading', { name: titulo })).toBeVisible();
    await expect(bloqueoOtra).toBeVisible({ timeout: PLAZO_MS });
  });
});

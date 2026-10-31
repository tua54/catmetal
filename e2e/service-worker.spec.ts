import { expect, test, type Page } from '@playwright/test';
import { abrirLogin } from './apoyo/ui';
import { cortarRed, restablecerRed } from './apoyo/red';

/** Espera a que el SW esté activo y controlando la página (tras instalar y precachear el shell). */
async function esperarControlDelSW(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // La primera carga puede no estar controlada hasta recargar; clientsClaim() suele adelantarlo.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test.describe('Service Worker y navegación sin conexión', () => {
  test('@humo el SW se registra, se activa y controla la página tras recargar', async ({
    page,
  }) => {
    await abrirLogin(page);
    await esperarControlDelSW(page);

    const registro = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        scriptURL: reg?.active?.scriptURL ?? null,
        estado: reg?.active?.state ?? null,
        controlada: navigator.serviceWorker.controller !== null,
      };
    });
    expect(registro.scriptURL).toMatch(/\/sw\.js$/);
    expect(registro.estado).toBe('activated');
    expect(registro.controlada).toBe(true);
  });

  test('@humo sin red, recargar la pantalla de login muestra el shell de la PWA', async ({
    page,
    context,
  }) => {
    await abrirLogin(page);
    await esperarControlDelSW(page);

    await cortarRed(context);
    try {
      await page.reload();

      await expect(
        page.getByRole('heading', { name: 'Control de Materia Prima', level: 1 }),
      ).toBeVisible();
      await expect(page.getByLabel('Correo')).toBeVisible();
      await expect(page.getByText('Solo pueden entrar quienes ya iniciaron sesión')).toBeVisible();
    } finally {
      await restablecerRed(context);
    }
  });

  test('sin red, una ruta interna de la SPA también se resuelve con el shell', async ({
    page,
    context,
  }) => {
    await abrirLogin(page);
    await esperarControlDelSW(page);

    await cortarRed(context);
    try {
      // Sin sesión, la guarda de rutas redirige al login: demuestra que el shell cargó y enrutó.
      await page.goto('/supervisor');
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel('Correo')).toBeVisible();
    } finally {
      await restablecerRed(context);
    }
  });
});

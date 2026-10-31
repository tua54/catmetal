import { defineConfig, devices } from '@playwright/test';
import { ORIGEN_E2E, URL_SALUD_E2E } from './scripts/e2e-config.mjs';

/**
 * E2E de la PWA (docs/plan-fase-4.md, tarea 4.4). Todo es local: `scripts/e2e-servidor.mjs` compila
 * la web, crea una D1 local aislada (apps/worker/.wrangler/e2e, con migraciones y seed) y lanza
 * `wrangler dev --local` en el puerto 8788.
 *
 * - `workers: 1` y `fullyParallel: false`: la base de datos es compartida por todas las pruebas.
 * - `baseURL` usa `localhost` (contexto seguro): la cookie de refresco es `Secure` y el Service Worker
 *   exige contexto seguro. La comprobación de salud usa 127.0.0.1 porque wrangler escucha solo en IPv4.
 * - Chromium ejecuta toda la suite; WebKit solo las pruebas de humo (`@humo`).
 */
export default defineConfig({
  testDir: './e2e',
  // Inicia sesión como jefe por API una sola vez (el login admite 5 intentos por minuto y correo).
  globalSetup: './e2e/global-setup.ts',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: ORIGEN_E2E,
    // Una tablet de planta en horizontal.
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-servidor.mjs',
    url: URL_SALUD_E2E,
    reuseExistingServer: !process.env.CI,
    // Incluye el build de la PWA, las migraciones y el seed antes de que wrangler escuche.
    timeout: 300_000,
    stderr: 'pipe',
    stdout: 'ignore',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 820 }, hasTouch: true },
    },
    {
      name: 'webkit',
      grep: /@humo/,
      use: { ...devices['Desktop Safari'], viewport: { width: 1180, height: 820 }, hasTouch: true },
    },
  ],
});

// Pruebas del Worker dentro del runtime de Workers (workerd) con @cloudflare/vitest-plugin.
// D1, R2, KV y Rate Limiting son los locales reales de Miniflare (sin mocks).
//
// Es .mjs a propósito: si fuera .ts tendría que entrar en el tsconfig del Worker y arrastraría
// @types/node (vía miniflare/undici) al programa de src/, que corre en workerd y no en Node.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Relativa al directorio del paquete: pnpm ejecuta los scripts con cwd = apps/worker.
const DIRECTORIO_MIGRACIONES = '../../migrations';

// Secretos fijos SOLO para pruebas. También se exponen en process.env porque Wrangler valida
// `secrets.required` contra .dev.vars/.env/process.env (si no, avisa en cada archivo de prueba).
const SECRETOS_DE_PRUEBA = {
  JWT_SECRET: 'secreto-jwt-de-prueba-no-usar-fuera-de-vitest',
  REFRESH_SECRET: 'secreto-refresh-de-prueba-no-usar-fuera-de-vitest',
};
for (const [nombre, valor] of Object.entries(SECRETOS_DE_PRUEBA)) {
  process.env[nombre] = valor;
}

const migraciones = await readD1Migrations(DIRECTORIO_MIGRACIONES);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ...SECRETOS_DE_PRUEBA,
          TEST_MIGRATIONS: migraciones,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/aplicar-migraciones.ts'],
    coverage: {
      // En el pool de Workers solo funciona istanbul (v8 no).
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      // Umbral mínimo del proyecto (CLAUDE.md). No se baja para pasar.
      thresholds: {
        lines: 80,
      },
    },
  },
});

// Configuración de Vitest para la PWA (jsdom + Testing Library).
// Es independiente de vite.config.ts para no cargar Tailwind ni el plugin PWA en las pruebas.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
      reporter: ['text', 'html', 'lcov'],
      // Sin umbral obligatorio en web por ahora: el 80 % aplica a apps/worker y packages/shared.
    },
  },
});

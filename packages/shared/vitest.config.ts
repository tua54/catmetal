import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      // Umbral mínimo del proyecto (CLAUDE.md, gates de calidad). No se baja para pasar.
      thresholds: {
        lines: 80,
      },
    },
  },
});

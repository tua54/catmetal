// Bindings que solo existen en las pruebas (los define `miniflare` en vitest.config.mjs).
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** Archivos de src/, migrations/ y scripts/ para las pruebas estáticas (vitest.config.mjs). */
      TEST_ARCHIVOS_FUENTE: { ruta: string; contenido: string }[];
      /** D1 limpia para la prueba de restauración del backup (ADR 0021). */
      DB_RESTAURADA: D1Database;
    }
  }
}

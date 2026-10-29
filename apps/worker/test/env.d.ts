// Bindings que solo existen en las pruebas (los define `miniflare.bindings` en vitest.config.ts).
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

// Constantes compartidas por el entorno E2E: scripts/e2e-servidor.mjs, playwright.config.ts y e2e/**.
//
// Nada de esto es un secreto: la base E2E es local, aislada y desechable (se borra en cada arranque),
// y la contraseña solo existe en esa base. Los secretos reales de desarrollo (apps/worker/.dev.vars)
// no se leen ni se escriben desde aquí.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Puerto propio de E2E: distinto de `pnpm dev` (8787 y 5173) para poder convivir con él. */
export const PUERTO_E2E = 8788;

/**
 * Origen que usan los navegadores y las llamadas a la API. `localhost` (y no 127.0.0.1) por la
 * cookie de refresco `Secure` (ADR 0008): los navegadores tratan `http://localhost` como contexto
 * seguro y WebKit solo la guarda ahí. Wrangler escucha en 127.0.0.1; los navegadores prueban IPv4.
 */
export const ORIGEN_E2E = `http://localhost:${PUERTO_E2E}`;

/** URL de salud que Playwright consulta para saber que el servidor está listo (IPv4 explícito). */
export const URL_SALUD_E2E = `http://127.0.0.1:${PUERTO_E2E}/api/v1/health`;

/**
 * Contraseña de los 4 usuarios del seed E2E. Es un valor de PRUEBA fijo y público: solo protege una
 * base desechable. Se puede cambiar con la variable de entorno `E2E_SEED_PASSWORD` (≥ 10 caracteres).
 */
export const CONTRASENA_E2E = process.env.E2E_SEED_PASSWORD ?? 'Prueba-E2E-Catmetal-2026';

/** Estado persistente de Miniflare (D1, R2, KV) de E2E: dentro de .wrangler/, ignorado por git. */
export const DIR_ESTADO_E2E = join(RAIZ, 'apps', 'worker', '.wrangler', 'e2e');

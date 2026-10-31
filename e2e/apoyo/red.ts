// Corte y restablecimiento de la red del navegador (equivale al modo avión de la tablet).

import type { BrowserContext } from '@playwright/test';

export async function cortarRed(contexto: BrowserContext): Promise<void> {
  await contexto.setOffline(true);
}

export async function restablecerRed(contexto: BrowserContext): Promise<void> {
  await contexto.setOffline(false);
}

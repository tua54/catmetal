// Humo (@humo, Chromium y WebKit): un supervisor registra un consumo CON conexión y el servidor lo
// recibe con su autoría.
//
// Limitaciones de WebKit observadas con Playwright 1.64 (WebKit 27.2) en Windows, sobre
// http://localhost (ADR 0008):
// - Cookie `Secure`: WebKit guarda `mp_refresh` (aparece en `context.cookies()`) pero no la envía
//   por http, ni en `localhost` ni en `127.0.0.1`. `/auth/refresh` responde 401 tras recargar y la app
//   vuelve al login con el perfil del dispositivo (ver login.spec.ts). Por eso esta prueba no
//   recarga: el access token vive en memoria y alcanza para sincronizar mientras no caduque (15 min).
// - Service Worker, caché del shell, IndexedDB y el login offline (verificador de 600.000
//   iteraciones, ~1,2 a 1,8 s frente a ~0,3 s en Chromium) sí funcionan en WebKit.
// - El registro SIN conexión (3 consumos con foto) y la tablet compartida se verifican solo en
//   Chromium (registro-offline.spec.ts y tablet-compartida.spec.ts): el criterio de cierre de la
//   Fase 4 pide WebKit solo como humo.

import { expect, test } from '@playwright/test';
import { consumosDeOrden } from './apoyo/api';
import {
  abrirRegistroDeConsumo,
  esperarTodoSincronizado,
  filaDeLote,
  loteUnico,
  registrarConsumoPorUI,
} from './apoyo/consumos';
import { iniciarSesionPorUI } from './apoyo/ui';
import { ORDEN_0587, SUPERVISOR_2 } from './apoyo/usuarios';

test.describe('Registro de consumo con conexión', () => {
  test('@humo el supervisor registra un consumo y el servidor lo recibe con su autoría', async ({
    page,
    request,
  }) => {
    const lote = loteUnico('HUMO');

    await iniciarSesionPorUI(page, SUPERVISOR_2);
    await abrirRegistroDeConsumo(page);
    await esperarTodoSincronizado(page);
    await registrarConsumoPorUI(page, {
      material: 'Pintura refractaria para moldes',
      cantidad: '1,5',
      lote,
    });

    // Con conexión se envía solo: la fila pasa de "Pendiente de sync" a "Sincronizado".
    await expect(filaDeLote(page, lote).getByText('Sincronizado')).toBeVisible({ timeout: 30_000 });
    await esperarTodoSincronizado(page);

    await expect
      .poll(async () =>
        (await consumosDeOrden(request, ORDEN_0587.id)).find((c) => c.lote === lote),
      )
      .toMatchObject({ registrado_por: SUPERVISOR_2.id, order_id: ORDEN_0587.id, cantidad: 1.5 });
  });
});

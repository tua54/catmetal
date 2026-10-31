// Fase 4, criterio de cierre (§10) y ADR 0008 punto 8: tablet compartida. Los pendientes de A no se
// envían con la sesión de B; cuando A vuelve a entrar, se envían con su autoría. Chromium.
//
// Todo ocurre en UN contexto de navegador (misma IndexedDB y mismas cookies), como en la planta.

import { expect, test, type Request } from '@playwright/test';
import { consumosDeOrden } from './apoyo/api';
import {
  abrirRegistroDeConsumo,
  esperarTodoSincronizado,
  filaDeLote,
  loteUnico,
  registrarConsumoPorUI,
} from './apoyo/consumos';
import { cortarRed, restablecerRed } from './apoyo/red';
import { abrirDialogoCerrarSesion, iniciarSesionPorUI } from './apoyo/ui';
import { ORDEN_0587, SUPERVISOR_1, SUPERVISOR_2 } from './apoyo/usuarios';

interface PushCapturado {
  user_id?: string;
  mutaciones?: unknown[];
  cuerpo: string;
}

test.describe('Tablet compartida', () => {
  test('los pendientes de A no se envían con la sesión de B; A los envía al volver', async ({
    page,
    context,
    request,
  }) => {
    const loteA = loteUnico('TABLET-A');
    const loteB = loteUnico('TABLET-B');
    const pushes: PushCapturado[] = [];
    // En el contexto (no en la página): también ve lo que envíe el Service Worker.
    context.on('request', (peticion: Request) => {
      if (peticion.method() === 'POST' && peticion.url().includes('/api/v1/sync/push')) {
        const cuerpo = peticion.postData() ?? '';
        const datos = JSON.parse(cuerpo) as Omit<PushCapturado, 'cuerpo'>;
        pushes.push({ ...datos, cuerpo });
      }
    });

    // 1. A (supervisor 1) entra con conexión y la tablet sincroniza (orden y catálogo).
    await iniciarSesionPorUI(page, SUPERVISOR_1);
    await abrirRegistroDeConsumo(page);
    await esperarTodoSincronizado(page);

    // 2. Sin red, A registra un consumo.
    await cortarRed(context);
    await registrarConsumoPorUI(page, { material: 'Arena sílice', cantidad: '50', lote: loteA });
    await expect(filaDeLote(page, loteA).getByText('Pendiente de sync')).toBeVisible();

    // 3. A cierra sesión: la app avisa de los pendientes y los conserva.
    const dialogo = await abrirDialogoCerrarSesion(page, SUPERVISOR_1);
    await expect(dialogo).toContainText(/Tiene 1 registro sin sincronizar/);
    await expect(dialogo).toContainText(/Nadie más puede enviarlos con su sesión/);
    await dialogo.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(/Hay 1 registro pendiente de Juan Sánchez/)).toBeVisible();
    // Ninguna petición de A llegó al servidor mientras no había red.
    expect(pushes).toHaveLength(0);

    // 4. Vuelve la red y B (supervisor 2) entra en la misma tablet. Ve el aviso de los pendientes de A.
    await restablecerRed(context);
    await iniciarSesionPorUI(page, SUPERVISOR_2);
    await expect(page.getByText(/Hay 1 registro pendiente de Juan Sánchez/)).toBeVisible();

    // 5. B registra su propio consumo y espera a que se sincronice.
    await abrirRegistroDeConsumo(page);
    await esperarTodoSincronizado(page);
    await registrarConsumoPorUI(page, { material: 'Resina furánica', cantidad: '3', lote: loteB });
    await expect(filaDeLote(page, loteB).getByText('Sincronizado')).toBeVisible({
      timeout: 30_000,
    });
    await esperarTodoSincronizado(page);
    // El aviso de los pendientes de A sigue ahí: no se enviaron.
    await expect(page.getByText(/Hay 1 registro pendiente de Juan Sánchez/)).toBeVisible();

    // 6. En el servidor: existe el consumo de B con su autoría y NO existe el de A.
    const durantePendientes = await consumosDeOrden(request, ORDEN_0587.id);
    const deB = durantePendientes.filter((c) => c.lote === loteB);
    expect(deB).toHaveLength(1);
    expect(deB[0]?.registrado_por).toBe(SUPERVISOR_2.id);
    expect(durantePendientes.some((c) => c.lote === loteA)).toBe(false);

    // 7. Lo que B envió: todos los lotes de push llevan el user_id de B y ninguno contiene el
    //    consumo de A (ni su lote ni nada que lo identifique).
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) {
      expect(push.user_id).toBe(SUPERVISOR_2.id);
      expect(push.cuerpo).not.toContain(loteA);
      expect(push.cuerpo).not.toContain(SUPERVISOR_1.id);
    }
    expect(pushes.some((p) => p.cuerpo.includes(loteB))).toBe(true);
    const enviadosPorB = pushes.length;

    // 8. B cierra sesión (todo sincronizado: no hay advertencia de pendientes).
    const dialogoB = await abrirDialogoCerrarSesion(page, SUPERVISOR_2);
    await expect(dialogoB).toContainText(/Todo está sincronizado/);
    await dialogoB.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 9. A vuelve a entrar con conexión: sus pendientes se envían ahora, con su autoría.
    await iniciarSesionPorUI(page, SUPERVISOR_1);
    await esperarTodoSincronizado(page);
    await abrirRegistroDeConsumo(page);
    await expect(filaDeLote(page, loteA).getByText('Sincronizado')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () =>
        (await consumosDeOrden(request, ORDEN_0587.id)).find((c) => c.lote === loteA),
      )
      .toMatchObject({ registrado_por: SUPERVISOR_1.id, order_id: ORDEN_0587.id });

    // El envío de A es un push nuevo, con user_id de A, y contiene su lote.
    const deA = pushes.slice(enviadosPorB);
    expect(deA.length).toBeGreaterThan(0);
    for (const push of deA) {
      expect(push.user_id).toBe(SUPERVISOR_1.id);
      expect(push.cuerpo).not.toContain(loteB);
    }
    expect(deA.some((p) => p.cuerpo.includes(loteA))).toBe(true);

    // El consumo de B sigue intacto y con su autor.
    const final = await consumosDeOrden(request, ORDEN_0587.id);
    expect(final.find((c) => c.lote === loteB)?.registrado_por).toBe(SUPERVISOR_2.id);
    expect(final.filter((c) => c.lote === loteA)).toHaveLength(1);
  });
});

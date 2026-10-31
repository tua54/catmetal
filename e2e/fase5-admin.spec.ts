// Fase 5: el admin crea un supervisor, lo asigna a una orden y ese supervisor la ve en su tablet.
// Chromium. El admin y el jefe de apoyo se crean por API para no gastar intentos de login de los
// usuarios del seed.

import { expect, test } from '@playwright/test';
import { llamarApiOk } from './apoyo/fase5';
import { crearUsuarioPorApi, iniciarOrdenPorApi, ORDEN_0588 } from './apoyo/fase5';
import { cerrarSesionPorUI, iniciarSesionPorUI } from './apoyo/ui';
import { CONTRASENA, type UsuarioSeed } from './apoyo/usuarios';
import { randomBytes } from 'node:crypto';

test.describe('Administración', () => {
  test('el admin crea un supervisor, lo asigna a la orden OP-2026-0588 y ese supervisor la ve', async ({
    page,
    request,
  }) => {
    const admin = await crearUsuarioPorApi(request, 'admin', 'Asigna');
    const jefe = await crearUsuarioPorApi(request, 'jefe', 'Inicia');
    // La orden solo aparece en "Mis órdenes en proceso" cuando está en proceso: la inicia un jefe.
    await iniciarOrdenPorApi(request, jefe, ORDEN_0588.id);

    const sufijo = randomBytes(3).toString('hex');
    const nuevo: UsuarioSeed = {
      id: '',
      nombre: `Supervisor Nuevo ${sufijo}`,
      email: `supervisor.nuevo.${sufijo}@catmetal.test`,
      rol: 'supervisor',
      inicio: '/supervisor',
    };

    // 1. El admin entra y crea el usuario desde "Crear usuario".
    await iniciarSesionPorUI(page, admin);
    await expect(page.getByRole('heading', { name: 'Administración', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Crear usuario' }).click();
    const dialogoCrear = page.getByRole('dialog', { name: 'Crear usuario' });
    await dialogoCrear.getByLabel('Nombre completo').fill(nuevo.nombre);
    await dialogoCrear.getByLabel('Correo').fill(nuevo.email);
    await dialogoCrear.getByLabel('Rol').selectOption({ label: 'Supervisor' });
    await dialogoCrear.getByLabel(/^Contraseña/).fill(CONTRASENA);
    await dialogoCrear.getByRole('button', { name: 'Crear usuario' }).click();
    await expect(page.getByText('Usuario creado')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Usuarios' })).toContainText(nuevo.email);

    // 2. Lo asigna a OP-2026-0588 desde "Asignaciones".
    await page.getByRole('link', { name: 'Asignaciones' }).click();
    await page.getByLabel('Orden de producción').selectOption(ORDEN_0588.id);
    const grupo = page.getByRole('group', {
      name: `Supervisores de la orden ${ORDEN_0588.codigo}`,
    });
    await expect(grupo).toBeVisible();
    await grupo.getByRole('checkbox', { name: new RegExp(nuevo.nombre) }).check();
    await page.getByRole('button', { name: 'Guardar asignaciones' }).click();
    const confirmacion = page.getByRole('alertdialog');
    await expect(confirmacion).toContainText(nuevo.nombre);
    await confirmacion.getByRole('button', { name: 'Guardar asignaciones' }).click();
    await expect(page.getByText('Asignaciones guardadas')).toBeVisible();

    // 3. El servidor tiene la asignación y conserva a los supervisores que ya estaban.
    const detalle = await llamarApiOk<{ supervisores: { nombre: string; user_id: string }[] }>(
      request,
      admin,
      'GET',
      `/orders/${ORDEN_0588.id}`,
    );
    expect(detalle.supervisores.map((s) => s.nombre)).toContain(nuevo.nombre);
    expect(detalle.supervisores.length).toBeGreaterThanOrEqual(2);

    // 4. El supervisor nuevo inicia sesión y ve la orden en "Mis órdenes en proceso".
    await cerrarSesionPorUI(page, admin);
    await iniciarSesionPorUI(page, nuevo);
    await expect(
      page.getByRole('heading', { name: 'Mis órdenes en proceso', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: `Registrar consumo en la orden ${ORDEN_0588.codigo}` }),
    ).toBeVisible({ timeout: 30_000 });
    // La orden 0587 no es suya: no la ve.
    await expect(
      page.getByRole('link', { name: 'Registrar consumo en la orden OP-2026-0587' }),
    ).toHaveCount(0);
  });
});

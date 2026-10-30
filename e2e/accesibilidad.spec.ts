// Fase 6 (spec §10): accesibilidad automatizada con axe-core (WCAG 2.0/2.1 A y AA) sobre las
// pantallas principales de cada rol. Chromium. Sin violaciones `serious` ni `critical`; las
// `moderate` y `minor` se listan en la consola y como anotaciones de la prueba (no fallan).
//
// axe solo detecta una parte de los problemas de accesibilidad: no sustituye la revisión manual con
// lector de pantalla y teclado.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loteUnico } from './apoyo/consumos';
import {
  asignarSupervisoresPorApi,
  crearUsuarioPorApi,
  MATERIAL,
  registrarConsumoPorApi,
} from './apoyo/fase5';
import { abrirLogin, iniciarSesionPorUI } from './apoyo/ui';
import { ORDEN_0587 } from './apoyo/usuarios';

const ETIQUETAS_WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Analiza la pantalla actual, informa de todo y falla solo con `serious` o `critical`. */
async function analizar(page: Page, pantalla: string): Promise<void> {
  // Sin transiciones en curso: axe mide el contraste con la opacidad final (los avisos y diálogos
  // entran con animación y darían falsos positivos).
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animacion) => animacion.finished.catch(() => null)),
    );
  });
  let resultado = await new AxeBuilder({ page }).withTags(ETIQUETAS_WCAG).analyze();
  // Los avisos (toasts) entran con una animación que `getAnimations` no siempre ve y axe puede medir
  // el contraste con el texto a medio aparecer. Si hay contraste, se espera y se mide de nuevo: una
  // violación real persiste; una transitoria no.
  if (resultado.violations.some((v) => v.id === 'color-contrast')) {
    await page.waitForTimeout(1000);
    resultado = await new AxeBuilder({ page }).withTags(ETIQUETAS_WCAG).analyze();
  }
  const resumen = (v: (typeof resultado.violations)[number]) =>
    `${v.id} [${v.impact ?? 'sin impacto'}] ${v.help} (${v.nodes.length} elemento(s)): ${v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(' '))
      .join(' | ')}`;

  const graves = resultado.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const leves = resultado.violations.filter((v) => v.impact === 'moderate' || v.impact === 'minor');
  for (const v of resultado.violations) {
    console.log(`[axe] ${pantalla}: ${resumen(v)}`);
    if (process.env.AXE_DETALLE === '1') {
      for (const n of v.nodes.slice(0, 15)) {
        console.log(
          `[axe-detalle] ${v.id} ${n.html.slice(0, 220)} :: ${JSON.stringify(n.any.map((a): unknown => a.data)).slice(0, 320)}`,
        );
      }
    }
    test.info().annotations.push({
      type: `axe ${v.impact ?? ''}`.trim(),
      description: `${pantalla}: ${resumen(v)}`,
    });
  }
  for (const i of resultado.incomplete) {
    console.log(`[axe] ${pantalla}: por revisar a mano: ${i.id} (${i.nodes.length} elemento(s))`);
  }
  console.log(
    `[axe] ${pantalla}: ${resultado.passes.length} reglas cumplidas, ${graves.length} graves/críticas, ${leves.length} moderadas/leves, ${resultado.incomplete.length} por revisar a mano`,
  );
  // `soft`: una violación no oculta las de las pantallas siguientes; la prueba falla al terminar.
  expect.soft(graves.map(resumen), `Violaciones serious/critical en "${pantalla}"`).toEqual([]);
}

test.describe('Accesibilidad (axe, WCAG 2.1 AA)', () => {
  test('login', async ({ page }) => {
    await abrirLogin(page);
    await analizar(page, 'Login');
  });

  test('supervisor: inicio, registro de consumo con novedad abierta y estado de sincronización', async ({
    page,
    request,
  }) => {
    const supervisor = await crearUsuarioPorApi(request, 'supervisor', 'Axe');
    await asignarSupervisoresPorApi(request, ORDEN_0587.id, [supervisor]);
    await iniciarSesionPorUI(page, supervisor);

    // Inicio: espera a que la orden esté en la tablet.
    await expect(
      page.getByRole('link', { name: `Registrar consumo en la orden ${ORDEN_0587.codigo}` }),
    ).toBeVisible({ timeout: 30_000 });
    await analizar(page, 'Supervisor · Mis órdenes');

    // Registro de consumo, con el bloque de novedad abierto y un material elegido.
    await page
      .getByRole('link', { name: `Registrar consumo en la orden ${ORDEN_0587.codigo}` })
      .click();
    await expect(page.getByRole('combobox', { name: /Materia prima/ })).toBeVisible();
    await analizar(page, 'Supervisor · Registro de consumo (formulario vacío)');
    await page.getByRole('combobox', { name: /Materia prima/ }).fill(MATERIAL.arena.nombre);
    await page.getByRole('option', { name: new RegExp(MATERIAL.arena.nombre) }).click();
    await page.getByRole('switch', { name: /novedad/i }).click();
    await expect(page.getByLabel('Tipo de novedad')).toBeVisible();
    await analizar(page, 'Supervisor · Registro de consumo (novedad abierta)');

    // Con un registro guardado, la lista de "Registros de hoy" también se analiza.
    await page.getByRole('switch', { name: /novedad/i }).click();
    await page.getByLabel('Cantidad utilizada').fill('5');
    await page.getByLabel('Lote').fill(loteUnico('AXE'));
    await page.getByRole('button', { name: /Guardar registro/ }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Lote E2E-AXE' })).toBeVisible();
    await analizar(page, 'Supervisor · Registro de consumo (con registros de hoy)');

    // Estado de sincronización (desde el menú de la cuenta).
    await page.getByRole('button', { name: /^Cuenta de/ }).click();
    await page.getByRole('link', { name: 'Estado de sincronización' }).click();
    await expect(page).toHaveURL(/\/sincronizacion$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await analizar(page, 'Estado de sincronización');
  });

  test('jefe: validación con el diálogo de rechazo abierto y órdenes', async ({
    page,
    request,
  }) => {
    const supervisor = await crearUsuarioPorApi(request, 'supervisor', 'AxeJefe');
    const jefe = await crearUsuarioPorApi(request, 'jefe', 'Axe');
    await asignarSupervisoresPorApi(request, ORDEN_0587.id, [supervisor]);
    const lote = loteUnico('AXEJEFE');
    const respuesta = await registrarConsumoPorApi(request, supervisor, {
      ordenId: ORDEN_0587.id,
      materialId: MATERIAL.nodulizante.id,
      cantidad: 1,
      unidad: 'kg',
      lote,
    });
    expect(respuesta.status()).toBe(201);

    await iniciarSesionPorUI(page, jefe);
    await expect(page.getByRole('heading', { name: 'Validación de consumos' })).toBeVisible();
    const tarjeta = page
      .getByRole('list', { name: 'Consumos por validar' })
      .getByRole('listitem')
      .filter({ hasText: `Lote ${lote}` });
    await expect(tarjeta).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('list', { name: 'Trazabilidad completa de la orden' }),
    ).toBeVisible();
    await analizar(page, 'Jefe · Validación de consumos');

    await tarjeta.getByRole('button', { name: `Rechazar ${MATERIAL.nodulizante.nombre}` }).click();
    const dialogo = page.getByRole('alertdialog', { name: 'Rechazar consumo' });
    await expect(dialogo).toBeVisible();
    await analizar(page, 'Jefe · Diálogo "Rechazar consumo"');
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);

    await page.getByRole('link', { name: 'Órdenes de producción' }).click();
    await expect(page).toHaveURL(/\/jefe\/ordenes$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await analizar(page, 'Jefe · Órdenes de producción');
  });

  test('admin: usuarios y diálogo de creación', async ({ page, request }) => {
    const admin = await crearUsuarioPorApi(request, 'admin', 'Axe');
    await iniciarSesionPorUI(page, admin);
    await expect(page.getByRole('heading', { name: 'Administración', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Usuarios' })).toBeVisible();
    await analizar(page, 'Admin · Usuarios');

    await page.getByRole('button', { name: 'Crear usuario' }).click();
    await expect(page.getByRole('dialog', { name: 'Crear usuario' })).toBeVisible();
    await analizar(page, 'Admin · Diálogo "Crear usuario"');
  });
});

// Fase 5 (spec §10): el jefe no puede aprobar un consumo propio (S9) ni uno con `requiere_novedad`,
// ni por la interfaz (botón deshabilitado con su motivo) ni por la API (403 / 422). Chromium.
//
// La interfaz del jefe no registra consumos: los consumos de estas pruebas se crean con la API,
// que es también la única forma de registrar un consumo que supera el plan sin novedad (la
// pantalla del supervisor obliga a escribirla).

import { expect, test, type Page } from '@playwright/test';
import { consumosDeOrden } from './apoyo/api';
import { loteUnico } from './apoyo/consumos';
import {
  asignarSupervisoresPorApi,
  codigoDeError,
  crearUsuarioPorApi,
  cuerpoAprobar,
  llamarApi,
  MATERIAL,
  registrarConsumoPorApi,
} from './apoyo/fase5';
import { iniciarSesionPorUI } from './apoyo/ui';
import { ORDEN_0587 } from './apoyo/usuarios';
import { uuidV7 } from './apoyo/api';
import type { Consumo } from '../packages/shared/src/tipos';

const MOTIVO_PROPIO = 'Registrado por usted: requiere otro jefe';
const MOTIVO_FALTA_NOVEDAD = 'Falta la justificación de la novedad: el supervisor debe registrarla';

function tarjetaDeLote(page: Page, lote: string) {
  return page
    .getByRole('list', { name: 'Consumos por validar' })
    .getByRole('listitem')
    .filter({ hasText: `Lote ${lote}` });
}

test.describe('El jefe no puede aprobar todo', () => {
  test('un consumo registrado por el propio jefe: botón deshabilitado en la UI y 403 AUTOAPROBACION en la API', async ({
    page,
    request,
  }) => {
    const jefe = await crearUsuarioPorApi(request, 'jefe', 'Propio');
    const lote = loteUnico('PROPIO');

    // El jefe registra un consumo (permiso consumos.registrar) por la API.
    const respuesta = await registrarConsumoPorApi(request, jefe, {
      ordenId: ORDEN_0587.id,
      materialId: MATERIAL.arena.id,
      cantidad: 1,
      unidad: 'kg',
      lote,
    });
    expect(respuesta.status()).toBe(201);
    const consumo = (await respuesta.json()) as Consumo;
    expect(consumo.registrado_por).toBe(jefe.id);

    // UI: su propio consumo aparece en la cola, pero no se puede validar ni rechazar.
    await iniciarSesionPorUI(page, jefe);
    const tarjeta = tarjetaDeLote(page, lote);
    await expect(tarjeta).toBeVisible({ timeout: 30_000 });
    const validar = tarjeta.getByRole('button', {
      name: `Validar gasto de ${MATERIAL.arena.nombre}`,
    });
    await expect(validar).toHaveAttribute('aria-disabled', 'true');
    await expect(tarjeta.getByText(MOTIVO_PROPIO)).toBeVisible();
    await expect(validar).toHaveAccessibleDescription(MOTIVO_PROPIO);
    await expect(
      tarjeta.getByRole('button', { name: `Rechazar ${MATERIAL.arena.nombre}` }),
    ).toHaveAttribute('aria-disabled', 'true');
    // Pulsarlo no abre el diálogo de confirmación.
    // `force`: Playwright trata aria-disabled como deshabilitado y no haría el clic; aquí se prueba que
    // un clic real no abre nada.
    await validar.click({ force: true });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // API: 403 AUTOAPROBACION, y el consumo sigue pendiente.
    const aprobar = await llamarApi(
      request,
      jefe,
      'POST',
      `/consumptions/${consumo.id}/approve`,
      cuerpoAprobar(consumo.version),
    );
    expect(aprobar.status()).toBe(403);
    expect(await codigoDeError(aprobar)).toBe('AUTOAPROBACION');
    const despues = (await consumosDeOrden(request, ORDEN_0587.id)).find(
      (c) => c.id === consumo.id,
    );
    expect(despues?.estado).toBe('pendiente');
    expect(despues?.validacion).toBeNull();
  });

  test('un consumo con requiere_novedad: sin la novedad no se aprueba (UI y API); con la novedad sí', async ({
    page,
    request,
  }) => {
    const supervisor = await crearUsuarioPorApi(request, 'supervisor', 'Novedad');
    const jefe = await crearUsuarioPorApi(request, 'jefe', 'Novedad');
    await asignarSupervisoresPorApi(request, ORDEN_0587.id, [supervisor]);
    const lote = loteUnico('SINNOV');
    const material = MATERIAL.inoculante.nombre;

    // El supervisor registra por API 500 kg de un material con plan de 18 kg: supera plan + tolerancia
    // y el servidor lo marca `requiere_novedad`. (La pantalla del supervisor exige la novedad.)
    const respuesta = await registrarConsumoPorApi(request, supervisor, {
      ordenId: ORDEN_0587.id,
      materialId: MATERIAL.inoculante.id,
      cantidad: 500,
      unidad: 'kg',
      lote,
    });
    expect(respuesta.status()).toBe(201);
    const consumo = (await respuesta.json()) as Consumo;
    expect(consumo.requiere_novedad).toBe(true);

    // UI: "Validar gasto" deshabilitado con el motivo.
    await iniciarSesionPorUI(page, jefe);
    const tarjeta = tarjetaDeLote(page, lote);
    await expect(tarjeta).toBeVisible({ timeout: 30_000 });
    const validar = tarjeta.getByRole('button', { name: `Validar gasto de ${material}` });
    await expect(validar).toHaveAttribute('aria-disabled', 'true');
    await expect(tarjeta.getByText(MOTIVO_FALTA_NOVEDAD)).toBeVisible();
    // `force`: Playwright trata aria-disabled como deshabilitado y no haría el clic; aquí se prueba que
    // un clic real no abre nada.
    await validar.click({ force: true });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // API: 422 REQUIERE_NOVEDAD.
    const rechazada = await llamarApi(
      request,
      jefe,
      'POST',
      `/consumptions/${consumo.id}/approve`,
      cuerpoAprobar(consumo.version),
    );
    expect(rechazada.status()).toBe(422);
    expect(await codigoDeError(rechazada)).toBe('REQUIERE_NOVEDAD');

    // El supervisor registra la novedad (API). Ahora el jefe puede aprobar desde la UI.
    const novedad = await llamarApi(
      request,
      supervisor,
      'POST',
      `/consumptions/${consumo.id}/incident`,
      {
        id: uuidV7(),
        consumption_id: consumo.id,
        tipo: 'otro',
        descripcion: 'Carga extraordinaria autorizada por el turno (prueba E2E).',
        client_created_at: new Date().toISOString(),
        evidencias: [],
      },
    );
    expect(novedad.status()).toBe(201);

    await page.reload();
    const tarjetaConNovedad = tarjetaDeLote(page, lote);
    await expect(tarjetaConNovedad).toBeVisible({ timeout: 30_000 });
    await expect(tarjetaConNovedad).toContainText('Carga extraordinaria autorizada');
    const validarAhora = tarjetaConNovedad.getByRole('button', {
      name: `Validar gasto de ${material}`,
    });
    await expect(validarAhora).not.toHaveAttribute('aria-disabled', 'true');
    await validarAhora.click();
    await page
      .getByRole('alertdialog', { name: '¿Validar este gasto?' })
      .getByRole('button', { name: 'Validar gasto' })
      .click();
    await expect(page.getByText('Consumo validado')).toBeVisible();

    const final = (await consumosDeOrden(request, ORDEN_0587.id)).find((c) => c.id === consumo.id);
    expect(final?.estado).toBe('aprobado');
    expect(final?.validacion?.validado_por).toBe(jefe.id);
    expect(final?.novedades).toHaveLength(1);
  });
});

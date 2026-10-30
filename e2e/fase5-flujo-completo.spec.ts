// Fase 5 (spec §10): el supervisor registra, el jefe rechaza con motivo, el supervisor ve el motivo y
// crea la corrección, el jefe aprueba la corrección y todo queda en la auditoría. Chromium.
//
// Dos contextos de navegador = dos tablets/equipos distintos (supervisor y jefe). Los usuarios se
// crean por API para esta prueba (no consumen intentos de login de los del seed).

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { consumosDeOrden } from './apoyo/api';
import {
  abrirRegistroDeConsumo,
  esperarTodoSincronizado,
  filaDeLote,
  loteUnico,
  registrarConsumoPorUI,
} from './apoyo/consumos';
import {
  asignarSupervisoresPorApi,
  crearUsuarioPorApi,
  lineaDeTiempo,
  MATERIAL,
} from './apoyo/fase5';
import { cortarRed, restablecerRed } from './apoyo/red';
import { iniciarSesionPorUI } from './apoyo/ui';
import { ORDEN_0587 } from './apoyo/usuarios';

/** Fuerza una sincronización inmediata (el evento `online` la dispara; si no, el ciclo es de 60 s). */
async function sincronizarAhora(page: Page, context: BrowserContext): Promise<void> {
  await cortarRed(context);
  await restablecerRed(context);
  await esperarTodoSincronizado(page);
}

/** Tarjeta de la cola del jefe que contiene el lote. */
function tarjetaDeLote(page: Page, lote: string) {
  return page
    .getByRole('list', { name: 'Consumos por validar' })
    .getByRole('listitem')
    .filter({ hasText: `Lote ${lote}` });
}

test.describe('Flujo completo: registro, rechazo, corrección y aprobación', () => {
  test('el motivo del rechazo llega al supervisor, la corrección se aprueba y todo queda en la auditoría', async ({
    page: paginaSupervisor,
    context: contextoSupervisor,
    browser,
    baseURL,
    request,
  }) => {
    const supervisor = await crearUsuarioPorApi(request, 'supervisor', 'Flujo');
    const jefe = await crearUsuarioPorApi(request, 'jefe', 'Flujo');
    await asignarSupervisoresPorApi(request, ORDEN_0587.id, [supervisor]);
    const lote = loteUnico('FLUJO');
    const material = MATERIAL.nodulizante.nombre;
    const motivo =
      'Cantidad mal pesada: vuelva a registrar con el peso de la báscula (prueba E2E).';

    const contextoJefe = await browser.newContext({
      baseURL,
      viewport: { width: 1180, height: 820 },
      hasTouch: true,
      locale: 'es-CO',
      timezoneId: 'America/Bogota',
    });
    const paginaJefe = await contextoJefe.newPage();

    try {
      // 1. El supervisor registra un consumo con conexión y se sincroniza.
      await iniciarSesionPorUI(paginaSupervisor, supervisor);
      await abrirRegistroDeConsumo(paginaSupervisor);
      await esperarTodoSincronizado(paginaSupervisor);
      await registrarConsumoPorUI(paginaSupervisor, { material, cantidad: '2', lote });
      await expect(filaDeLote(paginaSupervisor, lote).getByText('Sincronizado')).toBeVisible({
        timeout: 30_000,
      });

      // 2. El jefe lo ve en su cola y lo rechaza con un motivo.
      await iniciarSesionPorUI(paginaJefe, jefe);
      await expect(
        paginaJefe.getByRole('heading', { name: 'Validación de consumos' }),
      ).toBeVisible();
      const tarjeta = tarjetaDeLote(paginaJefe, lote);
      await expect(tarjeta).toBeVisible({ timeout: 30_000 });
      await tarjeta.getByRole('button', { name: `Rechazar ${material}` }).click();
      const dialogoRechazo = paginaJefe.getByRole('alertdialog', { name: 'Rechazar consumo' });
      await dialogoRechazo.getByRole('textbox', { name: /Motivo del rechazo/ }).fill(motivo);
      await dialogoRechazo.getByRole('button', { name: 'Rechazar consumo' }).click();
      await expect(paginaJefe.getByText('Consumo rechazado')).toBeVisible();
      await expect(tarjetaDeLote(paginaJefe, lote)).toHaveCount(0);

      // 3. El supervisor sincroniza, ve el chip "Rechazado" y lee el motivo exacto.
      await sincronizarAhora(paginaSupervisor, contextoSupervisor);
      const chipRechazado = filaDeLote(paginaSupervisor, lote).getByRole('button', {
        name: /Rechazado/,
      });
      await expect(chipRechazado).toBeVisible({ timeout: 30_000 });
      await chipRechazado.click();
      const dialogoMotivo = paginaSupervisor.getByRole('dialog');
      await expect(dialogoMotivo).toContainText('Motivo del rechazo:');
      await expect(dialogoMotivo).toContainText(motivo);

      // 4. Crea la corrección: el formulario llega precargado y corrige la cantidad.
      await dialogoMotivo.getByRole('button', { name: 'Crear corrección' }).click();
      await expect(
        paginaSupervisor.getByRole('heading', { name: 'Corrección del consumo rechazado' }),
      ).toBeVisible();
      await expect(paginaSupervisor.getByRole('combobox', { name: /Materia prima/ })).toHaveValue(
        new RegExp(material),
      );
      await expect(paginaSupervisor.getByLabel('Lote')).toHaveValue(lote);
      await expect(paginaSupervisor.getByLabel('Cantidad utilizada')).toHaveValue('2');
      await paginaSupervisor.getByLabel('Cantidad utilizada').fill('3');
      await paginaSupervisor.getByRole('button', { name: /Guardar registro/ }).click();
      await expect(
        paginaSupervisor
          .getByRole('listitem')
          .filter({ hasText: `Lote ${lote}` })
          .filter({ hasText: 'Corrección' }),
      ).toBeVisible();
      await esperarTodoSincronizado(paginaSupervisor);

      // 5. El jefe ve la corrección en su cola (marcada como tal) y la aprueba.
      await paginaJefe.reload();
      const tarjetaCorreccion = tarjetaDeLote(paginaJefe, lote);
      await expect(tarjetaCorreccion).toBeVisible({ timeout: 30_000 });
      await expect(tarjetaCorreccion).toContainText(
        'Corrección de un consumo rechazado anteriormente.',
      );
      await expect(tarjetaCorreccion).toContainText('3 kg');
      await tarjetaCorreccion.getByRole('button', { name: `Validar gasto de ${material}` }).click();
      const dialogoValidar = paginaJefe.getByRole('alertdialog', { name: '¿Validar este gasto?' });
      await dialogoValidar.getByRole('button', { name: 'Validar gasto' }).click();
      await expect(paginaJefe.getByText('Consumo validado')).toBeVisible();

      // 6. El supervisor sincroniza y ve "Validado por jefe" en la corrección.
      await sincronizarAhora(paginaSupervisor, contextoSupervisor);
      await expect(
        paginaSupervisor
          .getByRole('listitem')
          .filter({ hasText: `Lote ${lote}` })
          .filter({ hasText: 'Validado por jefe' }),
      ).toBeVisible({ timeout: 30_000 });

      // 7. Servidor: el original rechazado, la corrección aprobada y enlazada.
      const consumos = (await consumosDeOrden(request, ORDEN_0587.id)).filter(
        (c) => c.lote === lote,
      );
      expect(consumos).toHaveLength(2);
      const original = consumos.find((c) => c.corrige_a === null);
      const correccion = consumos.find((c) => c.corrige_a !== null);
      expect(original?.estado).toBe('rechazado');
      expect(original?.cantidad).toBe(2);
      expect(original?.validacion?.decision).toBe('rechazado');
      expect(original?.validacion?.motivo).toBe(motivo);
      expect(correccion?.estado).toBe('aprobado');
      expect(correccion?.cantidad).toBe(3);
      expect(correccion?.corrige_a).toBe(original?.id);
      expect(correccion?.registrado_por).toBe(supervisor.id);
      expect(correccion?.validacion?.decision).toBe('aprobado');
      expect(correccion?.validacion?.validado_por).toBe(jefe.id);

      // 8. Auditoría (API): registro → rechazo con motivo → corrección → validación, en ese orden.
      const ids = new Set([original?.id, correccion?.id]);
      const eventos = (await lineaDeTiempo(request, ORDEN_0587.id)).filter(
        (e) => e.consumption_id !== null && ids.has(e.consumption_id),
      );
      const descripciones = eventos.map((e) => e.descripcion);
      console.log(`[medida] auditoría del flujo:\n  ${descripciones.join('\n  ')}`);
      const secuencia = [
        /^Registró 2 kg de Nodulizante FeSiMg$/,
        new RegExp(`^Rechazó consumo de Nodulizante FeSiMg: ${motivo.slice(0, 20)}`),
        /^Registró corrección: 3 kg de Nodulizante FeSiMg$/,
        /^Validó consumo de Nodulizante FeSiMg$/,
      ];
      let desde = 0;
      for (const patron of secuencia) {
        const indice = descripciones.findIndex((d, i) => i >= desde && patron.test(d));
        expect(
          indice,
          `evento ${String(patron)} después de la posición ${desde}`,
        ).toBeGreaterThanOrEqual(0);
        desde = indice + 1;
      }
      // Los eventos están ordenados por `seq` (orden de ocurrencia en el servidor).
      const seqs = eventos.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      // Registro del supervisor; rechazo y validación del jefe (actor del evento).
      const deRechazo = eventos.find((e) => e.entidad === 'validations' && e.tipo === 'rechazo');
      const deValidacion = eventos.find(
        (e) => e.entidad === 'validations' && e.tipo === 'validacion',
      );
      expect(deRechazo?.actor?.id).toBe(jefe.id);
      expect(deValidacion?.actor?.id).toBe(jefe.id);

      // 9. Auditoría (UI del jefe): la región de trazabilidad muestra los mismos eventos en orden.
      await paginaJefe.goto(`/jefe?orden=${ORDEN_0587.id}`);
      const linea = paginaJefe.getByRole('list', { name: 'Trazabilidad completa de la orden' });
      await expect(linea).toBeVisible();
      while (
        await paginaJefe.getByRole('button', { name: 'Cargar más', exact: true }).isVisible()
      ) {
        await paginaJefe.getByRole('button', { name: 'Cargar más', exact: true }).click();
      }
      const textos = await linea.getByRole('listitem').allInnerTexts();
      const relevantes = textos.filter((t) => t.includes('Nodulizante FeSiMg'));
      const enUi = [
        /Registró 2 kg de Nodulizante FeSiMg/,
        new RegExp(`Rechazó consumo de Nodulizante FeSiMg: ${motivo.slice(0, 20)}`),
        /Registró corrección: 3 kg de Nodulizante FeSiMg/,
        /Validó consumo de Nodulizante FeSiMg/,
      ];
      let posicion = 0;
      for (const patron of enUi) {
        const indice = relevantes.findIndex((t, i) => i >= posicion && patron.test(t));
        expect(indice, `en la UI: ${String(patron)}`).toBeGreaterThanOrEqual(0);
        posicion = indice + 1;
      }
    } finally {
      await contextoJefe.close();
    }
  });
});

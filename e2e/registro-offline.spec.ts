// Fase 4, criterio de cierre (§10): con la red cortada se registran 3 consumos (uno con novedad y
// foto) y, al reconectar, los 3 quedan en D1 y la foto en R2. Chromium.
//
// La verificación se hace en el servidor, no en la UI: la API como jefe (`GET /orders/:id/consumptions`
// y `GET /evidences/:id`).
//
// M2 (ADR 0019): cada push lleva `enviado_at` y cada escritura REST `X-Hora-Dispositivo` (la hora del
// dispositivo AL ENVIAR), y la auditoría de lo registrado sin conexión queda con `alerta_reloj = 0`
// aunque `client_created_at` sea anterior al envío.

import { expect, test, type Request } from '@playwright/test';
import type { ListaAuditoria } from '../packages/shared/src/reportes';
import { consumosDeOrden, getComoJefe, getCrudoComoJefe } from './apoyo/api';
import {
  abrirRegistroDeConsumo,
  esperarTodoSincronizado,
  filaDeLote,
  loteUnico,
  MARCA_EXIF_FIXTURE,
  pildora,
  RUTA_FOTO_CON_EXIF,
  registrarConsumoPorUI,
  segmentosExif,
} from './apoyo/consumos';
import { cortarRed, restablecerRed } from './apoyo/red';
import { ORDEN_0587, SUPERVISOR_1 } from './apoyo/usuarios';
import { iniciarSesionPorUI } from './apoyo/ui';
import { readFileSync } from 'node:fs';
import type { Evidencia } from '../packages/shared/src/tipos';

test.describe('Registro sin conexión y sincronización al reconectar', () => {
  test('3 consumos sin red (uno con novedad y foto) llegan a D1 y a R2 al reconectar', async ({
    page,
    context,
    request,
  }) => {
    const lotes = {
      arena: loteUnico('ARENA'),
      resina: loteUnico('RESINA'),
      catalizador: loteUnico('CATAL'),
    };
    // En el contexto (no en la página): también ve lo que envíe el Service Worker.
    const pushes: { enviado_at?: unknown; mutaciones?: unknown[] }[] = [];
    const subidasDeFotos: { hora: string | null; enviadaAt: number }[] = [];
    context.on('request', (peticion: Request) => {
      if (peticion.method() === 'POST' && peticion.url().includes('/api/v1/sync/push')) {
        pushes.push(JSON.parse(peticion.postData() ?? '{}') as (typeof pushes)[number]);
      }
      if (peticion.method() === 'PUT' && peticion.url().includes('/api/v1/evidences/')) {
        subidasDeFotos.push({
          hora: peticion.headers()['x-hora-dispositivo'] ?? null,
          enviadaAt: Date.now(),
        });
      }
    });

    // 1. Con conexión: login y primera sincronización (la orden llega a la tablet).
    await iniciarSesionPorUI(page, SUPERVISOR_1);
    await abrirRegistroDeConsumo(page);
    await esperarTodoSincronizado(page);

    // 2. Se corta la red: la píldora lo dice.
    await cortarRed(context);
    await expect(pildora(page, /Sin conexión/)).toBeVisible();

    // 3. Tres registros con materiales y lotes distintos, todos dentro del plan (sin novedad
    //    obligatoria). El de resina lleva una novedad voluntaria con foto.
    await registrarConsumoPorUI(page, {
      material: 'Arena sílice',
      cantidad: '100',
      lote: lotes.arena,
    });
    await registrarConsumoPorUI(page, {
      material: 'Resina furánica',
      cantidad: '2,5',
      lote: lotes.resina,
      novedad: {
        tipo: 'Reproceso',
        descripcion: 'Reproceso por sellado defectuoso en el lote anterior (prueba E2E).',
        fotos: [RUTA_FOTO_CON_EXIF],
      },
    });
    await registrarConsumoPorUI(page, {
      material: 'Catalizador para resina furánica',
      cantidad: '1',
      lote: lotes.catalizador,
    });

    // 4. La UI muestra los 3 registros pendientes y la píldora lo cuenta.
    for (const lote of Object.values(lotes)) {
      await expect(filaDeLote(page, lote).getByText('Pendiente de sync')).toBeVisible();
    }
    await expect(page.getByText('Pendiente de sync')).toHaveCount(3);
    // La píldora cuenta elementos de la cola, no filas: 3 consumos + 1 novedad + 1 foto = 5.
    const pendientes = pildora(page, /Sin conexión.*5 por sincronizar/);
    await expect(pendientes).toBeVisible();
    console.log(`[medida] píldora sin conexión: "${(await pendientes.innerText()).trim()}"`);
    // Todavía nada llegó al servidor.
    const antes = await consumosDeOrden(request, ORDEN_0587.id);
    expect(antes.filter((c) => Object.values(lotes).includes(c.lote))).toHaveLength(0);

    // 5. Se restablece la red: la app sincroniza sola y vuelve a "Todo sincronizado".
    const inicioSync = Date.now();
    await restablecerRed(context);
    await esperarTodoSincronizado(page);
    console.log(`[medida] sincronización al reconectar: ${Date.now() - inicioSync} ms`);
    for (const lote of Object.values(lotes)) {
      await expect(filaDeLote(page, lote).getByText('Sincronizado')).toBeVisible();
    }

    // 6. En el servidor: los 3 consumos, con su lote y su autor.
    const consumos = await consumosDeOrden(request, ORDEN_0587.id);
    for (const lote of Object.values(lotes)) {
      const encontrados = consumos.filter((c) => c.lote === lote);
      expect(encontrados, `consumo con lote ${lote}`).toHaveLength(1);
      expect(encontrados[0]?.registrado_por).toBe(SUPERVISOR_1.id);
      expect(encontrados[0]?.order_id).toBe(ORDEN_0587.id);
    }
    const resina = consumos.find((c) => c.lote === lotes.resina);
    const arena = consumos.find((c) => c.lote === lotes.arena);
    expect(arena?.novedades).toHaveLength(0);

    // 7. La novedad existe con su evidencia ya subida.
    expect(resina?.novedades).toHaveLength(1);
    const novedad = resina?.novedades[0];
    expect(novedad?.tipo).toBe('reproceso');
    expect(novedad?.registrado_por).toBe(SUPERVISOR_1.id);
    expect(novedad?.descripcion).toContain('sellado defectuoso');
    expect(novedad?.evidencias).toHaveLength(1);
    const evidencia: Evidencia | undefined = novedad?.evidencias[0];
    expect(evidencia?.subido).toBe(true);
    expect(evidencia?.mime).toBe('image/jpeg');

    // 8. La foto está en R2: GET /evidences/:id la sirve como JPEG.
    const respuesta = await getCrudoComoJefe(request, `/evidences/${evidencia?.id ?? ''}`);
    expect(respuesta.status()).toBe(200);
    expect(respuesta.headers()['content-type']).toBe('image/jpeg');
    const cuerpo = await respuesta.body();
    expect([...cuerpo.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(cuerpo.length).toBe(evidencia?.tamano_bytes);

    // 9. Sin EXIF: la foto original lo traía (la prueba es válida solo si el origen lo contenía) y la
    //    servida no tiene segmento APP1 "Exif" ni la marca de GPS del original.
    const original = readFileSync(RUTA_FOTO_CON_EXIF);
    expect(segmentosExif(original)).toBe(1);
    expect(original.includes(MARCA_EXIF_FIXTURE)).toBe(true);
    expect(segmentosExif(cuerpo)).toBe(0);
    expect(cuerpo.includes('Exif')).toBe(false);
    expect(cuerpo.includes(MARCA_EXIF_FIXTURE)).toBe(false);

    // 10. M2: la hora de envío viaja en cada push y en la subida de la foto.
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const conMutaciones = pushes.filter((p) => (p.mutaciones?.length ?? 0) > 0);
    expect(conMutaciones.length).toBeGreaterThan(0);
    for (const push of pushes) {
      expect(push.enviado_at).toMatch(ISO);
    }
    expect(subidasDeFotos).toHaveLength(1);
    expect(subidasDeFotos[0]?.hora).toMatch(ISO);
    // La hora de la cabecera es la del momento del envío (± 1 min), no la del registro.
    expect(
      Math.abs(Date.parse(subidasDeFotos[0]?.hora ?? '') - (subidasDeFotos[0]?.enviadaAt ?? 0)),
    ).toBeLessThan(60_000);

    // 11. La auditoría de lo registrado sin conexión no marca el reloj: `client_at` (la hora del
    //     registro) es anterior a `server_at`, pero la alerta compara la hora de ENVÍO.
    const entidades: [string, string][] = [
      ...Object.values(lotes).map((lote): [string, string] => [
        'consumptions',
        consumos.find((c) => c.lote === lote)?.id ?? '',
      ]),
      ['incidents', novedad?.id ?? ''],
    ];
    for (const [entidad, id] of entidades) {
      const { entradas } = await getComoJefe<ListaAuditoria>(
        request,
        `/audit?entidad=${entidad}&entidad_id=${id}`,
      );
      expect(entradas.length, `auditoría de ${entidad} ${id}`).toBeGreaterThan(0);
      for (const entrada of entradas) {
        expect(entrada.alerta_reloj, `alerta_reloj de ${entrada.accion} ${id}`).toBe(false);
        if (entrada.client_at !== null) {
          expect(Date.parse(entrada.client_at)).toBeLessThan(Date.parse(entrada.server_at));
        }
      }
    }
  });
});

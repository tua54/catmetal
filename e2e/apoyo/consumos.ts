// Flujos de la pantalla del supervisor (registro de consumos) y utilidades de sincronización.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { ORDEN_0587 } from './usuarios';

/** JPEG de 320×240 con un segmento APP1 "Exif" sintético (GPS y modelo del equipo de mentira). */
export const RUTA_FOTO_CON_EXIF = join(import.meta.dirname, '..', 'fixtures', 'pieza-con-exif.jpg');
export const MARCA_EXIF_FIXTURE = 'GPS-E2E-CATMETAL';

export interface DatosConsumo {
  /** Nombre del material tal como aparece en el catálogo ("Arena sílice"). */
  material: string;
  /** Texto de la cantidad como se escribe ("100" o "12,5"). */
  cantidad: string;
  lote: string;
  novedad?: {
    /** Etiqueta del tipo: "Reproceso", "Merma", "Daño"… */
    tipo: string;
    descripcion: string;
    /** Rutas de fotos a adjuntar. */
    fotos?: string[];
  };
}

/** Lote único por ejecución y por prueba: permite reconocer los consumos propios en el servidor. */
export function loteUnico(prefijo: string): string {
  return `E2E-${prefijo}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Píldora de conexión de la barra superior ("En línea · Todo sincronizado"). */
export function pildora(page: Page, texto: RegExp): Locator {
  return page.getByRole('status').filter({ hasText: texto });
}

export const TEXTO_TODO_SINCRONIZADO = /En línea.*Todo sincronizado/;

/** Espera a que la cola local quede vacía y la app esté en línea. */
export async function esperarTodoSincronizado(page: Page): Promise<void> {
  await expect(pildora(page, TEXTO_TODO_SINCRONIZADO)).toBeVisible({ timeout: 30_000 });
}

/**
 * Desde `/supervisor` (adonde lleva el login del supervisor), espera a que la orden esté en la tablet
 * (la primera sincronización trae el snapshot) y abre el formulario de registro. No recarga la
 * página con `goto`: en WebKit una recarga pierde la sesión en línea (cookie `Secure` sin enviar).
 */
export async function abrirRegistroDeConsumo(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/supervisor$/);
  const enlace = page.getByRole('link', {
    name: `Registrar consumo en la orden ${ORDEN_0587.codigo}`,
  });
  await expect(enlace).toBeVisible({ timeout: 30_000 });
  await enlace.click();
  await expect(
    page.getByRole('heading', { name: `Registro de consumo · ${ORDEN_0587.codigo}`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: /Materia prima/ })).toBeVisible();
}

/** Llena y guarda el formulario "Nuevo registro de material". Espera a que el registro aparezca en la lista. */
export async function registrarConsumoPorUI(page: Page, datos: DatosConsumo): Promise<void> {
  const material = page.getByRole('combobox', { name: /Materia prima/ });
  await material.fill(datos.material);
  await page.getByRole('option', { name: new RegExp(datos.material) }).click();
  await page.getByLabel('Cantidad utilizada').fill(datos.cantidad);
  await page.getByLabel('Lote').fill(datos.lote);

  if (datos.novedad !== undefined) {
    await page.getByRole('switch', { name: /novedad/i }).click();
    await page.getByLabel('Tipo de novedad').selectOption({ label: datos.novedad.tipo });
    await page.getByLabel('Justificación').fill(datos.novedad.descripcion);
    const fotos = datos.novedad.fotos ?? [];
    if (fotos.length > 0) {
      await page.locator('input[type="file"]').setInputFiles(fotos);
      // La app recomprime a JPEG antes de guardar: hay que esperar a que termine.
      await expect(
        page.getByText(fotos.length === 1 ? '1 foto adjunta' : `${fotos.length} fotos adjuntas`),
      ).toBeVisible();
    }
  }

  await page.getByRole('button', { name: /Guardar registro/ }).click();
  // Los avisos de guardado se acumulan en pantalla: la señal fiable es la fila nueva de "Registros de
  // hoy" y el formulario reiniciado.
  await expect(filaDeLote(page, datos.lote)).toBeVisible();
  await expect(material).toHaveValue('');
}

/** Fila de "Registros de hoy" que contiene el lote. */
export function filaDeLote(page: Page, lote: string): Locator {
  return page.getByRole('listitem').filter({ hasText: `Lote ${lote}` });
}

/**
 * Cuenta los segmentos APP1 "Exif\0\0" de la cabecera de un JPEG (recorre hasta el inicio de los
 * datos de imagen). Devuelve `null` si los bytes no son un JPEG.
 */
export function segmentosExif(jpeg: Buffer): number | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return null;
  }
  let cantidad = 0;
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marcador = jpeg[pos + 1] ?? 0;
    if (marcador === 0xda || marcador === 0xd9) {
      break;
    }
    const largo = jpeg.readUInt16BE(pos + 2);
    if (marcador === 0xe1 && jpeg.subarray(pos + 4, pos + 10).toString('latin1') === 'Exif\0\0') {
      cantidad += 1;
    }
    pos += 2 + largo;
  }
  return cantidad;
}

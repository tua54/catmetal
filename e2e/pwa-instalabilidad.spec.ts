// Fase 6 (spec §10): instalabilidad de la PWA verificada con una prueba automatizada: manifest
// válido con íconos, Service Worker que controla la página y arranque offline de `start_url`.
// Chromium.
//
// La categoría PWA de Lighthouse ya no existe; esta prueba la reemplaza. Además se consulta a
// Chromium si considera la app instalable (`Page.getInstallabilityErrors`, protocolo de DevTools).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { abrirLogin } from './apoyo/ui';
import { cortarRed, restablecerRed } from './apoyo/red';

interface IconoManifest {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  name?: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  scope?: string;
  id?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  lang?: string;
  icons?: IconoManifest[];
}

const REGEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Ancho y alto declarados en la cabecera IHDR de un PNG. */
function dimensionesPng(png: Buffer): { ancho: number; alto: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(FIRMA_PNG)) {
    return null;
  }
  return { ancho: png.readUInt32BE(16), alto: png.readUInt32BE(20) };
}

async function esperarControlDelSW(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test.describe('Instalabilidad PWA', () => {
  test('el manifest está enlazado, es válido y sus íconos PNG responden con el tamaño declarado', async ({
    page,
    request,
  }) => {
    await abrirLogin(page);

    // Enlazado desde el HTML y servido con un tipo de manifest.
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href, 'El HTML debe enlazar el manifest').toBeTruthy();
    const urlManifest = new URL(href ?? '', page.url());
    const respuesta = await request.get(urlManifest.href);
    expect(respuesta.status()).toBe(200);
    expect(respuesta.headers()['content-type']).toMatch(/application\/(manifest\+json|json)/);
    const manifest = (await respuesta.json()) as Manifest;

    // Campos obligatorios para instalar y los que exige la spec.
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect((manifest.short_name ?? '').length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(REGEX_COLOR);
    expect(manifest.background_color).toMatch(REGEX_COLOR);
    expect(manifest.lang).toBeTruthy();

    // `start_url` y `scope` dentro del mismo origen; `start_url` dentro del alcance.
    const origen = new URL(page.url()).origin;
    const inicio = new URL(manifest.start_url ?? '', urlManifest);
    const alcance = new URL(manifest.scope ?? '', urlManifest);
    expect(inicio.origin).toBe(origen);
    expect(alcance.origin).toBe(origen);
    expect(inicio.pathname.startsWith(alcance.pathname)).toBe(true);

    // Íconos: 192 y 512 "any" y un 512 "maskable", todos PNG reales del tamaño declarado.
    const iconos = manifest.icons ?? [];
    const propositos = (icono: IconoManifest) => (icono.purpose ?? 'any').split(/\s+/);
    const buscar = (tamano: string, proposito: string) =>
      iconos.find((i) => i.sizes === tamano && propositos(i).includes(proposito));
    const requeridos = [
      buscar('192x192', 'any'),
      buscar('512x512', 'any'),
      buscar('512x512', 'maskable'),
    ];
    for (const icono of requeridos) {
      expect(icono, 'faltan íconos 192/512 any y 512 maskable').toBeDefined();
    }
    for (const icono of iconos) {
      expect(icono.type).toBe('image/png');
      const resultado = await request.get(new URL(icono.src, urlManifest).href);
      expect(resultado.status(), `GET ${icono.src}`).toBe(200);
      expect(resultado.headers()['content-type']).toBe('image/png');
      const dimensiones = dimensionesPng(await resultado.body());
      expect(dimensiones, `${icono.src} debe ser un PNG`).not.toBeNull();
      const [ancho, alto] = icono.sizes.split('x').map(Number);
      expect(dimensiones).toEqual({ ancho, alto });
    }
  });

  test('el Service Worker está activo y controla la página', async ({ page }) => {
    await abrirLogin(page);
    await esperarControlDelSW(page);

    const sw = await page.evaluate(async () => {
      const registro = await navigator.serviceWorker.getRegistration();
      return {
        estado: registro?.active?.state ?? null,
        script: registro?.active?.scriptURL ?? null,
        alcance: registro?.scope ?? null,
        controla: navigator.serviceWorker.controller !== null,
      };
    });
    expect(sw.estado).toBe('activated');
    expect(sw.script).toMatch(/\/sw\.js$/);
    expect(sw.controla).toBe(true);
    expect(new URL(sw.alcance ?? '').pathname).toBe('/');
  });

  test('Chromium no reporta errores de instalabilidad (y sí los reporta si falta el ícono)', async ({
    baseURL,
  }) => {
    // `Page.getInstallabilityErrors` solo funciona en el Chromium completo (`channel: 'chromium'`,
    // nuevo modo headless) y fuera de incógnito: el "headless shell" que usa Playwright por defecto
    // devuelve SIEMPRE una lista vacía (verificado: ni sin manifest ni sin íconos reporta nada), y un
    // contexto de Playwright es incógnito ("in-incognito"). Por eso esta prueba lanza su propio
    // navegador con un perfil persistente temporal.
    const url = baseURL ?? '';
    const erroresDe = async (opciones: { sinIconos: boolean }): Promise<string[]> => {
      const perfil = await mkdtemp(join(tmpdir(), 'catmetal-e2e-instalable-'));
      const contexto = await chromium.launchPersistentContext(perfil, {
        channel: 'chromium',
        headless: true,
        baseURL: url,
        // Sin SW en el control negativo: así el manifest alterado no lo sirve la caché del SW.
        serviceWorkers: opciones.sinIconos ? 'block' : 'allow',
      });
      try {
        const pagina = contexto.pages()[0] ?? (await contexto.newPage());
        if (opciones.sinIconos) {
          await pagina.route('**/manifest.webmanifest', async (ruta) => {
            const respuesta = await ruta.fetch();
            const manifest = (await respuesta.json()) as Manifest;
            await ruta.fulfill({ response: respuesta, json: { ...manifest, icons: [] } });
          });
        }
        await pagina.goto('/login');
        if (!opciones.sinIconos) {
          await esperarControlDelSW(pagina);
        }
        const cdp = await contexto.newCDPSession(pagina);
        // Margen para que Chromium termine de evaluar el manifest, el SW y los íconos.
        await pagina.waitForTimeout(1000);
        // La comprobación de instalabilidad es asíncrona: se reintenta hasta que el resultado se
        // estabiliza (con errores) o se agota el tiempo.
        let errores: string[] = [];
        for (let intento = 0; intento < 10; intento += 1) {
          const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
            installabilityErrors: { errorId: string }[];
          };
          errores = installabilityErrors.map((e) => e.errorId);
          if (errores.length > 0 || opciones.sinIconos === false) {
            break;
          }
          await pagina.waitForTimeout(500);
        }
        if (!opciones.sinIconos) {
          const { url: urlManifest, errors } = (await cdp.send('Page.getAppManifest')) as {
            url: string;
            errors: unknown[];
          };
          expect(urlManifest).toMatch(/manifest.webmanifest$/);
          expect(errors, 'errores de análisis del manifest').toEqual([]);
        }
        return errores;
      } finally {
        await contexto.close();
        await rm(perfil, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    };

    // Control negativo primero: demuestra que la señal detecta un manifest sin íconos.
    expect(await erroresDe({ sinIconos: true })).toContain('manifest-missing-suitable-icon');
    // La app real: lista vacía = Chromium ofrecería instalarla.
    expect(await erroresDe({ sinIconos: false })).toEqual([]);
  });

  test('con el SW instalado y sin red, una página nueva abre `start_url` con el shell', async ({
    page,
    context,
    request,
  }) => {
    await abrirLogin(page);
    await esperarControlDelSW(page);

    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const urlManifest = new URL(href ?? '', page.url());
    const manifest = (await (await request.get(urlManifest.href)).json()) as Manifest;
    const inicio = new URL(manifest.start_url ?? '/', urlManifest);

    await cortarRed(context);
    try {
      // Página nueva (no una recarga): arranque en frío de la app instalada sin conexión.
      const nueva = await context.newPage();
      const respuesta = await nueva.goto(inicio.href);
      expect(respuesta?.ok()).toBe(true);
      // Sin sesión, `/` lleva al login: el shell cargó, enrutó y no hay pantalla de error.
      await expect(nueva).toHaveURL(/\/login$/);
      await expect(
        nueva.getByRole('heading', { name: 'Control de Materia Prima', level: 1 }),
      ).toBeVisible();
      await expect(nueva.getByLabel('Correo')).toBeVisible();
      expect(
        await nueva.evaluate(() => navigator.serviceWorker.controller !== null),
        'la página nueva debe estar controlada por el SW',
      ).toBe(true);
      await nueva.close();
    } finally {
      await restablecerRed(context);
    }
  });
});

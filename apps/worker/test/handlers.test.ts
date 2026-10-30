// Pruebas unitarias de los handlers del Worker: `scheduled` y la delegación a Static Assets.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { CABECERAS_SEGURIDAD } from '../src/cabeceras';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Binding ASSETS de prueba que delega cada petición en `respuestas`. */
function assetsFalso(respuestas: (request: Request) => Response): Fetcher {
  return {
    fetch: (entrada: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(respuestas(new Request(entrada, init))),
    connect: () => {
      throw new Error('no usado');
    },
  };
}

function llamar(request: Request, assets: Fetcher): Promise<Response> {
  const ctx = createExecutionContext();
  return Promise.resolve(worker.fetch(request, { ...env, ASSETS: assets }, ctx));
}

describe('scheduled', () => {
  // Desde la tarea 6.1 el cron hace backup y mantenimiento (detalle en fase6-cron-*.test.ts): ya no
  // deja un único log, sino inicio (`cron_ejecutado`), resúmenes y cierre (`cron_fin`).
  it('se ejecuta sin error y deja logs estructurados de inicio y fin', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller = createScheduledController({
      scheduledTime: new Date('2026-10-30T08:00:00.000Z'),
      cron: '0 8 * * *',
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    const eventos = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(eventos[0]).toMatchObject({
      nivel: 'info',
      evento: 'cron_ejecutado',
      cron: '0 8 * * *',
      programado_para: '2026-10-30T08:00:00.000Z',
    });
    expect(eventos.at(-1)).toMatchObject({
      nivel: 'info',
      evento: 'cron_fin',
      backup: 'completo',
      mantenimiento: 'hecho',
    });
  });
});

describe('rutas fuera de /api', () => {
  it('se delegan a ASSETS y llevan las cabeceras de seguridad aunque la respuesta sea inmutable', async () => {
    const pedidas: string[] = [];
    const assets = assetsFalso((request) => {
      pedidas.push(new URL(request.url).pathname);
      // Response.redirect crea cabeceras inmutables, igual que las de env.ASSETS.fetch.
      return Response.redirect('https://catmetal.test/index.html', 307);
    });
    const respuesta = await llamar(new Request('https://catmetal.test/ordenes/123'), assets);
    expect(pedidas).toEqual(['/ordenes/123']);
    expect(respuesta.status).toBe(307);
    expect(respuesta.headers.get('Location')).toBe('https://catmetal.test/index.html');
    for (const [nombre, valor] of Object.entries(CABECERAS_SEGURIDAD)) {
      expect(respuesta.headers.get(nombre), nombre).toBe(valor);
    }
    // Los assets conservan su propia política de caché (no se fuerza no-store).
    expect(respuesta.headers.get('Cache-Control')).toBeNull();
  });

  // F4-10: antes esta prueba usaba `/` y esperaba que se conservara `public, max-age=0`. Ahora el
  // shell lleva siempre `no-cache` (prueba siguiente); lo que se conserva es la política de los
  // assets con hash, por eso se prueba con uno de `/assets/*`.
  it('conserva cuerpo, estado, tipo y Cache-Control de un asset con hash', async () => {
    const assets = assetsFalso(
      () =>
        new Response('console.log(1);', {
          status: 200,
          headers: {
            'Content-Type': 'text/javascript',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        }),
    );
    const respuesta = await llamar(
      new Request('https://catmetal.test/assets/index-Bx12abCd.js'),
      assets,
    );
    expect(respuesta.status).toBe(200);
    expect(await respuesta.text()).toBe('console.log(1);');
    expect(respuesta.headers.get('Content-Type')).toBe('text/javascript');
    expect(respuesta.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(respuesta.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('el shell, el Service Worker, el manifest y todo HTML llevan Cache-Control: no-cache', async () => {
    const assets = assetsFalso((request) => {
      const ruta = new URL(request.url).pathname;
      const tipo = ruta.endsWith('.js')
        ? 'text/javascript'
        : ruta.endsWith('.webmanifest')
          ? 'application/manifest+json'
          : 'text/html; charset=utf-8';
      return new Response('x', {
        headers: { 'Content-Type': tipo, 'Cache-Control': 'public, max-age=3600' },
      });
    });
    for (const ruta of [
      '/',
      '/index.html',
      '/sw.js',
      '/manifest.webmanifest',
      '/ordenes/123',
      '/assets/no-existe',
    ]) {
      const respuesta = await llamar(new Request(`https://catmetal.test${ruta}`), assets);
      expect(respuesta.headers.get('Cache-Control'), ruta).toBe('no-cache');
      expect(respuesta.headers.get('X-Content-Type-Options'), ruta).toBe('nosniff');
    }
  });

  it('/api/* nunca se delega a ASSETS', async () => {
    const assets = assetsFalso(() => {
      throw new Error('ASSETS no debía llamarse');
    });
    const respuesta = await llamar(new Request('https://catmetal.test/api/v1/nada'), assets);
    expect(respuesta.status).toBe(404);
    expect(await respuesta.json()).toMatchObject({ code: 'NO_ENCONTRADO' });
  });

  it('con el binding ASSETS real responde el build de la PWA (o su marcador) con cabeceras', async () => {
    const respuesta = await llamar(new Request('https://catmetal.test/'), env.ASSETS);
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toMatch(/text\/html/);
    expect(await respuesta.text()).toMatch(/<!doctype html>/i);
    expect(respuesta.headers.get('Content-Security-Policy')).toBeTruthy();
  });

  it('una ruta de la SPA desconocida devuelve index.html (single-page-application)', async () => {
    const respuesta = await llamar(
      new Request('https://catmetal.test/validacion/cola'),
      env.ASSETS,
    );
    expect(respuesta.status).toBe(200);
    expect(await respuesta.text()).toMatch(/<!doctype html>/i);
    expect(respuesta.headers.get('Cache-Control')).toBe('no-cache');
  });
});

// F4-10 de docs/auditoria/seguridad-fase-4.md, de punta a punta: el Worker real
// (`exports.default.fetch`) con el binding ASSETS real sobre apps/web/dist (el build de la PWA o los
// marcadores de scripts/ensure-web-dist.mjs, que también crean sw.js y manifest.webmanifest).
describe('cabeceras de los archivos sin hash de la PWA (Worker y ASSETS reales)', () => {
  async function pedir(ruta: string): Promise<Response> {
    return exports.default.fetch(new Request(`https://catmetal.test${ruta}`));
  }

  function esperarCabecerasPwa(respuesta: Response, ruta: string): void {
    for (const [nombre, valor] of Object.entries(CABECERAS_SEGURIDAD)) {
      expect(respuesta.headers.get(nombre), `${ruta}: ${nombre}`).toBe(valor);
    }
    expect(respuesta.headers.get('Cache-Control'), ruta).toBe('no-cache');
  }

  it('/sw.js: JavaScript con CSP, nosniff y no-cache', async () => {
    const respuesta = await pedir('/sw.js');
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toMatch(/javascript/);
    expect((await respuesta.text()).length).toBeGreaterThan(0);
    esperarCabecerasPwa(respuesta, '/sw.js');
  });

  it('/: el shell con CSP, nosniff y no-cache', async () => {
    const respuesta = await pedir('/');
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toMatch(/text\/html/);
    expect(await respuesta.text()).toMatch(/<!doctype html>/i);
    esperarCabecerasPwa(respuesta, '/');
  });

  it('/manifest.webmanifest y una navegación de la SPA llevan no-cache', async () => {
    const manifest = await pedir('/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toHaveProperty('name');
    esperarCabecerasPwa(manifest, '/manifest.webmanifest');

    const navegacion = await exports.default.fetch(
      new Request('https://catmetal.test/ordenes/123', {
        headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
      }),
    );
    expect(navegacion.status).toBe(200);
    expect(await navegacion.text()).toMatch(/<!doctype html>/i);
    esperarCabecerasPwa(navegacion, '/ordenes/123');
  });

  it('/index.html (redirección a / de Static Assets) también lleva no-cache', async () => {
    const respuesta = await pedir('/index.html');
    await respuesta.body?.cancel();
    esperarCabecerasPwa(respuesta, '/index.html');
  });
});

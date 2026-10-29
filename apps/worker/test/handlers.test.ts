// Pruebas unitarias de los handlers del Worker: `scheduled` y la delegación a Static Assets.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
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
  it('se ejecuta sin error y deja un log estructurado', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller = createScheduledController({
      scheduledTime: new Date('2026-10-30T08:00:00.000Z'),
      cron: '0 8 * * *',
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      nivel: 'info',
      evento: 'cron_ejecutado',
      cron: '0 8 * * *',
      programado_para: '2026-10-30T08:00:00.000Z',
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

  it('conserva cuerpo, estado y tipo del asset', async () => {
    const assets = assetsFalso(
      () =>
        new Response('<!doctype html><title>PWA</title>', {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=0',
          },
        }),
    );
    const respuesta = await llamar(new Request('https://catmetal.test/'), assets);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.text()).toBe('<!doctype html><title>PWA</title>');
    expect(respuesta.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(respuesta.headers.get('Cache-Control')).toBe('public, max-age=0');
    expect(respuesta.headers.get('X-Frame-Options')).toBe('DENY');
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
  });
});

// Pruebas de integración de la API dentro de workerd (exports.default = el Worker real).
import { crearConsumoSchema, MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CABECERAS_SEGURIDAD, cabecerasSeguridad, POLITICA_CSP } from '../src/cabeceras';
import { ErrorApi, manejarError, manejarNoEncontrado } from '../src/errores';
import { validar } from '../src/validacion';

const BASE = 'https://catmetal.test';

function esperarCabecerasSeguridad(respuesta: Response): void {
  for (const [nombre, valor] of Object.entries(CABECERAS_SEGURIDAD)) {
    expect(respuesta.headers.get(nombre), nombre).toBe(valor);
  }
}

/** App de prueba con los mismos manejadores de la app real, para ejercitar errores y validación. */
function appDePrueba(): Hono {
  const app = new Hono();
  app.use('*', cabecerasSeguridad);
  app.onError(manejarError);
  app.notFound(manejarNoEncontrado);
  app.get('/api/v1/error-api', () => {
    throw new ErrorApi('CONSUMO_NO_PENDIENTE', { id: 'x' });
  });
  app.get('/api/v1/error-inesperado', () => {
    throw new Error('fallo interno con detalle sensible');
  });
  app.get('/api/v1/http-exception/:estado', (c) => {
    throw new HTTPException(Number(c.req.param('estado')) as 400);
  });
  app.post('/api/v1/consumos', validar('json', crearConsumoSchema), (c) => {
    const datos = c.req.valid('json');
    return c.json({ id: datos.id, lote: datos.lote }, 201);
  });
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/health', () => {
  it('responde 200 con ok, entorno local y hora del servidor', async () => {
    const respuesta = await exports.default.fetch(`${BASE}/api/v1/health`);
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toMatch(/^application\/json/);
    const cuerpo = await respuesta.json<{ ok: boolean; entorno: string; hora_servidor: string }>();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.entorno).toBe('local');
    expect(Number.isNaN(Date.parse(cuerpo.hora_servidor))).toBe(false);
    expect(cuerpo.hora_servidor).toMatch(/Z$/);
  });

  it('incluye todas las cabeceras de seguridad y no se cachea', async () => {
    const respuesta = await exports.default.fetch(`${BASE}/api/v1/health`);
    esperarCabecerasSeguridad(respuesta);
    expect(respuesta.headers.get('Cache-Control')).toBe('no-store');
    expect(respuesta.headers.get('Content-Security-Policy')).toBe(POLITICA_CSP);
    expect(POLITICA_CSP).toContain("frame-ancestors 'none'");
    expect(POLITICA_CSP).not.toContain('unsafe-inline');
  });
});

describe('rutas /api desconocidas', () => {
  for (const ruta of ['/api/v1/no-existe', '/api/no-existe', '/api', '/api/v2/health']) {
    it(`${ruta} responde 404 JSON con el formato único`, async () => {
      const respuesta = await exports.default.fetch(`${BASE}${ruta}`);
      expect(respuesta.status).toBe(404);
      expect(respuesta.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(await respuesta.json()).toEqual({
        code: 'NO_ENCONTRADO',
        message: MENSAJES_ERROR.NO_ENCONTRADO,
      });
      esperarCabecerasSeguridad(respuesta);
      expect(respuesta.headers.get('Cache-Control')).toBe('no-store');
    });
  }

  it('un método no definido en una ruta existente también responde 404 JSON', async () => {
    // Con Origin propio: sin él, el filtro CSRF responde 403 antes de buscar la ruta.
    const respuesta = await exports.default.fetch(`${BASE}/api/v1/health`, {
      method: 'DELETE',
      headers: { Origin: BASE },
    });
    expect(respuesta.status).toBe(404);
    expect(await respuesta.json()).toMatchObject({ code: 'NO_ENCONTRADO' });
  });
});

describe('manejo de errores', () => {
  it('ErrorApi se traduce a su código, estado HTTP y details', async () => {
    const respuesta = await appDePrueba().request('/api/v1/error-api');
    expect(respuesta.status).toBe(409);
    expect(await respuesta.json()).toEqual({
      code: 'CONSUMO_NO_PENDIENTE',
      message: MENSAJES_ERROR.CONSUMO_NO_PENDIENTE,
      details: { id: 'x' },
    });
    esperarCabecerasSeguridad(respuesta);
  });

  it('un error inesperado responde 500 ERROR_INTERNO sin filtrar el detalle y deja log estructurado', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const respuesta = await appDePrueba().request('/api/v1/error-inesperado?email=ana@catmetal.co');
    expect(respuesta.status).toBe(500);
    const cuerpo = await respuesta.json();
    expect(cuerpo).toEqual({ code: 'ERROR_INTERNO', message: MENSAJES_ERROR.ERROR_INTERNO });
    expect(JSON.stringify(cuerpo)).not.toContain('sensible');
    esperarCabecerasSeguridad(respuesta);

    expect(log).toHaveBeenCalledTimes(1);
    const linea = String(log.mock.calls[0]?.[0]);
    const entrada = JSON.parse(linea) as Record<string, unknown>;
    expect(entrada).toMatchObject({
      nivel: 'error',
      evento: 'error_no_controlado',
      metodo: 'GET',
      ruta: '/api/v1/error-inesperado',
      error: 'Error',
    });
    expect(typeof entrada.id_peticion).toBe('string');
    // La query string (que podría traer datos personales) no se registra.
    expect(linea).not.toContain('ana@catmetal.co');
  });

  it('usa cf-ray como id de petición en el log cuando existe', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await appDePrueba().request('/api/v1/error-inesperado', { headers: { 'cf-ray': 'ray-123' } });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ id_peticion: 'ray-123' });
  });

  it.each([
    [400, 400, 'VALIDACION'],
    [401, 401, 'NO_AUTENTICADO'],
    [403, 403, 'PERMISO_DENEGADO'],
    [404, 404, 'NO_ENCONTRADO'],
    [418, 500, 'ERROR_INTERNO'],
  ])('HTTPException %i de Hono → %i %s', async (lanzado, esperado, codigo) => {
    const respuesta = await appDePrueba().request(`/api/v1/http-exception/${lanzado}`);
    expect(respuesta.status).toBe(esperado);
    expect(await respuesta.json()).toMatchObject({ code: codigo });
  });

  it('notFound de la app responde 404 JSON', async () => {
    const respuesta = await appDePrueba().request('/api/v1/nada');
    expect(respuesta.status).toBe(404);
    expect(await respuesta.json()).toMatchObject({ code: 'NO_ENCONTRADO' });
  });
});

describe('validar()', () => {
  const consumo = () => ({
    id: uuidv7(),
    order_id: uuidv7(),
    material_id: uuidv7(),
    cantidad: 12.5,
    unidad: 'kg',
    lote: '  L-77 ',
    client_created_at: '2026-10-29T20:55:00.000Z',
  });

  it('deja pasar una entrada válida ya normalizada', async () => {
    const datos = consumo();
    const respuesta = await appDePrueba().request('/api/v1/consumos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos),
    });
    expect(respuesta.status).toBe(201);
    expect(await respuesta.json()).toEqual({ id: datos.id, lote: 'L-77' });
  });

  it('responde 400 VALIDACION con details por campo', async () => {
    const respuesta = await appDePrueba().request('/api/v1/consumos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...consumo(), cantidad: -1, unidad: 'lb' }),
    });
    expect(respuesta.status).toBe(400);
    const cuerpo = await respuesta.json<{ code: string; message: string; details: unknown }>();
    expect(cuerpo.code).toBe('VALIDACION');
    expect(cuerpo.message).toBe(MENSAJES_ERROR.VALIDACION);
    expect(cuerpo.details).toEqual([
      { campo: 'cantidad', mensaje: 'La cantidad debe ser mayor que cero.' },
      { campo: 'unidad', mensaje: 'La unidad no es válida.' },
    ]);
    esperarCabecerasSeguridad(respuesta);
  });

  it('JSON mal formado responde 400 VALIDACION', async () => {
    const respuesta = await appDePrueba().request('/api/v1/consumos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ no es json',
    });
    expect(respuesta.status).toBe(400);
    expect(await respuesta.json()).toMatchObject({ code: 'VALIDACION' });
  });
});

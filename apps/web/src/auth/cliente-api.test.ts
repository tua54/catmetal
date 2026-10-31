import { CABECERA_HORA_DISPOSITIVO } from '@catmetal/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearClienteApi, ErrorApi, ErrorRed, esErrorDeRed } from './cliente-api';
import { urlDe } from './pruebas/servidor-falso';

interface Llamada {
  url: string;
  init: RequestInit;
}

/** `fetch` simulado que registra cada llamada y responde con `responder`. */
function fetchFalso(
  responder: (llamada: Llamada, numero: number) => Promise<Response> | Response,
): {
  fetch: typeof fetch;
  llamadas: Llamada[];
} {
  const llamadas: Llamada[] = [];
  const fetch: typeof globalThis.fetch = (entrada, init = {}) => {
    const llamada = { url: urlDe(entrada), init };
    llamadas.push(llamada);
    return Promise.resolve(responder(llamada, llamadas.length));
  };
  return { fetch, llamadas };
}

function respuesta(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorApi(code: string, status: number): Response {
  return respuesta({ code, message: 'x' }, status);
}

function proveedor(token: string | null = 't1', nuevo: string | null = 't2') {
  const p = {
    refrescos: 0,
    revocadas: 0,
    obtenerAccessToken: () => Promise.resolve(token),
    refrescar: () => {
      p.refrescos += 1;
      return Promise.resolve(nuevo);
    },
    sesionRevocada: () => {
      p.revocadas += 1;
    },
  };
  return p;
}

function cabecera(llamada: Llamada | undefined, nombre: string): string | null {
  return new Headers(llamada?.init.headers).get(nombre);
}

/** Respuesta que nunca llega; se rechaza cuando se aborta la señal. */
function colgada(llamada: Llamada, motivo?: () => Error): Promise<Response> {
  return new Promise<Response>((_resolver, rechazar) => {
    llamada.init.signal?.addEventListener('abort', () => {
      const razon: unknown = llamada.init.signal?.reason;
      rechazar(motivo?.() ?? (razon instanceof Error ? razon : new Error('abortado')));
    });
  });
}

describe('crearClienteApi', () => {
  it('envía JSON al mismo origen con Bearer y credentials same-origin', async () => {
    const { fetch, llamadas } = fetchFalso(() => respuesta({ ok: 1 }));
    const api = crearClienteApi({ fetch, proveedor: proveedor() });
    expect(await api.peticion('/sync/push', { metodo: 'POST', cuerpo: { a: 1 } })).toEqual({
      ok: 1,
    });
    const [llamada] = llamadas;
    expect(llamada?.url).toBe('/api/v1/sync/push');
    expect(llamada?.init.method).toBe('POST');
    expect(llamada?.init.credentials).toBe('same-origin');
    expect(llamada?.init.body).toBe('{"a":1}');
    expect(cabecera(llamada, 'Authorization')).toBe('Bearer t1');
    expect(cabecera(llamada, 'Content-Type')).toBe('application/json');
  });

  it('cuerpo binario con su tipo, 204 sin cuerpo y peticiones sin autenticar', async () => {
    const { fetch, llamadas } = fetchFalso(() => new Response(null, { status: 204 }));
    const api = crearClienteApi({ fetch, base: '/x' });
    expect(
      await api.peticion('/evidences/1', {
        metodo: 'PUT',
        autenticar: false,
        binario: { datos: new Uint8Array([1, 2, 3]), tipo: 'image/jpeg' },
      }),
    ).toBeUndefined();
    expect(llamadas[0]?.url).toBe('/x/evidences/1');
    expect(cabecera(llamadas[0], 'Content-Type')).toBe('image/jpeg');
    expect(cabecera(llamadas[0], 'Authorization')).toBeNull();
  });

  it('usa el fetch global si no se inyecta', async () => {
    const { fetch, llamadas } = fetchFalso(() => respuesta({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    try {
      await crearClienteApi().peticion('/health', { autenticar: false });
      expect(llamadas).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('convierte el formato único de error en ErrorApi', async () => {
    const { fetch } = fetchFalso(() =>
      respuesta({ code: 'CONFLICTO', message: 'Cambió.', details: { version: 3 } }, 409),
    );
    const error = await crearClienteApi({ fetch, proveedor: proveedor() })
      .peticion('/x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorApi);
    expect(error).toMatchObject({
      code: 'CONFLICTO',
      status: 409,
      message: 'Cambió.',
      details: { version: 3 },
    });
  });

  it('errores sin el formato (proxy, HTML) se clasifican por estado', async () => {
    const casos: [number, string][] = [
      [502, 'ERROR_INTERNO'],
      [404, 'NO_ENCONTRADO'],
      [403, 'PERMISO_DENEGADO'],
      [401, 'NO_AUTENTICADO'],
    ];
    for (const [status, code] of casos) {
      const { fetch } = fetchFalso(() => new Response('<html>', { status }));
      await expect(
        crearClienteApi({ fetch }).peticion('/x', { autenticar: false }),
      ).rejects.toMatchObject({ code, status });
    }
    const raro = fetchFalso(() => respuesta({ code: 'INVENTADO', message: 1 }, 400));
    await expect(
      crearClienteApi({ fetch: raro.fetch }).peticion('/x', { autenticar: false }),
    ).rejects.toMatchObject({ code: 'ERROR_INTERNO', status: 400 });
    const sinMensaje = fetchFalso(() => respuesta({ code: 'VALIDACION' }, 400));
    await expect(
      crearClienteApi({ fetch: sinMensaje.fetch }).peticion('/x', { autenticar: false }),
    ).rejects.toMatchObject({
      message: 'Hay datos incompletos o no válidos. Revise los campos marcados.',
    });
  });

  it('un fallo de red es ErrorRed, distinto de un error HTTP', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await crearClienteApi({ fetch })
      .peticion('/x', { autenticar: false })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorRed);
    expect(esErrorDeRed(error)).toBe(true);
    expect(esErrorDeRed(new ErrorApi('ERROR_INTERNO', 500))).toBe(false);
    expect((error as ErrorRed).cause).toBeInstanceOf(TypeError);
  });

  it('el tiempo de espera agotado es ErrorRed', async () => {
    const { fetch } = fetchFalso((llamada) => colgada(llamada));
    const error = await crearClienteApi({ fetch })
      .peticion('/x', { autenticar: false, tiempoEsperaMs: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorRed);
    expect((error as ErrorRed).message).toMatch(/tardó/);
  });

  it('una cancelación del llamador se propaga tal cual', async () => {
    const { fetch } = fetchFalso((llamada) =>
      colgada(llamada, () => new DOMException('cancelada', 'AbortError')),
    );
    const control = new AbortController();
    const promesa = crearClienteApi({ fetch }).peticion('/x', {
      autenticar: false,
      signal: control.signal,
    });
    control.abort();
    await expect(promesa).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('401 NO_AUTENTICADO: un refresh y un solo reintento con el token nuevo', async () => {
    const una = fetchFalso((_llamada, n) =>
      n === 1 ? errorApi('NO_AUTENTICADO', 401) : respuesta({ ok: true }),
    );
    const p = proveedor();
    expect(await crearClienteApi({ fetch: una.fetch, proveedor: p }).peticion('/x')).toEqual({
      ok: true,
    });
    expect(p.refrescos).toBe(1);
    expect(cabecera(una.llamadas[1], 'Authorization')).toBe('Bearer t2');

    const siempre = fetchFalso(() => errorApi('NO_AUTENTICADO', 401));
    const p2 = proveedor();
    await expect(
      crearClienteApi({ fetch: siempre.fetch, proveedor: p2 }).peticion('/x'),
    ).rejects.toMatchObject({ code: 'NO_AUTENTICADO' });
    expect(p2.refrescos).toBe(1);
    expect(siempre.llamadas).toHaveLength(2);
  });

  it('si el refresh no da token, devuelve el 401 sin reintentar', async () => {
    const { fetch, llamadas } = fetchFalso(() => errorApi('NO_AUTENTICADO', 401));
    const p = proveedor('t1', null);
    await expect(crearClienteApi({ fetch, proveedor: p }).peticion('/x')).rejects.toMatchObject({
      code: 'NO_AUTENTICADO',
    });
    expect(llamadas).toHaveLength(1);
  });

  it('SESION_REVOCADA avisa al proveedor; un bearer explícito no refresca', async () => {
    const revocada = fetchFalso(() => errorApi('SESION_REVOCADA', 401));
    const p = proveedor();
    await expect(
      crearClienteApi({ fetch: revocada.fetch, proveedor: p }).peticion('/x'),
    ).rejects.toMatchObject({ code: 'SESION_REVOCADA' });
    expect(p.revocadas).toBe(1);

    const noAuth = fetchFalso(() => errorApi('NO_AUTENTICADO', 401));
    const p2 = proveedor();
    await expect(
      crearClienteApi({ fetch: noAuth.fetch, proveedor: p2 }).peticion('/auth/logout', {
        metodo: 'POST',
        bearer: 'tx',
        credenciales: 'omit',
      }),
    ).rejects.toBeInstanceOf(ErrorApi);
    expect(p2.refrescos).toBe(0);
    expect(p2.revocadas).toBe(0);
    expect(noAuth.llamadas[0]?.init.credentials).toBe('omit');
    expect(cabecera(noAuth.llamadas[0], 'Authorization')).toBe('Bearer tx');
  });

  it('sin token en la sesión no llama a la red', async () => {
    const { fetch, llamadas } = fetchFalso(() => respuesta({}));
    await expect(
      crearClienteApi({ fetch, proveedor: proveedor(null) }).peticion('/x'),
    ).rejects.toMatchObject({ code: 'NO_AUTENTICADO', status: 401 });
    await expect(crearClienteApi({ fetch }).peticion('/x')).rejects.toMatchObject({
      code: 'NO_AUTENTICADO',
    });
    expect(llamadas).toHaveLength(0);
  });
});

describe('hora del dispositivo al enviar (ADR 0019, M2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cada escritura lleva X-Hora-Dispositivo con la hora del momento del fetch; las lecturas no', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
    const { fetch, llamadas } = fetchFalso(() => respuesta({}));
    const api = crearClienteApi({ fetch, proveedor: proveedor() });
    for (const metodo of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await api.peticion('/x', { metodo, cuerpo: { a: 1 } });
      vi.setSystemTime(new Date(Date.now() + 60_000));
    }
    // Sin autenticar (login, refresh) y con bearer explícito (logout) también.
    await api.peticion('/auth/login', { metodo: 'POST', autenticar: false, cuerpo: {} });
    await api.peticion('/auth/logout', { metodo: 'POST', bearer: 'tx', credenciales: 'omit' });
    await api.peticion('/evidences/e1', {
      metodo: 'PUT',
      binario: { datos: 'x', tipo: 'image/jpeg' },
    });
    await api.peticion('/x');
    await api.peticion('/x', { metodo: 'GET' });
    expect(llamadas.map((l) => cabecera(l, CABECERA_HORA_DISPOSITIVO))).toEqual([
      '2026-10-30T12:00:00.000Z',
      '2026-10-30T12:01:00.000Z',
      '2026-10-30T12:02:00.000Z',
      '2026-10-30T12:03:00.000Z',
      '2026-10-30T12:04:00.000Z',
      '2026-10-30T12:04:00.000Z',
      '2026-10-30T12:04:00.000Z',
      null,
      null,
    ]);
  });

  it('el reintento tras un 401 lleva la hora de SU envío, no la del primero', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
    const { fetch, llamadas } = fetchFalso((_llamada, numero) => {
      if (numero === 1) {
        vi.setSystemTime(new Date('2026-10-30T12:00:05.000Z'));
        return errorApi('NO_AUTENTICADO', 401);
      }
      return respuesta({});
    });
    await crearClienteApi({ fetch, proveedor: proveedor() }).peticion('/x', { metodo: 'POST' });
    expect(llamadas.map((l) => cabecera(l, CABECERA_HORA_DISPOSITIVO))).toEqual([
      '2026-10-30T12:00:00.000Z',
      '2026-10-30T12:00:05.000Z',
    ]);
  });
});

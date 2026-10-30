// B5 (ADR 0026): versión mínima del cliente. El cliente manda `X-Version-Cliente: <entero>` en toda
// petición a `/api/v1`; ausente o inválida cuenta como 1. Si es menor que `VERSION_MINIMA_CLIENTE`
// (variable de wrangler.jsonc; vacía o inválida → 1), el Worker responde 426 `CLIENTE_DESACTUALIZADO`
// ANTES de procesar nada: no autentica, no lee el cuerpo, no escribe, no audita y no toca
// `sync_mutations`. `GET /api/v1/health` queda fuera. Worker real (la app de src/app.ts con el `env`
// real, solo con la variable cambiada), sesiones reales y D1 local real, sin mocks.
import {
  CABECERA_VERSION_CLIENTE,
  ESTADO_HTTP_POR_CODIGO,
  MENSAJES_ERROR,
  uuidv7,
  VERSION_CLIENTE,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { LIMITE_CUERPO_BYTES } from '../src/middleware/limite-cuerpo';
import { BASE, crearUsuarioConClave, ORIGEN } from './auth-helpers';
import { escenarioOrden } from './fase2-consumos-helpers';
import { api, sesion, type SesionDeRol, ultimoSeq } from './fase2-helpers';
import { contar, crearConsumo, filaSync, type MutacionPrueba } from './fase3-helpers';

// Logins reales: con la máquina cargada superan el límite por defecto de 5 s (mismo valor que las
// demás pruebas pesadas del worker; no cambia ninguna aserción).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let jefe: SesionDeRol;

beforeAll(async () => {
  [supervisor, jefe] = await Promise.all([sesion('supervisor'), sesion('jefe')]);
});

interface Llamada {
  /** Valor de `VERSION_MINIMA_CLIENTE` para esta petición (el resto del `env` es el real). */
  minima: string;
  /** Valor de `X-Version-Cliente`; `undefined` = sin cabecera (cliente v1.0). */
  version?: string;
  token?: string;
  method?: string;
  body?: unknown;
  /** `null` = sin cabecera Origin. Por defecto, el propio origen. */
  origen?: string | null;
  cuerpoCrudo?: string;
}

/** Llama a la app real con `VERSION_MINIMA_CLIENTE` cambiada. */
function llamar(ruta: string, opciones: Llamada): Promise<Response> {
  const headers = new Headers();
  const origen = opciones.origen === undefined ? ORIGEN : opciones.origen;
  if (origen !== null) {
    headers.set('Origin', origen);
  }
  if (opciones.version !== undefined) {
    headers.set(CABECERA_VERSION_CLIENTE, opciones.version);
  }
  if (opciones.token !== undefined) {
    headers.set('Authorization', `Bearer ${opciones.token}`);
  }
  let body: string | undefined;
  if (opciones.cuerpoCrudo !== undefined) {
    body = opciones.cuerpoCrudo;
  } else if (opciones.body !== undefined) {
    body = JSON.stringify(opciones.body);
  }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return Promise.resolve(
    app.request(
      `${BASE}/api/v1${ruta}`,
      { method: opciones.method ?? (body === undefined ? 'GET' : 'POST'), headers, body },
      { ...env, VERSION_MINIMA_CLIENTE: opciones.minima },
    ),
  );
}

/** Verifica el 426 con el formato único y `details.version_minima`. */
async function esperar426(respuesta: Response, versionMinima: number): Promise<void> {
  expect(respuesta.status).toBe(426);
  expect(await respuesta.json()).toEqual({
    code: 'CLIENTE_DESACTUALIZADO',
    message: MENSAJES_ERROR.CLIENTE_DESACTUALIZADO,
    details: { version_minima: versionMinima },
  });
}

interface Push {
  m: MutacionPrueba;
  cuerpo: { user_id: string; mutaciones: MutacionPrueba[] };
}

/** Un push de un consumo nuevo sobre una orden en proceso asignada al supervisor. */
async function pushNuevo(): Promise<Push> {
  const { orden, material } = await escenarioOrden(jefe, supervisor);
  const m = crearConsumo(orden, material);
  return { m, cuerpo: { user_id: supervisor.usuario.id, mutaciones: [m] } };
}

/** El push no se procesó: sin fila en `sync_mutations`, sin consumo y sin auditoría nueva. */
async function esperarSinEfecto(m: MutacionPrueba, seqAntes: number): Promise<void> {
  expect(await filaSync(m.mutation_id)).toBeNull();
  expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(0);
  expect(await ultimoSeq()).toBe(seqAntes);
}

/** El push se aplicó: 200 y el resultado `aplicada` registrado en `sync_mutations`. */
async function esperarAplicado(respuesta: Response, m: MutacionPrueba): Promise<void> {
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  const { resultados } = await respuesta.json<{ resultados: { resultado: string }[] }>();
  expect(resultados.map((r) => r.resultado)).toEqual(['aplicada']);
  expect((await filaSync(m.mutation_id))?.resultado).toBe('aplicada');
}

describe('B5: contrato de la versión del cliente', () => {
  it('CLIENTE_DESACTUALIZADO es un 426 y la v1.1 manda la versión 2', () => {
    expect(ESTADO_HTTP_POR_CODIGO.CLIENTE_DESACTUALIZADO).toBe(426);
    expect(VERSION_CLIENTE).toBe(2);
  });

  it('la configuración del despliegue de la v1.1 deja la mínima en "1"', () => {
    expect(env.VERSION_MINIMA_CLIENTE).toBe('1');
  });
});

describe('B5: versión menor que la mínima → 426 sin procesar nada', () => {
  it('/sync/push con X-Version-Cliente 2 y mínima 3 → 426; no toca sync_mutations ni audita', async () => {
    const { m, cuerpo } = await pushNuevo();
    const antes = await ultimoSeq();
    const respuesta = await llamar('/sync/push', {
      minima: '3',
      version: '2',
      token: supervisor.token,
      body: cuerpo,
    });
    await esperar426(respuesta, 3);
    await esperarSinEfecto(m, antes);
  });

  it('el mismo push, reenviado con una versión suficiente, se aplica (la mutación siguió pendiente)', async () => {
    const { m, cuerpo } = await pushNuevo();
    const antes = await ultimoSeq();
    await esperar426(
      await llamar('/sync/push', {
        minima: '3',
        version: '2',
        token: supervisor.token,
        body: cuerpo,
      }),
      3,
    );
    await esperarSinEfecto(m, antes);
    await esperarAplicado(
      await llamar('/sync/push', {
        minima: '3',
        version: '3',
        token: supervisor.token,
        body: cuerpo,
      }),
      m,
    );
  });

  it('sin cabecera (cliente v1.0) cuenta como versión 1: con mínima 2 → 426', async () => {
    const { m, cuerpo } = await pushNuevo();
    const antes = await ultimoSeq();
    const respuesta = await llamar('/sync/push', {
      minima: '2',
      token: supervisor.token,
      body: cuerpo,
    });
    await esperar426(respuesta, 2);
    await esperarSinEfecto(m, antes);
  });

  it.each(['', 'abc', '2.5', '-3', '0', '02', '1.1.0', '1e3', '99999999999999999999'])(
    'una cabecera inválida (%j) cuenta como versión 1: con mínima 2 → 426 (no 400)',
    async (version) => {
      const { m, cuerpo } = await pushNuevo();
      const antes = await ultimoSeq();
      const respuesta = await llamar('/sync/push', {
        minima: '2',
        version,
        token: supervisor.token,
        body: cuerpo,
      });
      await esperar426(respuesta, 2);
      await esperarSinEfecto(m, antes);
    },
  );

  it('una cabecera inválida con la mínima en 1 no rechaza la petición', async () => {
    const { m, cuerpo } = await pushNuevo();
    await esperarAplicado(
      await llamar('/sync/push', {
        minima: '1',
        version: 'no-es-un-numero',
        token: supervisor.token,
        body: cuerpo,
      }),
      m,
    );
  });

  it('el REST que escribe tampoco procesa nada (crear consumo → 426, sin consumo ni auditoría)', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const id = uuidv7();
    const antes = await ultimoSeq();
    const respuesta = await llamar(`/orders/${orden}/consumptions`, {
      minima: '3',
      version: '2',
      token: supervisor.token,
      body: {
        id,
        material_id: material,
        cantidad: 10,
        unidad: 'kg',
        lote: 'L-2026-001',
        client_created_at: new Date().toISOString(),
      },
    });
    await esperar426(respuesta, 3);
    expect(await contar('consumptions', 'id = ?', id)).toBe(0);
    expect(await ultimoSeq()).toBe(antes);
  });

  it('se verifica antes de autenticar: sin token → 426, no 401', async () => {
    await esperar426(await llamar('/auth/me', { minima: '3', version: '2' }), 3);
    await esperar426(await llamar('/sync/pull?cursor=0', { minima: '3' }), 3);
  });

  it('el login de un cliente desactualizado → 426, sin validar la clave, sin auditar ni contar el intento', async () => {
    const usuario = await crearUsuarioConClave('supervisor');
    const antes = await ultimoSeq();
    const respuesta = await llamar('/auth/login', {
      minima: '2',
      body: { email: usuario.email, password: 'clave-equivocada', device_id: uuidv7() },
    });
    await esperar426(respuesta, 2);
    expect(await ultimoSeq()).toBe(antes);
    const fila = await env.DB.prepare('SELECT intentos_fallidos FROM users WHERE id = ?')
      .bind(usuario.id)
      .first<{ intentos_fallidos: number }>();
    expect(fila?.intentos_fallidos).toBe(0);
    expect(await contar('login_cupos', 'user_id = ?', usuario.id)).toBe(0);
  });

  it('se verifica antes del límite de cuerpo: un cuerpo excesivo de un cliente viejo → 426', async () => {
    const respuesta = await llamar('/materials', {
      minima: '2',
      token: supervisor.token,
      cuerpoCrudo: JSON.stringify({ relleno: 'x'.repeat(LIMITE_CUERPO_BYTES + 1) }),
    });
    await esperar426(respuesta, 2);
  });

  it('la verificación de Origin (CSRF) sigue antes: un POST de un origen ajeno → 403 ORIGEN_INVALIDO', async () => {
    const { m, cuerpo } = await pushNuevo();
    const antes = await ultimoSeq();
    const respuesta = await llamar('/sync/push', {
      minima: '3',
      version: '2',
      token: supervisor.token,
      body: cuerpo,
      origen: 'https://atacante.example',
    });
    expect(respuesta.status).toBe(403);
    expect((await respuesta.json<{ code: string }>()).code).toBe('ORIGEN_INVALIDO');
    await esperarSinEfecto(m, antes);
  });

  it('GET /api/v1/health queda fuera: responde 200 aunque la versión sea menor', async () => {
    const respuesta = await llamar('/health', { minima: '99' });
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json<{ ok: boolean }>()).toMatchObject({ ok: true });
  });
});

describe('B5: versión igual o mayor que la mínima → se procesa', () => {
  it.each([
    ['igual', '3'],
    ['mayor', '7'],
  ])('versión %s a la mínima (3) → el push se aplica', async (_caso, version) => {
    const { m, cuerpo } = await pushNuevo();
    await esperarAplicado(
      await llamar('/sync/push', { minima: '3', version, token: supervisor.token, body: cuerpo }),
      m,
    );
  });

  it('el cliente v1.1 (VERSION_CLIENTE) pasa con la mínima en 2', async () => {
    const { m, cuerpo } = await pushNuevo();
    await esperarAplicado(
      await llamar('/sync/push', {
        minima: '2',
        version: String(VERSION_CLIENTE),
        token: supervisor.token,
        body: cuerpo,
      }),
      m,
    );
  });

  it.each(['', '  ', 'dos', '0', '-1', '2.5'])(
    'una mínima vacía o inválida (%j) vale 1: un cliente sin cabecera pasa',
    async (minima) => {
      const { m, cuerpo } = await pushNuevo();
      await esperarAplicado(
        await llamar('/sync/push', { minima, token: supervisor.token, body: cuerpo }),
        m,
      );
    },
  );
});

describe('B5: configuración por defecto (mínima "1")', () => {
  it('nunca bloquea a un cliente v1.0 sin cabecera: el Worker real aplica el push', async () => {
    const { m, cuerpo } = await pushNuevo();
    await esperarAplicado(await api('/sync/push', { token: supervisor.token, body: cuerpo }), m);
  });

  it('un cliente v1.0 sin cabecera lee su perfil con el Worker real', async () => {
    const respuesta = await api('/auth/me', { token: supervisor.token });
    expect(respuesta.status).toBe(200);
  });
});

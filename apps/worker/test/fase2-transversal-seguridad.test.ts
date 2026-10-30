// Tarea 2.5 — cabeceras de seguridad (docs/spec.md §9) y ausencia de secretos en las respuestas.
//
// Cabeceras: una muestra de respuestas de cada router (éxitos y errores) lleva CSP, nosniff,
// Referrer-Policy, Permissions-Policy, HSTS, X-Frame-Options y `Cache-Control: no-store`; solo
// `GET /evidences/:id` responde `private, no-store`. (La matriz y las demás pruebas transversales
// revisan además las cabeceras de CADA respuesta que reciben.)
//
// Secretos: ninguna respuesta contiene `password_hash`, `token_hash`, `storage_key`, el valor de
// los secretos del Worker, los hashes guardados ni las claves de R2; se revisan los textos y las
// claves de todo el JSON, recorriendo todas las páginas de los listados.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { peticion as peticionCruda } from './auth-helpers';
import { api } from './fase2-helpers';
import {
  buscarFila,
  comoRegistro,
  consumoConNovedad,
  consumoPendiente,
  crearMundo,
  enviar,
  escena,
  esperarCabecerasDeSeguridad,
  esperarSinSecretos,
  type Mundo,
  type Peticion,
  revisar,
  sesionDe,
  type ActorConSesion,
  usuarioConSesion,
  valoresProhibidos,
} from './fase2-transversal-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let mundo: Mundo;

beforeAll(async () => {
  mundo = await crearMundo();
});

describe('cabeceras de seguridad: una muestra de cada router', () => {
  // Una ruta representativa por router montado en app.ts, con un actor que obtiene un 2xx.
  const MUESTRA: readonly [string, string, string, ActorConSesion][] = [
    ['health', 'GET', '/health', 'supervisor'],
    ['auth', 'GET', '/auth/me', 'jefe'],
    ['usuarios', 'GET', '/users', 'admin'],
    ['materiales', 'GET', '/materials', 'supervisor'],
    ['settings', 'GET', '/settings', 'supervisor'],
    ['órdenes', 'GET', '/orders/:id', 'supervisor'],
    ['consumos', 'GET', '/orders/:id/consumptions', 'jefe'],
    ['validaciones', 'GET', '/validations/queue', 'jefe'],
    ['auditoría', 'GET', '/audit', 'admin'],
    ['reportes (resumen)', 'GET', '/reports/orders/:id/summary', 'admin'],
    ['reportes (CSV)', 'GET', '/reports/orders/:id/export.csv', 'jefe'],
    ['escritura de materiales', 'POST', '/materials', 'admin'],
    ['escritura de consumos', 'POST', '/consumptions', 'supervisor'],
    ['validación', 'POST', '/consumptions/:id/approve', 'jefe'],
  ];

  it.each(MUESTRA)(
    '%s: %s %s responde 2xx con todas las cabeceras',
    async (_router, metodo, ruta, actor) => {
      const fila = buscarFila(metodo, ruta);
      const peticion = await fila.preparar(mundo);
      const respuesta = await enviar(peticion, { token: sesionDe(mundo, actor).token });
      expect(respuesta.status).toBeLessThan(300);
      await respuesta.arrayBuffer();
      esperarCabecerasDeSeguridad(respuesta);
      expect(respuesta.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it('los 4xx de cada tipo de falla también llevan las cabeceras (401, 403, 404, 409)', async () => {
    const e = await escena(mundo);
    const consumo = await consumoPendiente(mundo, e);
    const casos: { peticion: Peticion; token?: string; estado: number; origen?: string | null }[] =
      [
        { peticion: { metodo: 'GET', ruta: '/orders' }, estado: 401 },
        { peticion: { metodo: 'GET', ruta: '/users' }, token: mundo.jefe.token, estado: 403 },
        { peticion: { metodo: 'GET', ruta: '/no-existe' }, token: mundo.jefe.token, estado: 404 },
        {
          peticion: { metodo: 'POST', ruta: '/materials', json: {} },
          token: mundo.admin.token,
          origen: 'https://evil.example',
          estado: 403,
        },
        {
          peticion: {
            metodo: 'PATCH',
            ruta: `/consumptions/${consumo}`,
            json: {
              id: consumo,
              version: 9,
              cantidad: 3,
              client_created_at: new Date().toISOString(),
            },
          },
          token: mundo.supervisor.token,
          estado: 409,
        },
      ];
    for (const caso of casos) {
      const respuesta = await enviar(caso.peticion, { token: caso.token, origen: caso.origen });
      expect(respuesta.status).toBe(caso.estado);
      await respuesta.arrayBuffer();
      esperarCabecerasDeSeguridad(respuesta);
    }
  });

  it('el login y el refresh (tokens y cookie) no se cachean', async () => {
    const { usuario } = await usuarioConSesion('supervisor');
    const login = await peticionCruda('/api/v1/auth/login', {
      body: {
        email: usuario.email,
        password: usuario.password,
        device_id: '018f0000-0000-7000-8000-0000000000aa',
      },
    });
    expect(login.status).toBe(200);
    esperarCabecerasDeSeguridad(login);
    const cookie = /mp_refresh=([^;]+)/.exec(login.headers.get('Set-Cookie') ?? '')?.[1] ?? '';
    expect(cookie.length).toBeGreaterThan(20);
    // El refresh token viaja solo en la cookie: nunca en el cuerpo.
    esperarSinSecretos(await login.text(), [cookie]);

    const refresh = await peticionCruda('/api/v1/auth/refresh', { method: 'POST', cookie });
    expect(refresh.status).toBe(200);
    esperarCabecerasDeSeguridad(refresh);
  });

  it('GET /evidences/:id: tipo fijo del servidor, nosniff, inline y private, no-store', async () => {
    const e = await escena(mundo);
    const datos = await consumoConNovedad(mundo, e, 'supervisor', true);
    for (const sesion of [mundo.supervisor, mundo.jefe, mundo.admin]) {
      const respuesta = await api(`/evidences/${datos.evidencia}`, { token: sesion.token });
      expect(respuesta.status).toBe(200);
      expect(new Uint8Array(await respuesta.arrayBuffer())).toEqual(datos.bytes);
      esperarCabecerasDeSeguridad(respuesta, { cacheControl: 'private, no-store' });
      expect(respuesta.headers.get('Content-Type')).toBe('image/jpeg');
      expect(respuesta.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(respuesta.headers.get('Content-Disposition')).toBe('inline');
    }
  });

  it('PUT /evidences/:id (subida) y el 404 de GET /evidences/:id llevan no-store', async () => {
    const peticion = await buscarFila('PUT', '/evidences/:id').preparar(mundo);
    const subida = await enviar(peticion, { token: mundo.supervisor.token });
    expect(subida.status).toBe(200);
    await subida.arrayBuffer();
    esperarCabecerasDeSeguridad(subida);

    const ajeno = await buscarFila('GET', '/evidences/:id').preparar(mundo);
    const oculta = await enviar(ajeno, { token: mundo.supervisorAjeno.token });
    expect(oculta.status).toBe(404);
    await oculta.arrayBuffer();
    esperarCabecerasDeSeguridad(oculta);
  });

  it('el CSV es un adjunto UTF-8 y no se puede interpretar como HTML', async () => {
    const peticion = await buscarFila('GET', '/reports/orders/:id/export.csv').preparar(mundo);
    const respuesta = await enviar(peticion, { token: mundo.jefe.token });
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(respuesta.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="[\w-]+\.csv"$/,
    );
    await respuesta.arrayBuffer();
    esperarCabecerasDeSeguridad(respuesta);
  });
});

// ---------------------------------------------------------------------------------------------
// Secretos
// ---------------------------------------------------------------------------------------------

const CLAVES_PROHIBIDAS = ['password_hash', 'token_hash', 'storage_key', 'password'];

/** Todas las claves de un valor JSON, a cualquier profundidad. */
function clavesDe(valor: unknown, acumulado = new Set<string>()): Set<string> {
  if (Array.isArray(valor)) {
    for (const elemento of valor) {
      clavesDe(elemento, acumulado);
    }
  } else if (typeof valor === 'object' && valor !== null) {
    for (const [clave, interior] of Object.entries(valor)) {
      acumulado.add(clave);
      clavesDe(interior, acumulado);
    }
  }
  return acumulado;
}

async function valoresSecretosGuardados(): Promise<string[]> {
  const [usuarios, tokens, claves] = await env.DB.batch([
    env.DB.prepare('SELECT password_hash AS valor FROM users'),
    env.DB.prepare('SELECT token_hash AS valor FROM refresh_tokens'),
    env.DB.prepare('SELECT storage_key AS valor FROM evidences'),
  ]);
  return [usuarios, tokens, claves].flatMap((r) =>
    (r?.results ?? []).map((fila) => (fila as { valor: string }).valor),
  );
}

describe('sin secretos en las respuestas', () => {
  const CONTRASENA_NUEVA = 'Clave-Segura-2026';
  let orden: string;
  let ids: { consumo: string; evidencia: string };

  beforeAll(async () => {
    // Estado rico: orden con consumos pendientes, aprobados y rechazados, novedad con foto subida y
    // usuarios con sesión activa (refresh tokens guardados).
    const e = await escena(mundo);
    orden = e.orden;
    const conFoto = await consumoConNovedad(mundo, e, 'supervisor', true);
    ids = { consumo: conFoto.consumo, evidencia: conFoto.evidencia };
    const aprobar = await consumoPendiente(mundo, e);
    const rechazar = await consumoPendiente(mundo, e);
    for (const [consumo, decision] of [
      [aprobar, 'approve'],
      [rechazar, 'reject'],
    ] as const) {
      const respuesta = await api(`/consumptions/${consumo}/${decision}`, {
        token: mundo.jefe.token,
        body: {
          id: uuidv7(),
          version: 1,
          client_created_at: new Date().toISOString(),
          ...(decision === 'reject' ? { motivo: 'Cantidad mal digitada' } : {}),
        },
      });
      expect(respuesta.status).toBe(201);
    }
    await usuarioConSesion('supervisor');
    await usuarioConSesion('jefe');
  });

  /** Sigue `siguiente_cursor` y devuelve el texto de todas las páginas. */
  async function paginas(ruta: string, token: string): Promise<string[]> {
    const textos: string[] = [];
    let cursor: string | number | null = null;
    for (let pagina = 0; pagina < 60; pagina += 1) {
      const separador = ruta.includes('?') ? '&' : '?';
      const url = cursor === null ? ruta : `${ruta}${separador}cursor=${cursor}`;
      const respuesta = await api(url, { token });
      expect(respuesta.status, url).toBe(200);
      const texto = await respuesta.text();
      textos.push(texto);
      const siguiente = comoRegistro(JSON.parse(texto)).siguiente_cursor;
      if (siguiente === null || siguiente === undefined) {
        return textos;
      }
      cursor = siguiente as string | number;
    }
    throw new Error(`Demasiadas páginas en ${ruta}`);
  }

  it('los listados (todas sus páginas) no contienen claves ni valores secretos', async () => {
    const secretos = await valoresSecretosGuardados();
    expect(secretos.length).toBeGreaterThan(5);
    const lecturas: [string, string][] = [
      ['/users?limite=5', mundo.admin.token],
      ['/materials?limite=5', mundo.supervisor.token],
      ['/orders?limite=5', mundo.jefe.token],
      [`/orders/${orden}/consumptions?limite=2`, mundo.jefe.token],
      ['/validations/queue?limite=2', mundo.jefe.token],
      ['/audit?limite=20', mundo.admin.token],
      ['/audit?limite=20', mundo.jefe.token],
      ['/audit?limite=20', mundo.supervisor.token],
      [`/orders/${orden}/audit?limite=5`, mundo.admin.token],
      [`/orders/${orden}/audit?limite=5`, mundo.supervisor.token],
    ];
    let revisadas = 0;
    for (const [ruta, token] of lecturas) {
      for (const texto of await paginas(ruta, token)) {
        esperarSinSecretos(texto, secretos);
        for (const clave of clavesDe(JSON.parse(texto))) {
          expect(CLAVES_PROHIBIDAS, `clave «${clave}» en ${ruta}`).not.toContain(clave);
        }
        revisadas += 1;
      }
    }
    expect(revisadas).toBeGreaterThan(lecturas.length);
  });

  it('los detalles, reportes y el perfil no contienen secretos', async () => {
    const secretos = await valoresSecretosGuardados();
    const lecturas: [string, string][] = [
      [`/orders/${orden}`, mundo.jefe.token],
      [`/orders/${orden}`, mundo.supervisor.token],
      [`/reports/orders/${orden}/summary`, mundo.admin.token],
      [`/reports/orders/${orden}/export.csv`, mundo.jefe.token],
      ['/auth/me', mundo.supervisor.token],
      ['/settings', mundo.supervisor.token],
    ];
    for (const [ruta, token] of lecturas) {
      const respuesta = await api(ruta, { token });
      expect(respuesta.status, ruta).toBe(200);
      const texto = await respuesta.text();
      esperarSinSecretos(texto, secretos);
      if (respuesta.headers.get('Content-Type')?.includes('json') === true) {
        for (const clave of clavesDe(JSON.parse(texto))) {
          expect(CLAVES_PROHIBIDAS, `clave «${clave}» en ${ruta}`).not.toContain(clave);
        }
      }
    }
  });

  it('las respuestas de las escrituras de usuarios y de novedades no devuelven secretos ni la clave de R2', async () => {
    const crear = await buscarFila('POST', '/users').preparar(mundo);
    const creado = await enviar(
      { ...crear, json: { ...(crear.json as object), password: CONTRASENA_NUEVA } },
      { token: mundo.admin.token },
    );
    expect(creado.status).toBe(201);
    const textoCreado = await creado.text();
    esperarSinSecretos(textoCreado, [CONTRASENA_NUEVA, ...(await valoresSecretosGuardados())]);
    expect([...clavesDe(JSON.parse(textoCreado))]).not.toEqual(
      expect.arrayContaining(['password']),
    );

    const editar = await buscarFila('PATCH', '/users/:id').preparar(mundo);
    const editado = await enviar(
      { ...editar, json: { password: CONTRASENA_NUEVA } },
      { token: mundo.admin.token },
    );
    expect(editado.status).toBe(200);
    esperarSinSecretos(await editado.text(), [CONTRASENA_NUEVA]);

    const novedad = await buscarFila('POST', '/consumptions/:id/incident').preparar(mundo);
    const registrada = await enviar(novedad, { token: mundo.supervisor.token });
    expect(registrada.status).toBe(201);
    esperarSinSecretos(await registrada.text(), await valoresSecretosGuardados());
  });

  it('la auditoría de usuarios guarda la contraseña restablecida solo como marca', async () => {
    const editar = await buscarFila('PATCH', '/users/:id').preparar(mundo);
    const respuesta = await enviar(
      { ...editar, json: { password: CONTRASENA_NUEVA } },
      { token: mundo.admin.token },
    );
    expect(respuesta.status).toBe(200);
    const id = editar.ruta.split('/').at(-1) ?? '';
    const lista = await api(`/audit?entidad=users&entidad_id=${id}`, { token: mundo.admin.token });
    expect(lista.status).toBe(200);
    const texto = await lista.text();
    expect(texto).toContain('usuario.editar');
    esperarSinSecretos(texto, [CONTRASENA_NUEVA, ...(await valoresSecretosGuardados())]);
  });

  it('los errores tampoco filtran secretos ni el valor de los secretos del Worker', async () => {
    const casos: [Peticion, string | undefined][] = [
      [{ metodo: 'GET', ruta: '/users' }, undefined],
      [{ metodo: 'GET', ruta: '/users' }, mundo.jefe.token],
      [{ metodo: 'GET', ruta: `/evidences/${ids.evidencia}` }, mundo.supervisorAjeno.token],
      [{ metodo: 'POST', ruta: '/materials', jsonCrudo: '{"password_hash":' }, mundo.admin.token],
      [{ metodo: 'GET', ruta: '/orders/no-es-uuid' }, 'token.invalido.firma'],
    ];
    for (const [peticion, token] of casos) {
      const respuesta = await enviar(peticion, { token });
      const revisada = await revisar(respuesta, peticion);
      expect(revisada.estado).toBeGreaterThanOrEqual(400);
      for (const valor of valoresProhibidos()) {
        expect(JSON.stringify(revisada.cuerpo)).not.toContain(valor);
      }
    }
  });

  it('los secretos del Worker que se buscan en las respuestas no están vacíos', () => {
    expect(env.JWT_SECRET.length).toBeGreaterThan(10);
    expect(env.REFRESH_SECRET.length).toBeGreaterThan(10);
    expect(valoresProhibidos().every((valor) => valor.length > 0)).toBe(true);
  });
});

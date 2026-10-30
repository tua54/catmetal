// M2 (ADR 0019, docs/spec.md §6 "Reloj"): `alerta_reloj` compara la hora del dispositivo AL ENVIAR
// (`enviado_at` en /sync/push, `X-Hora-Dispositivo` en el REST que escribe) con la hora del servidor
// al recibir. `client_created_at` solo se guarda en `client_at` para la trazabilidad. Sin hora de
// envío, o con un formato inválido, la alerta es 0. Worker real, sesiones reales y D1 local real.
import { type Consumo, MAX_MUTACIONES_POR_LOTE, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { crearUsuarioConClave, iniciarSesion, peticion } from './auth-helpers';
import { cuerpoConsumo, cuerpoNovedad, escenarioOrden } from './fase2-consumos-helpers';
import { api, sesion, type SesionDeRol, ultimoSeq } from './fase2-helpers';
import { crearConsumo, crearNovedadMut, decidirMut, pushOk } from './fase3-helpers';

// Muchas peticiones con login real: con la máquina cargada superan el límite por defecto de 5 s.
// Mismo valor que las demás pruebas pesadas del worker; no cambia ninguna aserción.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CABECERA = 'X-Hora-Dispositivo';
const MIN = 60_000;

let supervisor: SesionDeRol;
let jefe: SesionDeRol;
let admin: SesionDeRol;

beforeAll(async () => {
  [supervisor, jefe, admin] = await Promise.all([
    sesion('supervisor'),
    sesion('jefe'),
    sesion('admin'),
  ]);
});

/** Instante desplazado `ms` respecto de ahora, en el formato único. */
const desde = (ms: number): string => new Date(Date.now() + ms).toISOString();

interface FilaAlerta {
  entidad: string;
  accion: string;
  client_at: string | null;
  alerta_reloj: number;
}

/** Filas de auditoría escritas después de `seq` (las pruebas de un archivo corren en serie). */
async function auditoriaDesde(seq: number): Promise<FilaAlerta[]> {
  const { results } = await env.DB.prepare(
    'SELECT entidad, accion, client_at, alerta_reloj FROM audit_log WHERE seq > ? ORDER BY seq',
  )
    .bind(seq)
    .all<FilaAlerta>();
  return results;
}

/** Push con campos extra en el sobre (`enviado_at`). */
async function pushCon(
  s: SesionDeRol,
  mutaciones: unknown[],
  extra: Record<string, unknown>,
): Promise<{ resultado: string }[]> {
  const respuesta = await api('/sync/push', {
    token: s.token,
    body: { user_id: s.usuario.id, mutaciones, ...extra },
  });
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  return (await respuesta.json<{ resultados: { resultado: string }[] }>()).resultados;
}

/** Consumo de un registro offline de hace 3 h, en una mutación de push. */
function consumoOffline(orden: string, material: string, hace = 3 * 60 * MIN) {
  const registrado = desde(-hace);
  return crearConsumo(orden, material, { client_created_at: registrado });
}

describe('/sync/push: alerta_reloj con enviado_at', () => {
  it('registrado offline hace 3 h y enviado con el reloj correcto → 0 (client_at conserva la hora de registro)', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = consumoOffline(orden, material);
    const antes = await ultimoSeq();
    const resultados = await pushCon(supervisor, [m], { enviado_at: desde(0) });
    expect(resultados.map((r) => r.resultado)).toEqual(['aplicada']);
    const filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));
    expect(filas.find((f) => f.entidad === 'consumptions')?.client_at).toBe(
      m.payload.client_created_at,
    );
  });

  it.each([
    ['adelantado 15 min', 15 * MIN],
    ['atrasado 15 min', -15 * MIN],
  ])('reloj del dispositivo %s al enviar → 1', async (_nombre, desfase) => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    // Registrado "ahora" según el propio reloj desfasado del dispositivo.
    const m = crearConsumo(orden, material, { client_created_at: desde(desfase) });
    const antes = await ultimoSeq();
    await pushCon(supervisor, [m], { enviado_at: desde(desfase) });
    const filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));
  });

  it('sin enviado_at (cliente viejo) → 0 aunque client_created_at sea de hace 3 h', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = consumoOffline(orden, material);
    const antes = await ultimoSeq();
    const resultados = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    expect(resultados.map((r) => r.resultado)).toEqual(['aplicada']);
    const filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));
  });

  it.each([
    ['texto libre', 'ayer a las 3'],
    ['número', 1_761_771_300_000],
    ['fecha inexistente', '2026-02-30T10:00:00.000Z'],
    ['con desfase horario', '2026-10-29T15:00:00-05:00'],
    ['objeto', { hora: 'ahora' }],
    ['null', null],
  ])(
    'enviado_at inválido (%s) → la petición se procesa y la alerta es 0',
    async (_nombre, valor) => {
      const { orden, material } = await escenarioOrden(jefe, supervisor);
      const m = consumoOffline(orden, material);
      const antes = await ultimoSeq();
      const resultados = await pushCon(supervisor, [m], { enviado_at: valor });
      expect(resultados.map((r) => r.resultado)).toEqual(['aplicada']);
      const filas = await auditoriaDesde(antes);
      expect(filas.length).toBeGreaterThan(0);
      expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));
    },
  );

  it.each([
    ['desfasado', 15 * MIN, 1],
    ['correcto', 0, 0],
  ])(
    'lote de 25 mutaciones con el reloj %s: todas las filas de la petición llevan la misma alerta',
    async (_nombre, desfase, esperado) => {
      const { orden, material } = await escenarioOrden(jefe, supervisor);
      // Consumos registrados a lo largo de 3 h, y una novedad (consumo + novedad + evidencia).
      const consumos = Array.from({ length: MAX_MUTACIONES_POR_LOTE - 1 }, (_, i) =>
        consumoOffline(orden, material, (i + 1) * 7 * MIN),
      );
      const primero = consumos[0]?.payload.id as string;
      const mutaciones = [...consumos, crearNovedadMut(primero)];
      expect(mutaciones).toHaveLength(MAX_MUTACIONES_POR_LOTE);
      const antes = await ultimoSeq();
      const resultados = await pushCon(supervisor, mutaciones, { enviado_at: desde(desfase) });
      expect(resultados.map((r) => r.resultado)).toEqual(mutaciones.map(() => 'aplicada'));
      const filas = await auditoriaDesde(antes);
      // Una fila por consumo, más la novedad y su evidencia.
      expect(filas.filter((f) => f.entidad === 'consumptions')).toHaveLength(
        MAX_MUTACIONES_POR_LOTE - 1,
      );
      expect(filas.map((f) => f.entidad)).toEqual(
        expect.arrayContaining(['incidents', 'evidences']),
      );
      expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => esperado));
    },
  );

  it('una aprobación por push con el reloj desfasado marca la validación y el consumo', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const [creado] = await pushOk(supervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const consumo = creado?.servidor as unknown as Consumo;
    const antes = await ultimoSeq();
    await pushCon(jefe, [decidirMut('aprobar', consumo.id, consumo.version)], {
      enviado_at: desde(-20 * MIN),
    });
    const filas = await auditoriaDesde(antes);
    expect(filas.map((f) => f.entidad)).toContain('validations');
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));
  });
});

// ---------------------------------------------------------------------------------------------
// REST: cabecera X-Hora-Dispositivo en las peticiones que escriben
// ---------------------------------------------------------------------------------------------

/** Escritura REST con la cabecera opcional de la hora del dispositivo. */
function escribir(
  ruta: string,
  token: string,
  body: unknown,
  hora?: string,
  method = 'POST',
): Promise<Response> {
  return peticion(`/api/v1${ruta}`, {
    method,
    token,
    body,
    ...(hora === undefined ? {} : { headers: { [CABECERA]: hora } }),
  });
}

describe('REST: alerta_reloj con X-Hora-Dispositivo', () => {
  async function registrarConHora(hora: string | undefined): Promise<FilaAlerta[]> {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const antes = await ultimoSeq();
    const respuesta = await escribir(
      '/consumptions',
      supervisor.token,
      cuerpoConsumo(orden, material, { client_created_at: desde(-3 * 60 * MIN) }),
      hora,
    );
    expect(respuesta.status, await respuesta.clone().text()).toBe(201);
    const filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    return filas;
  }

  it('POST /consumptions registrado hace 3 h con la hora de envío correcta → 0', async () => {
    const filas = await registrarConHora(desde(0));
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));
  });

  it('POST /consumptions con el reloj desfasado 15 min → 1', async () => {
    const filas = await registrarConHora(desde(15 * MIN));
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));
  });

  it('POST /consumptions sin la cabecera (cliente viejo) → 0 aunque el registro sea de hace 3 h', async () => {
    const filas = await registrarConHora(undefined);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));
  });

  it.each(['no es una fecha', '2026-10-29 15:00:00', '1761771300000', ''])(
    'POST /consumptions con la cabecera inválida (%j) → se procesa y la alerta es 0',
    async (hora) => {
      const filas = await registrarConHora(hora);
      expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));
    },
  );

  it('aprobación y novedad por REST con el reloj desfasado → todas sus filas con 1', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const creado = await escribir(
      '/consumptions',
      supervisor.token,
      cuerpoConsumo(orden, material),
    );
    const consumo = await creado.json<Consumo>();
    let antes = await ultimoSeq();
    const novedad = await escribir(
      `/consumptions/${consumo.id}/incident`,
      supervisor.token,
      cuerpoNovedad(consumo.id),
      desde(-30 * MIN),
    );
    expect(novedad.status, await novedad.clone().text()).toBe(201);
    let filas = await auditoriaDesde(antes);
    expect(filas.map((f) => f.entidad)).toContain('incidents');
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));

    antes = await ultimoSeq();
    const aprobacion = await escribir(
      `/consumptions/${consumo.id}/approve`,
      jefe.token,
      { id: uuidv7(), version: 1, client_created_at: desde(0) },
      desde(11 * MIN),
    );
    expect(aprobacion.status, await aprobacion.clone().text()).toBe(201);
    filas = await auditoriaDesde(antes);
    expect(filas.map((f) => f.entidad)).toContain('validations');
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));
  });

  it('PATCH /users con el reloj desfasado → 1; sin cabecera → 0', async () => {
    const usuario = await crearUsuarioConClave('supervisor');
    let antes = await ultimoSeq();
    let respuesta = await escribir(
      `/users/${usuario.id}`,
      admin.token,
      { nombre: 'Nombre con reloj desfasado' },
      desde(-45 * MIN),
      'PATCH',
    );
    expect(respuesta.status, await respuesta.clone().text()).toBe(200);
    let filas = await auditoriaDesde(antes);
    expect(filas.map((f) => f.accion)).toContain('usuario.editar');
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));

    antes = await ultimoSeq();
    respuesta = await escribir(
      `/users/${usuario.id}`,
      admin.token,
      { nombre: 'Nombre sin cabecera' },
      undefined,
      'PATCH',
    );
    expect(respuesta.status, await respuesta.clone().text()).toBe(200);
    filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));
  });

  it('login, refresh y logout con el reloj desfasado → sus filas con 1; sin cabecera → 0', async () => {
    const usuario = await crearUsuarioConClave('supervisor');
    // Sin cabecera: login normal.
    let antes = await ultimoSeq();
    const sinHora = await iniciarSesion(usuario);
    let filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 0));

    // Login con el reloj desfasado.
    antes = await ultimoSeq();
    const login = await peticion('/api/v1/auth/login', {
      body: {
        email: usuario.email,
        password: usuario.password,
        device_id: sinHora.deviceId,
        device_nombre: 'Tablet de planta',
      },
      headers: { [CABECERA]: desde(20 * MIN) },
    });
    expect(login.status, await login.clone().text()).toBe(200);
    filas = await auditoriaDesde(antes);
    expect(filas.map((f) => f.accion)).toContain('sesion.inicio');
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));

    // Refresh con el reloj desfasado.
    const cookie = login.headers
      .getSetCookie()
      .find((l) => l.startsWith('mp_refresh='))
      ?.split(';')[0]
      ?.slice('mp_refresh='.length);
    expect(cookie).toBeDefined();
    antes = await ultimoSeq();
    const refresh = await peticion('/api/v1/auth/refresh', {
      method: 'POST',
      cookie: cookie ?? '',
      headers: { [CABECERA]: desde(-20 * MIN) },
    });
    expect(refresh.status, await refresh.clone().text()).toBe(200);
    filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));

    // Logout con el reloj desfasado.
    const { access_token: token } = await refresh.json<{ access_token: string }>();
    antes = await ultimoSeq();
    const logout = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      token,
      headers: { [CABECERA]: desde(20 * MIN) },
    });
    expect(logout.status, await logout.clone().text()).toBeLessThan(300);
    filas = await auditoriaDesde(antes);
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f.alerta_reloj)).toEqual(filas.map(() => 1));
  });
});

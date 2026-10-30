// Validación del jefe: POST /consumptions/:id/approve|reject y GET /validations/queue.
// El estado y la versión los aplica la base (trigger validations_aplica_decision, ADR 0010).
import {
  type ColaValidacion,
  type Consumo,
  type LineaTiempoOrden,
  type ListaConsumos,
  type ResultadoValidacion,
  uuidv7,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { aprobarConsumo, colaDeValidacion, rechazarConsumo } from '../src/dominio/validaciones';
import {
  cuerpoConsumo,
  cuerpoNovedad,
  editar,
  escenarioOrden,
  novedadOk,
  registrarOk,
} from './fase2-consumos-helpers';
import {
  api,
  auditoriaDesde,
  contextoDe,
  esperarError,
  json,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let jefe2: SesionDeRol;
let supervisor: SesionDeRol;

beforeAll(async () => {
  [admin, jefe, jefe2, supervisor] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('jefe'),
    sesion('supervisor'),
  ]);
});

const ahora = () => new Date().toISOString();

function aprobar(token: string | undefined, consumo: Pick<Consumo, 'id' | 'version'>, extra = {}) {
  return api(`/consumptions/${consumo.id}/approve`, {
    token,
    body: { id: uuidv7(), version: consumo.version, client_created_at: ahora(), ...extra },
  });
}

function rechazar(
  token: string | undefined,
  consumo: Pick<Consumo, 'id' | 'version'>,
  extra: Record<string, unknown> = { motivo: 'Cantidad mal digitada' },
) {
  return api(`/consumptions/${consumo.id}/reject`, {
    token,
    body: { id: uuidv7(), version: consumo.version, client_created_at: ahora(), ...extra },
  });
}

function cola(token: string | undefined, query = '') {
  return api(`/validations/queue${query}`, { token });
}

/** Consumo pendiente del supervisor (`cantidad` sobre un plan de 100 kg). */
async function pendiente(cantidad = 10) {
  const esc = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
  const consumo = await registrarOk(
    supervisor.token,
    cuerpoConsumo(esc.orden, esc.material, { cantidad }),
  );
  return { ...esc, consumo };
}

async function estadoDe(id: string) {
  return env.DB.prepare('SELECT estado, version FROM consumptions WHERE id = ?')
    .bind(id)
    .first<{ estado: string; version: number }>();
}

async function validacionesDe(id: string): Promise<number> {
  const fila = await env.DB.prepare(
    'SELECT count(*) AS n FROM validations WHERE consumption_id = ?',
  )
    .bind(id)
    .first<{ n: number }>();
  return fila?.n ?? -1;
}

describe('permisos', () => {
  it('supervisor y admin reciben 403 en aprobar, rechazar y la cola; sin sesión 401', async () => {
    const { consumo } = await pendiente();
    for (const token of [supervisor.token, admin.token]) {
      await esperarError(await aprobar(token, consumo), 403, 'PERMISO_DENEGADO');
      await esperarError(await rechazar(token, consumo), 403, 'PERMISO_DENEGADO');
      await esperarError(await cola(token), 403, 'PERMISO_DENEGADO');
    }
    await esperarError(await aprobar(undefined, consumo), 401, 'NO_AUTENTICADO');
    await esperarError(await rechazar(undefined, consumo), 401, 'NO_AUTENTICADO');
    await esperarError(await cola(undefined), 401, 'NO_AUTENTICADO');
    expect(await estadoDe(consumo.id)).toEqual({ estado: 'pendiente', version: 1 });
  });

  it('los comandos también exigen el permiso (los usará /sync/push)', async () => {
    const ctx = await contextoDe('admin');
    const entrada = {
      consumption_id: uuidv7(),
      id: uuidv7(),
      version: 1,
      client_created_at: ahora(),
    };
    await expect(aprobarConsumo(ctx, entrada)).rejects.toMatchObject({ code: 'PERMISO_DENEGADO' });
    await expect(rechazarConsumo(ctx, { ...entrada, motivo: 'abc' })).rejects.toMatchObject({
      code: 'PERMISO_DENEGADO',
    });
    await expect(colaDeValidacion(await contextoDe('supervisor'), {})).rejects.toMatchObject({
      code: 'PERMISO_DENEGADO',
    });
  });
});

describe('aprobar y rechazar', () => {
  it('aprueba: la base aplica estado y version + 1; auditoría exacta con order_id', async () => {
    const { orden, consumo } = await pendiente();
    const antes = await ultimoSeq();
    const clientAt = '2026-10-29T17:00:00.000Z';
    const respuesta = await aprobar(jefe.token, consumo, { client_created_at: clientAt });
    expect(respuesta.status).toBe(201);
    const { consumo: decidido, validacion } = await respuesta.json<ResultadoValidacion>();
    expect(decidido).toMatchObject({ id: consumo.id, estado: 'aprobado', version: 2 });
    expect(validacion).toMatchObject({
      consumption_id: consumo.id,
      decision: 'aprobado',
      motivo: null,
      validado_por: jefe.usuario.id,
      client_created_at: clientAt,
    });
    expect(await estadoDe(consumo.id)).toEqual({ estado: 'aprobado', version: 2 });

    const filas = await auditoriaDesde(antes);
    expect(filas.map((f) => [f.entidad, f.entidad_id, f.accion, f.order_id])).toEqual([
      ['validations', validacion.id, 'validacion.crear', orden],
      ['consumptions', consumo.id, 'consumo.aprobar', orden],
    ]);
    expect(
      filas.every((f) => f.actor_id === jefe.usuario.id && f.device_id === jefe.deviceId),
    ).toBe(true);
    expect(json(filas[1]?.datos_antes ?? null)).toMatchObject({ estado: 'pendiente', version: 1 });
    expect(json(filas[1]?.datos_despues ?? null)).toMatchObject({ estado: 'aprobado', version: 2 });
    const clientes = await env.DB.prepare('SELECT DISTINCT client_at FROM audit_log WHERE seq > ?')
      .bind(antes)
      .all<{ client_at: string }>();
    expect(clientes.results).toEqual([{ client_at: clientAt }]);
  });

  it('rechaza con motivo', async () => {
    const { consumo } = await pendiente();
    const antes = await ultimoSeq();
    const respuesta = await rechazar(jefe.token, consumo, { motivo: '  Lote no corresponde  ' });
    expect(respuesta.status).toBe(201);
    const { consumo: decidido, validacion } = await respuesta.json<ResultadoValidacion>();
    expect(decidido).toMatchObject({ estado: 'rechazado', version: 2 });
    expect(validacion).toMatchObject({ decision: 'rechazado', motivo: 'Lote no corresponde' });
    expect((await auditoriaDesde(antes)).map((f) => f.accion)).toEqual([
      'validacion.crear',
      'consumo.rechazar',
    ]);
  });

  it('el motivo es obligatorio (3 a 500 caracteres)', async () => {
    const { consumo } = await pendiente();
    for (const extra of [{}, { motivo: '' }, { motivo: '  ab ' }, { motivo: 'x'.repeat(501) }]) {
      await esperarError(await rechazar(jefe.token, consumo, extra), 400, 'VALIDACION');
    }
    await esperarError(await aprobar(jefe.token, { ...consumo, version: 0 }), 400, 'VALIDACION');
    expect(await validacionesDe(consumo.id)).toBe(0);
  });

  it('nadie aprueba ni rechaza un consumo propio: 403 AUTOAPROBACION', async () => {
    const esc = await escenarioOrden(jefe, supervisor);
    const propio = await registrarOk(jefe.token, cuerpoConsumo(esc.orden, esc.material));
    await esperarError(await aprobar(jefe.token, propio), 403, 'AUTOAPROBACION');
    await esperarError(await rechazar(jefe.token, propio), 403, 'AUTOAPROBACION');
    // Otro jefe sí puede.
    expect((await aprobar(jefe2.token, propio)).status).toBe(201);
  });

  it('con requiere_novedad y sin novedad: aprobar 422; rechazar sí; con novedad aprueba', async () => {
    const { consumo } = await pendiente(150);
    expect(consumo.requiere_novedad).toBe(true);
    await esperarError(await aprobar(jefe.token, consumo), 422, 'REQUIERE_NOVEDAD');
    await novedadOk(supervisor.token, consumo.id, cuerpoNovedad(consumo.id));
    expect((await aprobar(jefe.token, consumo)).status).toBe(201);

    const otro = await pendiente(150);
    expect((await rechazar(jefe.token, otro.consumo)).status).toBe(201);
  });

  it('si el supervisor editó entre medias: 409 CONFLICTO con la versión del servidor', async () => {
    const { consumo } = await pendiente();
    const edicion = await editar(supervisor.token, consumo.id, {
      id: consumo.id,
      version: 1,
      client_created_at: ahora(),
      cantidad: 11,
    });
    expect(edicion.status).toBe(200);
    const antes = await ultimoSeq();
    const cuerpo = await esperarError(await aprobar(jefe.token, consumo), 409, 'CONFLICTO');
    expect(cuerpo.details).toMatchObject({
      version_servidor: 2,
      consumo: { id: consumo.id, cantidad: 11, version: 2 },
    });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    expect((await aprobar(jefe.token, { ...consumo, version: 2 })).status).toBe(201);
  });

  it('un consumo ya decidido no se vuelve a validar; un id de validación repetido es 409', async () => {
    const { consumo } = await pendiente();
    const idValidacion = uuidv7();
    expect((await aprobar(jefe.token, consumo, { id: idValidacion })).status).toBe(201);
    const actual = { id: consumo.id, version: 2 };
    let cuerpo = await esperarError(
      await rechazar(jefe2.token, actual),
      409,
      'CONSUMO_NO_PENDIENTE',
    );
    expect(cuerpo.details).toEqual({ estado: 'aprobado' });
    await esperarError(await aprobar(jefe2.token, actual), 409, 'CONSUMO_NO_PENDIENTE');
    cuerpo = await esperarError(
      await aprobar(jefe2.token, actual, { id: idValidacion }),
      409,
      'ID_DUPLICADO',
    );
    expect(cuerpo.details).toEqual({ entidad: 'validations', campos: ['id'] });
    expect(await validacionesDe(consumo.id)).toBe(1);
  });

  it('consumo inexistente 404; id inválido 400', async () => {
    await esperarError(
      await aprobar(jefe.token, { id: uuidv7(), version: 1 }),
      404,
      'NO_ENCONTRADO',
    );
    await esperarError(await rechazar(jefe.token, { id: 'x', version: 1 }), 400, 'VALIDACION');
  });

  it('dos jefes deciden a la vez: uno 201 y el otro 409, sin datos parciales', async () => {
    const { consumo } = await pendiente();
    const antes = await ultimoSeq();
    const respuestas = await Promise.all([
      aprobar(jefe.token, consumo),
      rechazar(jefe2.token, consumo),
    ]);
    const estados = respuestas.map((r) => r.status).sort();
    expect(estados).toEqual([201, 409]);
    const perdedora = respuestas.find((r) => r.status === 409);
    const cuerpo = await perdedora?.json<{ code: string }>();
    expect(['CONSUMO_NO_PENDIENTE', 'CONFLICTO']).toContain(cuerpo?.code);
    expect(await validacionesDe(consumo.id)).toBe(1);
    expect((await auditoriaDesde(antes)).map((f) => f.entidad)).toEqual([
      'validations',
      'consumptions',
    ]);
    expect((await estadoDe(consumo.id))?.version).toBe(2);
  });

  it('si el consumo cambia entre la lectura y el INSERT, la principal no aplica y nada se escribe', async () => {
    const { consumo } = await pendiente();
    const ctx = await contextoDe('jefe');
    const plan = await aprobarConsumo(ctx, {
      consumption_id: consumo.id,
      id: uuidv7(),
      version: 1,
      client_created_at: ahora(),
    });
    expect(
      (
        await editar(supervisor.token, consumo.id, {
          id: consumo.id,
          version: 1,
          client_created_at: ahora(),
          lote: 'L-X',
        })
      ).status,
    ).toBe(200);
    const antes = await ultimoSeq();
    const { ejecutarPlan } = await import('../src/dominio/plan');
    await expect(ejecutarPlan(env.DB, plan)).rejects.toBe(plan.siNoAplica);
    expect(await validacionesDe(consumo.id)).toBe(0);
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });
});

describe('flujo: rechazo → corrección → aprobación', () => {
  it('el supervisor ve el motivo, corrige y el jefe aprueba la corrección', async () => {
    const { orden, material, consumo } = await pendiente(30);
    expect((await rechazar(jefe.token, consumo, { motivo: 'Eran 25 kg' })).status).toBe(201);

    const lista = await (
      await api(`/orders/${orden}/consumptions`, { token: supervisor.token })
    ).json<ListaConsumos>();
    const rechazado = lista.consumos.find((c) => c.id === consumo.id);
    expect(rechazado).toMatchObject({ estado: 'rechazado', validacion: { motivo: 'Eran 25 kg' } });

    const correccion = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 25, corrige_a: consumo.id }),
    );
    // El rechazado no cuenta en el acumulado: 25 kg no exceden.
    expect(correccion).toMatchObject({ corrige_a: consumo.id, requiere_novedad: false });
    const respuesta = await aprobar(jefe.token, correccion);
    expect(respuesta.status).toBe(201);

    const { results } = await env.DB.prepare(
      `SELECT entidad, accion FROM audit_log WHERE order_id = ? AND entidad IN ('consumptions', 'validations') ORDER BY seq`,
    )
      .bind(orden)
      .all<{ entidad: string; accion: string }>();
    expect(results.map((r) => r.accion)).toEqual([
      'consumo.crear',
      'validacion.crear',
      'consumo.rechazar',
      'consumo.crear',
      'validacion.crear',
      'consumo.aprobar',
    ]);
  });
});

describe('GET /validations/queue', () => {
  it('lista pendientes con filtros, propio, falta_novedad, novedades y el contador', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    const normal = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 10 }),
    );
    const excede = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 200 }),
    );
    const justificado = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 1 }),
    );
    await novedadOk(supervisor.token, justificado.id, cuerpoNovedad(justificado.id));
    const delJefe = await registrarOk(jefe.token, cuerpoConsumo(orden, material, { cantidad: 1 }));
    const decidido = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 1 }),
    );
    expect((await rechazar(jefe2.token, decidido)).status).toBe(201);

    const respuesta = await cola(jefe.token, `?orden=${orden}`);
    expect(respuesta.status).toBe(200);
    const todo = await respuesta.json<ColaValidacion>();
    expect(todo.pendientes).toBe(4);
    expect(todo.siguiente_cursor).toBeNull();
    expect(todo.elementos.map((e) => e.id)).toEqual([
      normal.id,
      excede.id,
      justificado.id,
      delJefe.id,
    ]);
    const [a, b, c, d] = todo.elementos;
    expect(a).toMatchObject({
      estado: 'pendiente',
      cantidad: 10,
      unidad: 'kg',
      cantidad_en_unidad_plan: 10,
      lote: 'L-2026-001',
      registro_tardio: false,
      requiere_novedad: false,
      falta_novedad: false,
      propio: false,
      material: { id: material },
      supervisor: { id: supervisor.usuario.id, nombre: 'Persona supervisor' },
      orden: { id: orden },
      novedades: [],
    });
    expect(typeof a?.material.codigo).toBe('string');
    expect(typeof a?.orden.codigo).toBe('string');
    expect(b).toMatchObject({ requiere_novedad: true, falta_novedad: true });
    expect(c).toMatchObject({ requiere_novedad: true, falta_novedad: false });
    expect(c?.novedades[0]).toMatchObject({ tipo: 'merma', evidencias: [] });
    expect(d).toMatchObject({
      propio: true,
      supervisor: { id: jefe.usuario.id },
      falta_novedad: true,
    });
    // Para el otro jefe, el consumo del primero no es propio.
    const desdeJefe2 = await (await cola(jefe2.token, `?orden=${orden}`)).json<ColaValidacion>();
    expect(desdeJefe2.elementos.find((e) => e.id === delJefe.id)?.propio).toBe(false);

    const conNovedad = await (
      await cola(jefe.token, `?orden=${orden}&con_novedad=true`)
    ).json<ColaValidacion>();
    // Tras los 200 kg el acumulado supera el plan: el consumo del jefe también requiere novedad.
    expect(conNovedad.elementos.map((e) => e.id)).toEqual([excede.id, justificado.id, delJefe.id]);
    expect(conNovedad.pendientes).toBe(3);
    const sinNovedad = await (
      await cola(jefe.token, `?orden=${orden}&con_novedad=false`)
    ).json<ColaValidacion>();
    expect(sinNovedad.elementos.map((e) => e.id)).toEqual([normal.id]);
    expect(sinNovedad.pendientes).toBe(1);

    const deUnSupervisor = await (
      await cola(jefe.token, `?orden=${orden}&supervisor=${jefe.usuario.id}`)
    ).json<ColaValidacion>();
    expect(deUnSupervisor.elementos.map((e) => e.id)).toEqual([delJefe.id]);
    expect(deUnSupervisor.pendientes).toBe(1);

    // Cursor: el contador es del filtro completo, no de la página.
    const p1 = await (await cola(jefe.token, `?orden=${orden}&limite=3`)).json<ColaValidacion>();
    expect(p1.elementos.map((e) => e.id)).toEqual([normal.id, excede.id, justificado.id]);
    expect(p1.pendientes).toBe(4);
    const p2 = await (
      await cola(jefe.token, `?orden=${orden}&limite=3&cursor=${p1.siguiente_cursor ?? ''}`)
    ).json<ColaValidacion>();
    expect(p2.elementos.map((e) => e.id)).toEqual([delJefe.id]);
    expect(p2.siguiente_cursor).toBeNull();
  });

  it('sin filtros incluye los pendientes de todas las órdenes; una orden sin pendientes da 0', async () => {
    const { consumo } = await pendiente();
    const todo = await (await cola(jefe.token, '?limite=100')).json<ColaValidacion>();
    expect(todo.pendientes).toBeGreaterThanOrEqual(1);
    const vacia = await (await cola(jefe.token, `?orden=${uuidv7()}`)).json<ColaValidacion>();
    expect(vacia).toEqual({ elementos: [], pendientes: 0, siguiente_cursor: null });
    expect(consumo.estado).toBe('pendiente');
  });

  it.each(['orden=x', 'supervisor=1', 'con_novedad=si', 'limite=0', 'cursor=abc'])(
    'rechaza la query %s con 400',
    async (query) => {
      await esperarError(await cola(jefe.token, `?${query}`), 400, 'VALIDACION');
    },
  );
});

describe('integración con la línea de tiempo (GET /orders/:id/audit)', () => {
  it('cada decisión aparece una sola vez, como validacion o rechazo con el motivo', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    const aprobado = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
    const rechazado = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
    expect((await aprobar(jefe.token, aprobado)).status).toBe(201);
    expect(
      (await rechazar(jefe.token, rechazado, { motivo: 'Lote equivocado en planta' })).status,
    ).toBe(201);

    const respuesta = await api(`/orders/${orden}/audit`, { token: jefe.token });
    expect(respuesta.status).toBe(200);
    const { eventos } = await respuesta.json<LineaTiempoOrden>();
    const decisiones = eventos.filter((e) => e.tipo === 'validacion' || e.tipo === 'rechazo');
    expect(decisiones.map((e) => [e.tipo, e.consumption_id])).toEqual([
      ['validacion', aprobado.id],
      ['rechazo', rechazado.id],
    ]);
    expect(decisiones[1]?.descripcion).toContain('Lote equivocado en planta');
    // La fila de auditoría del consumo escrita por la validación no se repite como evento.
    expect(
      eventos.filter((e) => e.accion === 'consumo.aprobar' || e.accion === 'consumo.rechazar'),
    ).toEqual([]);
  });
});

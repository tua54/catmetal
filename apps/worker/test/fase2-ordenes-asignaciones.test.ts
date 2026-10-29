// Asignación de supervisores: PUT /orders/:id/supervisors (solo admin.gestionar).
import { type SupervisoresDeOrden, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { reemplazarSupervisores } from '../src/dominio/asignaciones';
import { ejecutarPlan } from '../src/dominio/plan';
import {
  api,
  auditoriaDesde,
  contextoDe,
  esperarError,
  json,
  nuevaOrden,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';
import { crearUsuario } from './fixtures-db';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let supervisor: SesionDeRol;

beforeAll(async () => {
  [admin, jefe, supervisor] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('supervisor'),
  ]);
});

function asignarPorApi(token: string | undefined, orderId: string, supervisores: string[]) {
  return api(`/orders/${orderId}/supervisors`, { method: 'PUT', token, body: { supervisores } });
}

async function asignacionesDe(orderId: string) {
  const { results } = await env.DB.prepare(
    'SELECT user_id, activo, asignado_por FROM order_supervisors WHERE order_id = ? ORDER BY user_id',
  )
    .bind(orderId)
    .all<{ user_id: string; activo: number; asignado_por: string }>();
  return results;
}

describe('permisos', () => {
  it.each(['supervisor', 'jefe'] as const)('un %s recibe 403', async (rol) => {
    const token = { supervisor, jefe }[rol].token;
    const orden = await nuevaOrden(jefe.usuario.id);
    await esperarError(
      await asignarPorApi(token, orden, [supervisor.usuario.id]),
      403,
      'PERMISO_DENEGADO',
    );
    expect(await asignacionesDe(orden)).toEqual([]);
  });

  it('sin sesión responde 401', async () => {
    await esperarError(await asignarPorApi(undefined, uuidv7(), []), 401, 'NO_AUTENTICADO');
  });
});

describe('reemplazar la lista', () => {
  it('crea, desactiva, reactiva y audita una fila por asignación cambiada (con order_id)', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const a = await crearUsuario('supervisor');
    const b = await crearUsuario('supervisor');
    const c = await crearUsuario('supervisor');

    // 1. Asigna A y B.
    let antes = await ultimoSeq();
    let respuesta = await asignarPorApi(admin.token, orden, [a, b]);
    expect(respuesta.status).toBe(200);
    let cuerpo = await respuesta.json<SupervisoresDeOrden>();
    expect(cuerpo.order_id).toBe(orden);
    expect(cuerpo.supervisores.map((s) => s.user_id).sort()).toEqual([a, b].sort());
    expect(cuerpo.supervisores.every((s) => s.asignado_por === admin.usuario.id)).toBe(true);
    let filas = await auditoriaDesde(antes);
    expect(filas.map((f) => [f.entidad, f.entidad_id, f.accion, f.order_id])).toEqual(
      [a, b].sort().map((u) => ['order_supervisors', `${orden}:${u}`, 'asignacion.crear', orden]),
    );
    expect(
      filas.every((f) => f.actor_id === admin.usuario.id && f.device_id === admin.deviceId),
    ).toBe(true);
    expect(json(filas[0]?.datos_antes ?? null)).toBeNull();
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({ activo: true, order_id: orden });

    // 2. Reemplaza por B y C: A queda inactiva (no se borra), C se crea, B no cambia.
    antes = await ultimoSeq();
    respuesta = await asignarPorApi(admin.token, orden, [b, c]);
    cuerpo = await respuesta.json<SupervisoresDeOrden>();
    expect(cuerpo.supervisores.map((s) => s.user_id).sort()).toEqual([b, c].sort());
    filas = await auditoriaDesde(antes);
    expect(filas.map((f) => [f.entidad_id, f.accion])).toEqual([
      [`${orden}:${a}`, 'asignacion.desactivar'],
      [`${orden}:${c}`, 'asignacion.crear'],
    ]);
    expect(json(filas[0]?.datos_antes ?? null)).toMatchObject({ activo: true });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({ activo: false });
    expect(await asignacionesDe(orden)).toEqual(
      [
        { user_id: a, activo: 0, asignado_por: admin.usuario.id },
        { user_id: b, activo: 1, asignado_por: admin.usuario.id },
        { user_id: c, activo: 1, asignado_por: admin.usuario.id },
      ].sort((x, y) => (x.user_id < y.user_id ? -1 : 1)),
    );

    // 3. Vuelve a poner A: se reactiva la misma fila.
    antes = await ultimoSeq();
    expect((await asignarPorApi(admin.token, orden, [a, b, c])).status).toBe(200);
    filas = await auditoriaDesde(antes);
    expect(filas.map((f) => [f.entidad_id, f.accion])).toEqual([
      [`${orden}:${a}`, 'asignacion.reactivar'],
    ]);

    // 4. La misma lista no cambia nada ni audita.
    antes = await ultimoSeq();
    respuesta = await asignarPorApi(admin.token, orden, [c, b, a]);
    expect(respuesta.status).toBe(200);
    expect((await respuesta.json<SupervisoresDeOrden>()).supervisores).toHaveLength(3);
    expect(await auditoriaDesde(antes)).toHaveLength(0);

    // 5. Lista vacía: todas inactivas.
    antes = await ultimoSeq();
    respuesta = await asignarPorApi(admin.token, orden, []);
    expect((await respuesta.json<SupervisoresDeOrden>()).supervisores).toEqual([]);
    expect((await auditoriaDesde(antes)).map((f) => f.accion)).toEqual([
      'asignacion.desactivar',
      'asignacion.desactivar',
      'asignacion.desactivar',
    ]);
    expect((await asignacionesDe(orden)).every((x) => x.activo === 0)).toBe(true);
  });

  it('la asignación da y quita la visibilidad de la orden al supervisor', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    await esperarError(
      await api(`/orders/${orden}`, { token: supervisor.token }),
      404,
      'NO_ENCONTRADO',
    );
    expect((await asignarPorApi(admin.token, orden, [supervisor.usuario.id])).status).toBe(200);
    expect((await api(`/orders/${orden}`, { token: supervisor.token })).status).toBe(200);
    expect((await asignarPorApi(admin.token, orden, [])).status).toBe(200);
    await esperarError(
      await api(`/orders/${orden}`, { token: supervisor.token }),
      404,
      'NO_ENCONTRADO',
    );
  });

  it('solo acepta supervisores activos existentes (400 VALIDACION con detalles)', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const valido = await crearUsuario('supervisor');
    const unJefe = await crearUsuario('jefe');
    const inactivo = await crearUsuario('supervisor');
    await env.DB.prepare('UPDATE users SET activo = 0 WHERE id = ?').bind(inactivo).run();
    const antes = await ultimoSeq();
    const cuerpo = await esperarError(
      await asignarPorApi(admin.token, orden, [valido, unJefe, inactivo, uuidv7()]),
      400,
      'VALIDACION',
    );
    expect(cuerpo.details).toEqual([
      { campo: 'supervisores.1', mensaje: 'El usuario no tiene el rol supervisor.' },
      { campo: 'supervisores.2', mensaje: 'El usuario está inactivo.' },
      { campo: 'supervisores.3', mensaje: 'El usuario no existe.' },
    ]);
    expect(await asignacionesDe(orden)).toEqual([]);
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('valida el cuerpo y responde 404 si la orden no existe', async () => {
    const s = await crearUsuario('supervisor');
    await esperarError(await asignarPorApi(admin.token, uuidv7(), [s]), 404, 'NO_ENCONTRADO');
    const orden = await nuevaOrden(jefe.usuario.id);
    await esperarError(await asignarPorApi(admin.token, orden, [s, s]), 400, 'VALIDACION');
    await esperarError(await asignarPorApi(admin.token, orden, ['x']), 400, 'VALIDACION');
    await esperarError(
      await api(`/orders/${orden}/supervisors`, { method: 'PUT', token: admin.token, body: {} }),
      400,
      'VALIDACION',
    );
  });

  it('si otro admin cambió las asignaciones entretanto: 409 y nada escrito a medias', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const a = await crearUsuario('supervisor');
    const b = await crearUsuario('supervisor');
    const c = await crearUsuario('supervisor');
    expect((await asignarPorApi(admin.token, orden, [a])).status).toBe(200);
    // Plan leído con [a] activo: quitar a, agregar b y c.
    const plan = await reemplazarSupervisores(await contextoDe('admin'), orden, {
      supervisores: [b, c],
    });
    expect(plan.sentencias.length).toBe(6);
    // Otro admin agrega c antes de que se ejecute el plan.
    expect((await asignarPorApi(admin.token, orden, [a, c])).status).toBe(200);
    const estadoPrevio = await asignacionesDe(orden);
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, plan)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await asignacionesDe(orden)).toEqual(estadoPrevio);
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('si un supervisor pedido se desactiva entretanto: 409 y nada escrito', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const a = await crearUsuario('supervisor');
    const plan = await reemplazarSupervisores(await contextoDe('admin'), orden, {
      supervisores: [a],
    });
    await env.DB.prepare('UPDATE users SET activo = 0 WHERE id = ?').bind(a).run();
    await expect(ejecutarPlan(env.DB, plan)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await asignacionesDe(orden)).toEqual([]);
  });
});

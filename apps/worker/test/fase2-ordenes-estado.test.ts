// Transiciones de orden: POST /orders/:id/start y /finish (jefe y admin, `ordenes.gestionar`).
import { type Orden, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { finalizarOrden, iniciarOrden } from '../src/dominio/ordenes';
import { ejecutarPlan } from '../src/dominio/plan';
import {
  api,
  asignar,
  auditoriaDesde,
  contextoDe,
  esperarError,
  json,
  nuevaOrden,
  nuevoConsumo,
  nuevoMaterial,
  sesion,
  type SesionDeRol,
  supervisorConDispositivo,
  ultimoSeq,
} from './fase2-helpers';

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

function iniciar(token: string | undefined, id: string) {
  return api(`/orders/${id}/start`, { method: 'POST', token });
}

function finalizar(token: string | undefined, id: string, body?: unknown) {
  return api(`/orders/${id}/finish`, { method: 'POST', token, body });
}

async function estadoDe(id: string) {
  return env.DB.prepare(
    'SELECT estado, fecha_inicio, fecha_fin FROM production_orders WHERE id = ?',
  )
    .bind(id)
    .first<{ estado: string; fecha_inicio: string | null; fecha_fin: string | null }>();
}

async function conPendientes(orderId: string, cuantos: number) {
  const material = await nuevoMaterial();
  const s = await supervisorConDispositivo();
  for (let i = 0; i < cuantos; i += 1) {
    await nuevoConsumo({
      orderId,
      materialId: material,
      registradoPor: s.id,
      deviceId: s.deviceId,
      cantidad: 1,
    });
  }
}

describe('permisos', () => {
  it('el supervisor recibe 403 aunque tenga la orden asignada; sin sesión 401', async () => {
    const id = await nuevaOrden(jefe.usuario.id, 'planeada');
    await asignar(id, supervisor.usuario.id, admin.usuario.id);
    await esperarError(await iniciar(supervisor.token, id), 403, 'PERMISO_DENEGADO');
    await esperarError(await finalizar(supervisor.token, id), 403, 'PERMISO_DENEGADO');
    await esperarError(await iniciar(undefined, id), 401, 'NO_AUTENTICADO');
    await esperarError(await finalizar(undefined, id), 401, 'NO_AUTENTICADO');
    expect((await estadoDe(id))?.estado).toBe('planeada');
  });
});

describe('start', () => {
  it.each(['jefe', 'admin'] as const)(
    'un %s inicia una orden planeada y queda auditado',
    async (rol) => {
      const actor = { jefe, admin }[rol];
      const id = await nuevaOrden(jefe.usuario.id, 'planeada');
      const antes = await ultimoSeq();
      const respuesta = await iniciar(actor.token, id);
      expect(respuesta.status).toBe(200);
      const orden = await respuesta.json<Orden>();
      expect(orden).toMatchObject({ id, estado: 'en_proceso', fecha_fin: null });
      expect(orden.fecha_inicio).toEqual(orden.updated_at);
      expect(await estadoDe(id)).toEqual({
        estado: 'en_proceso',
        fecha_inicio: orden.fecha_inicio,
        fecha_fin: null,
      });
      const filas = await auditoriaDesde(antes);
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({
        entidad: 'production_orders',
        entidad_id: id,
        accion: 'orden.iniciar',
        order_id: id,
        actor_id: actor.usuario.id,
      });
      expect(json(filas[0]?.datos_antes ?? null)).toMatchObject({ estado: 'planeada' });
      expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({ estado: 'en_proceso' });
    },
  );

  it.each(['en_proceso', 'finalizada', 'cancelada'] as const)(
    'una orden %s no se inicia: 422 ESTADO_ORDEN_INVALIDO',
    async (estado) => {
      const id = await nuevaOrden(jefe.usuario.id, estado);
      const antes = await ultimoSeq();
      const cuerpo = await esperarError(
        await iniciar(jefe.token, id),
        422,
        'ESTADO_ORDEN_INVALIDO',
      );
      expect(cuerpo.details).toEqual({ estado, requerido: 'planeada' });
      expect(await auditoriaDesde(antes)).toHaveLength(0);
    },
  );

  it('404 si no existe y 400 si el id no es válido', async () => {
    await esperarError(await iniciar(jefe.token, uuidv7()), 404, 'NO_ENCONTRADO');
    await esperarError(await iniciar(jefe.token, 'x'), 400, 'VALIDACION');
  });

  it('si otra petición la inició entretanto: 409 CONFLICTO y una sola auditoría', async () => {
    const id = await nuevaOrden(jefe.usuario.id, 'planeada');
    const plan = await iniciarOrden(await contextoDe('jefe'), id);
    expect((await iniciar(admin.token, id)).status).toBe(200);
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, plan)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });
});

describe('finish', () => {
  it('sin pendientes y sin cuerpo: finaliza y audita force=false con 0 pendientes', async () => {
    const id = await nuevaOrden(jefe.usuario.id, 'en_proceso');
    const antes = await ultimoSeq();
    const respuesta = await finalizar(jefe.token, id);
    expect(respuesta.status).toBe(200);
    const orden = await respuesta.json<Orden>();
    expect(orden).toMatchObject({ id, estado: 'finalizada' });
    expect(orden.fecha_fin).toEqual(orden.updated_at);
    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ accion: 'orden.finalizar', order_id: id });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({
      estado: 'finalizada',
      force: false,
      pendientes: 0,
    });
  });

  it('con consumos pendientes: 409 ORDEN_CON_PENDIENTES con el número, sin cambios', async () => {
    const id = await nuevaOrden(jefe.usuario.id, 'en_proceso');
    await conPendientes(id, 2);
    const antes = await ultimoSeq();
    for (const body of [undefined, {}, { force: false }]) {
      const cuerpo = await esperarError(
        await finalizar(admin.token, id, body),
        409,
        'ORDEN_CON_PENDIENTES',
      );
      expect(cuerpo.details).toEqual({ pendientes: 2 });
    }
    expect((await estadoDe(id))?.estado).toBe('en_proceso');
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('con force: true finaliza y audita force y el número de pendientes', async () => {
    const id = await nuevaOrden(jefe.usuario.id, 'en_proceso');
    await conPendientes(id, 3);
    const antes = await ultimoSeq();
    const respuesta = await finalizar(admin.token, id, { force: true });
    expect(respuesta.status).toBe(200);
    expect((await estadoDe(id))?.estado).toBe('finalizada');
    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({
      estado: 'finalizada',
      force: true,
      pendientes: 3,
    });
    expect(filas[0]?.actor_id).toBe(admin.usuario.id);
  });

  it.each(['planeada', 'finalizada', 'cancelada'] as const)(
    'una orden %s no se finaliza: 422 ESTADO_ORDEN_INVALIDO',
    async (estado) => {
      const id = await nuevaOrden(jefe.usuario.id, estado);
      const cuerpo = await esperarError(
        await finalizar(jefe.token, id, { force: true }),
        422,
        'ESTADO_ORDEN_INVALIDO',
      );
      expect(cuerpo.details).toEqual({ estado, requerido: 'en_proceso' });
    },
  );

  it('valida el cuerpo y el id; 404 si no existe', async () => {
    const id = await nuevaOrden(jefe.usuario.id, 'en_proceso');
    await esperarError(await finalizar(jefe.token, id, { force: 'si' }), 400, 'VALIDACION');
    await esperarError(await finalizar(jefe.token, uuidv7()), 404, 'NO_ENCONTRADO');
    await esperarError(await finalizar(jefe.token, '123'), 400, 'VALIDACION');
  });

  it('si llega un consumo pendiente entre la lectura y la escritura: 409 y nada escrito', async () => {
    const id = await nuevaOrden(jefe.usuario.id, 'en_proceso');
    const plan = await finalizarOrden(await contextoDe('jefe'), id, {});
    await conPendientes(id, 1);
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, plan)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect((await estadoDe(id))?.estado).toBe('en_proceso');
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });
});

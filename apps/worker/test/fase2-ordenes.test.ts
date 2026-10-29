// Órdenes: listar, detalle con consumo vs plan, crear (/api/v1/orders), con permisos y visibilidad.
import { type DetalleOrden, type ListaOrdenes, type OrdenCreada, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { crearOrden } from '../src/dominio/ordenes';
import { ejecutarPlan } from '../src/dominio/plan';
import {
  api,
  asignar,
  auditoriaDesde,
  codigoOrden,
  contextoDe,
  esperarError,
  json,
  nuevaOrden,
  nuevoConsumo,
  nuevoMaterial,
  planear,
  sesion,
  type SesionDeRol,
  supervisorConDispositivo,
  ultimoSeq,
} from './fase2-helpers';
import { decidir } from './fixtures-db';

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

async function listarTodas(token: string, filtro = ''): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `?limite=3${filtro}${cursor === null ? '' : `&cursor=${cursor}`}`;
    const respuesta = await api(`/orders${query}`, { token });
    expect(respuesta.status).toBe(200);
    const pagina = await respuesta.json<ListaOrdenes>();
    ids.push(...pagina.ordenes.map((o) => o.id));
    cursor = pagina.siguiente_cursor;
  } while (cursor !== null);
  return ids;
}

function cuerpoOrden(
  materiales: { material_id: string; cantidad_planeada: number; unidad: string }[],
) {
  return { codigo: codigoOrden(), linea: 'Fundición gris', materiales };
}

describe('listar y ver: visibilidad por rol', () => {
  it('el supervisor solo ve las órdenes con asignación activa; jefe y admin ven todas', async () => {
    const asignada = await nuevaOrden(jefe.usuario.id);
    const desasignada = await nuevaOrden(jefe.usuario.id);
    const ajena = await nuevaOrden(jefe.usuario.id);
    await asignar(asignada, supervisor.usuario.id, admin.usuario.id);
    await asignar(desasignada, supervisor.usuario.id, admin.usuario.id, 0);

    const delSupervisor = await listarTodas(supervisor.token);
    expect(delSupervisor).toContain(asignada);
    expect(delSupervisor).not.toContain(desasignada);
    expect(delSupervisor).not.toContain(ajena);
    expect(delSupervisor).toEqual([...delSupervisor].sort());

    for (const token of [jefe.token, admin.token]) {
      const todas = await listarTodas(token);
      expect(todas).toEqual(expect.arrayContaining([asignada, desasignada, ajena]));
    }

    expect((await api(`/orders/${asignada}`, { token: supervisor.token })).status).toBe(200);
    for (const id of [desasignada, ajena, uuidv7()]) {
      // No revela si existe: lo mismo que una orden inexistente.
      await esperarError(
        await api(`/orders/${id}`, { token: supervisor.token }),
        404,
        'NO_ENCONTRADO',
      );
    }
    for (const token of [jefe.token, admin.token]) {
      expect((await api(`/orders/${ajena}`, { token })).status).toBe(200);
    }
  });

  it('filtra por estado', async () => {
    const planeada = await nuevaOrden(jefe.usuario.id, 'planeada');
    const enProceso = await nuevaOrden(jefe.usuario.id, 'en_proceso');
    const planeadas = await listarTodas(jefe.token, '&estado=planeada');
    expect(planeadas).toContain(planeada);
    expect(planeadas).not.toContain(enProceso);
  });

  it.each(['estado=abierta', 'limite=0', 'limite=101', 'cursor=1'])(
    'rechaza la query %s con 400',
    async (query) => {
      await esperarError(await api(`/orders?${query}`, { token: jefe.token }), 400, 'VALIDACION');
    },
  );

  it('sin sesión responde 401 en la lista y en el detalle', async () => {
    await esperarError(await api('/orders'), 401, 'NO_AUTENTICADO');
    await esperarError(await api(`/orders/${uuidv7()}`), 401, 'NO_AUTENTICADO');
  });

  it('el id del detalle debe ser un UUID v7', async () => {
    await esperarError(await api('/orders/abc', { token: jefe.token }), 400, 'VALIDACION');
  });
});

describe('detalle: consumo vs plan', () => {
  it('suma los consumos no rechazados en la unidad del plan y marca la tolerancia', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const arena = await nuevoMaterial({ nombre: 'A arena sílice' });
    const ferro = await nuevoMaterial({ nombre: 'B ferrosilicio' });
    const fuera = await nuevoMaterial({ nombre: 'C carbón coque', unidad: 'kg' });
    await planear(orden, arena, 100, 'kg');
    await planear(orden, ferro, 1000, 'g');
    const s = await supervisorConDispositivo();
    await asignar(orden, s.id, admin.usuario.id);
    await asignar(orden, supervisor.usuario.id, admin.usuario.id);
    const base = { orderId: orden, registradoPor: s.id, deviceId: s.deviceId };

    await nuevoConsumo({ ...base, materialId: arena, cantidad: 50 }); // pendiente
    const aprobado = await nuevoConsumo({ ...base, materialId: arena, cantidad: 40.25 });
    const rechazado = await nuevoConsumo({ ...base, materialId: arena, cantidad: 30 });
    await decidir(aprobado, jefe.usuario.id, 'aprobado');
    await decidir(rechazado, jefe.usuario.id, 'rechazado');
    // 1,2 kg registrados contra un plan en gramos: 1200 g > 1000 g + 5 %.
    await nuevoConsumo({ ...base, materialId: ferro, cantidad: 1.2, cantidadPlan: 1200 });
    await nuevoConsumo({ ...base, materialId: fuera, cantidad: 3 });

    const respuesta = await api(`/orders/${orden}`, { token: supervisor.token });
    expect(respuesta.status).toBe(200);
    const detalle = await respuesta.json<DetalleOrden>();
    expect(detalle).toMatchObject({ id: orden, estado: 'en_proceso', tolerancia_pct: 5 });
    expect(detalle.materiales).toEqual([
      expect.objectContaining({
        material_id: arena,
        unidad: 'kg',
        cantidad_planeada: 100,
        consumido: 90.25,
        porcentaje: 90.25,
        excede_tolerancia: false,
      }),
      expect.objectContaining({
        material_id: ferro,
        unidad: 'g',
        cantidad_planeada: 1000,
        consumido: 1200,
        porcentaje: 120,
        excede_tolerancia: true,
      }),
    ]);
    expect(detalle.materiales_fuera_de_plan).toEqual([
      expect.objectContaining({ material_id: fuera, unidad: 'kg', consumido: 3 }),
    ]);
    expect(detalle.supervisores.map((x) => x.user_id).sort()).toEqual(
      [s.id, supervisor.usuario.id].sort(),
    );
    expect(detalle.supervisores[0]).toEqual({
      user_id: expect.any(String) as string,
      nombre: expect.any(String) as string,
      asignado_por: admin.usuario.id,
      created_at: expect.any(String) as string,
      updated_at: expect.any(String) as string,
    });
  });

  it('justo en el límite de la tolerancia no excede; un material sin consumos da 0', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const arena = await nuevoMaterial({ nombre: 'A arena' });
    const resina = await nuevoMaterial({ nombre: 'B resina', unidad: 'l' });
    await planear(orden, arena, 100, 'kg');
    await planear(orden, resina, 20, 'l');
    const s = await supervisorConDispositivo();
    await nuevoConsumo({
      orderId: orden,
      materialId: arena,
      registradoPor: s.id,
      deviceId: s.deviceId,
      cantidad: 105,
    });
    const detalle = await (
      await api(`/orders/${orden}`, { token: jefe.token })
    ).json<DetalleOrden>();
    expect(detalle.materiales.map((m) => [m.consumido, m.excede_tolerancia])).toEqual([
      [105, false],
      [0, false],
    ]);
    expect(detalle.materiales_fuera_de_plan).toEqual([]);
    expect(detalle.supervisores).toEqual([]);
  });
});

describe('crear', () => {
  it.each(['jefe', 'admin'] as const)(
    'un %s crea una orden planeada con su plan y su auditoría (con order_id)',
    async (rol) => {
      const actor = { jefe, admin }[rol];
      const arena = await nuevoMaterial({ unidad: 'kg' });
      const resina = await nuevoMaterial({ unidad: 'l' });
      const antes = await ultimoSeq();
      const body = cuerpoOrden([
        { material_id: arena, cantidad_planeada: 1500, unidad: 'g' },
        { material_id: resina, cantidad_planeada: 25.5, unidad: 'l' },
      ]);
      const respuesta = await api('/orders', { token: actor.token, body });
      expect(respuesta.status).toBe(201);
      const orden = await respuesta.json<OrdenCreada>();
      expect(orden).toMatchObject({
        codigo: body.codigo,
        linea: 'Fundición gris',
        estado: 'planeada',
        fecha_inicio: null,
        fecha_fin: null,
        creada_por: actor.usuario.id,
      });
      expect(orden.materiales).toEqual([
        { order_id: orden.id, material_id: arena, cantidad_planeada: 1500, unidad: 'g' },
        { order_id: orden.id, material_id: resina, cantidad_planeada: 25.5, unidad: 'l' },
      ]);

      const filas = await auditoriaDesde(antes);
      expect(filas.map((f) => [f.entidad, f.entidad_id, f.accion, f.order_id])).toEqual([
        ['production_orders', orden.id, 'orden.crear', orden.id],
        ['order_planned_materials', `${orden.id}:${arena}`, 'orden.planear_material', orden.id],
        ['order_planned_materials', `${orden.id}:${resina}`, 'orden.planear_material', orden.id],
      ]);
      expect(
        filas.every((f) => f.actor_id === actor.usuario.id && f.device_id === actor.deviceId),
      ).toBe(true);
      expect(json(filas[1]?.datos_despues ?? null)).toMatchObject({
        cantidad_planeada: 1500,
        unidad: 'g',
      });

      const detalle = await (
        await api(`/orders/${orden.id}`, { token: jefe.token })
      ).json<DetalleOrden>();
      expect(detalle.materiales.map((m) => m.material_id).sort()).toEqual([arena, resina].sort());
    },
  );

  it('acepta un id propuesto por el cliente y rechaza uno repetido con 409 ID_DUPLICADO', async () => {
    const arena = await nuevoMaterial();
    const id = uuidv7();
    const body = {
      ...cuerpoOrden([{ material_id: arena, cantidad_planeada: 1, unidad: 'kg' }]),
      id,
    };
    expect((await api('/orders', { token: jefe.token, body })).status).toBe(201);
    const antes = await ultimoSeq();
    const cuerpo = await esperarError(
      await api('/orders', { token: jefe.token, body: { ...body, codigo: codigoOrden() } }),
      409,
      'ID_DUPLICADO',
    );
    expect(cuerpo.details).toEqual({ entidad: 'production_orders', campos: ['id'] });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('un código repetido responde 409 CONFLICTO sin dejar la orden ni su plan a medias', async () => {
    const arena = await nuevoMaterial();
    const body = cuerpoOrden([{ material_id: arena, cantidad_planeada: 10, unidad: 'kg' }]);
    expect((await api('/orders', { token: jefe.token, body })).status).toBe(201);
    const id = uuidv7();
    const antes = await ultimoSeq();
    const cuerpo = await esperarError(
      await api('/orders', { token: jefe2.token, body: { ...body, id } }),
      409,
      'CONFLICTO',
    );
    expect(cuerpo.details).toEqual({ entidad: 'production_orders', campos: ['codigo'] });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    const { n } = (await env.DB.prepare(
      'SELECT count(*) AS n FROM order_planned_materials WHERE order_id = ?',
    )
      .bind(id)
      .first<{ n: number }>()) ?? { n: -1 };
    expect(n).toBe(0);
  });

  it('material inexistente → 400, inactivo → 422 MATERIAL_INACTIVO, unidad no convertible → 422', async () => {
    const activo = await nuevoMaterial({ unidad: 'kg' });
    const inactivo = await nuevoMaterial({ activo: 0 });
    const antes = await ultimoSeq();

    const noExiste = uuidv7();
    const cuerpo400 = await esperarError(
      await api('/orders', {
        token: jefe.token,
        body: cuerpoOrden([
          { material_id: activo, cantidad_planeada: 1, unidad: 'kg' },
          { material_id: noExiste, cantidad_planeada: 1, unidad: 'kg' },
        ]),
      }),
      400,
      'VALIDACION',
    );
    expect(cuerpo400.details).toEqual([
      { campo: 'materiales.1.material_id', mensaje: 'El material no existe.' },
    ]);

    const cuerpoInactivo = await esperarError(
      await api('/orders', {
        token: jefe.token,
        body: cuerpoOrden([{ material_id: inactivo, cantidad_planeada: 1, unidad: 'kg' }]),
      }),
      422,
      'MATERIAL_INACTIVO',
    );
    expect(cuerpoInactivo.details).toMatchObject({ material_id: inactivo });

    for (const unidad of ['l', 'ml', 'und', 'm']) {
      const cuerpo = await esperarError(
        await api('/orders', {
          token: jefe.token,
          body: cuerpoOrden([{ material_id: activo, cantidad_planeada: 1, unidad }]),
        }),
        422,
        'UNIDAD_INCOMPATIBLE',
      );
      expect(cuerpo.details).toMatchObject({ unidad, unidad_material: 'kg' });
    }
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('valida el cuerpo (código OP-AAAA-NNNN, al menos un material, sin repetidos)', async () => {
    const arena = await nuevoMaterial();
    const plan = { material_id: arena, cantidad_planeada: 1, unidad: 'kg' };
    for (const body of [
      { ...cuerpoOrden([plan]), codigo: 'OP-1' },
      cuerpoOrden([]),
      cuerpoOrden([plan, plan]),
    ]) {
      await esperarError(await api('/orders', { token: jefe.token, body }), 400, 'VALIDACION');
    }
  });

  it('si un material se desactiva entre la lectura y la escritura: 409 y nada escrito', async () => {
    const arena = await nuevoMaterial();
    const ctx = await contextoDe('jefe');
    const entrada = {
      codigo: codigoOrden(),
      linea: 'Moldeo',
      materiales: [{ material_id: arena, cantidad_planeada: 5, unidad: 'kg' as const }],
    };
    const plan = await crearOrden(ctx, entrada);
    await env.DB.prepare('UPDATE materials SET activo = 0 WHERE id = ?').bind(arena).run();
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, plan)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    const fila = await env.DB.prepare('SELECT id FROM production_orders WHERE codigo = ?')
      .bind(entrada.codigo)
      .first();
    expect(fila).toBeNull();
  });

  it('permisos: el supervisor recibe 403; sin sesión 401', async () => {
    const arena = await nuevoMaterial();
    const body = cuerpoOrden([{ material_id: arena, cantidad_planeada: 1, unidad: 'kg' }]);
    await esperarError(
      await api('/orders', { token: supervisor.token, body }),
      403,
      'PERMISO_DENEGADO',
    );
    await esperarError(await api('/orders', { body }), 401, 'NO_AUTENTICADO');
  });
});

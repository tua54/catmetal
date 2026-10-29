// Infraestructura de comandos de dominio: traducción de errores de D1, ejecutor de planes (batch
// atómico, sentencia principal, cadena condicional) y reglas de visibilidad. D1 local real.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { contextoDesdeHono, type Contexto } from '../src/dominio/contexto';
import { esErrorDeRestriccion, traducirErrorD1 } from '../src/dominio/errores-d1';
import { crearOrden } from '../src/dominio/ordenes';
import { ejecutarPlan, type PlanDeEscritura, planSinCambios } from '../src/dominio/plan';
import {
  filtroOrdenVisible,
  ordenesVisibles,
  puedeVerConsumo,
  puedeVerOrden,
  veTodasLasOrdenes,
} from '../src/dominio/visibilidad';
import { ErrorApi } from '../src/errores';
import {
  asignar,
  auditoriaDesde,
  codigoOrden,
  contextoDe,
  nuevaOrden,
  nuevoConsumo,
  nuevoMaterial,
  supervisorConDispositivo,
  ultimoSeq,
} from './fase2-helpers';
import {
  ahora,
  crearAuditoria,
  crearDispositivo,
  crearUsuario,
  decidir,
  insertar,
} from './fixtures-db';

/** Ejecuta una operación que debe fallar en D1 y devuelve el error real. */
async function errorDe(operacion: () => Promise<unknown>): Promise<unknown> {
  try {
    await operacion();
  } catch (error) {
    return error;
  }
  throw new Error('la operación no falló');
}

function marcas() {
  const t = ahora();
  return { created_at: t, updated_at: t };
}

describe('traducirErrorD1 con errores reales de D1', () => {
  it('PK propia repetida → ID_DUPLICADO con entidad y campo', async () => {
    const jefe = await crearUsuario('jefe');
    const id = await nuevaOrden(jefe);
    const error = await errorDe(() =>
      insertar('production_orders', {
        id,
        codigo: `OP-X-${uuidv7()}`,
        linea: 'Moldeo',
        estado: 'planeada',
        creada_por: jefe,
        ...marcas(),
      }),
    );
    expect(esErrorDeRestriccion(error)).toBe(true);
    const traducido = traducirErrorD1(error);
    expect(traducido).toBeInstanceOf(ErrorApi);
    expect(traducido).toMatchObject({
      code: 'ID_DUPLICADO',
      details: { entidad: 'production_orders', campos: ['id'] },
    });
  });

  it('UNIQUE de otra columna y PK compuesta → CONFLICTO con los campos', async () => {
    const material = await nuevoMaterial();
    const fila = await env.DB.prepare('SELECT codigo FROM materials WHERE id = ?')
      .bind(material)
      .first<{ codigo: string }>();
    const unico = await errorDe(() =>
      insertar('materials', {
        id: uuidv7(),
        codigo: fila?.codigo ?? '',
        nombre: 'Copia',
        unidad: 'kg',
        costo_unitario_cop: 1,
        ...marcas(),
      }),
    );
    expect(traducirErrorD1(unico)).toMatchObject({
      code: 'CONFLICTO',
      details: { entidad: 'materials', campos: ['codigo'] },
    });

    const jefe = await crearUsuario('jefe');
    const orden = await nuevaOrden(jefe);
    const supervisor = await crearUsuario('supervisor');
    const valores = {
      order_id: orden,
      user_id: supervisor,
      asignado_por: jefe,
      ...marcas(),
    };
    await insertar('order_supervisors', valores);
    const compuesta = await errorDe(() => insertar('order_supervisors', valores));
    expect(traducirErrorD1(compuesta)).toMatchObject({
      code: 'CONFLICTO',
      details: { entidad: 'order_supervisors', campos: ['order_id', 'user_id'] },
    });
  });

  it('triggers → su código de negocio o CONFLICTO', async () => {
    const jefe = await crearUsuario('jefe');
    const finalizada = await nuevaOrden(jefe, 'finalizada');
    const reabrir = await errorDe(() =>
      env.DB.prepare(`UPDATE production_orders SET estado = 'en_proceso' WHERE id = ?`)
        .bind(finalizada)
        .run(),
    );
    expect(traducirErrorD1(reabrir)?.code).toBe('ESTADO_ORDEN_INVALIDO');

    const planeada = await nuevaOrden(jefe, 'planeada');
    const salto = await errorDe(() =>
      env.DB.prepare(`UPDATE production_orders SET estado = 'finalizada' WHERE id = ?`)
        .bind(planeada)
        .run(),
    );
    expect(traducirErrorD1(salto)?.code).toBe('ESTADO_ORDEN_INVALIDO');

    // Un jefe que valida su propio consumo.
    const material = await nuevoMaterial();
    const orden = await nuevaOrden(jefe);
    const dispositivoJefe = await crearDispositivo(jefe);
    const propio = await nuevoConsumo({
      orderId: orden,
      materialId: material,
      registradoPor: jefe,
      deviceId: dispositivoJefe,
      cantidad: 1,
    });
    const autoaprobacion = await errorDe(() => decidir(propio, jefe, 'aprobado'));
    expect(traducirErrorD1(autoaprobacion)?.code).toBe('AUTOAPROBACION');

    // Un consumo ya decidido no admite cambios.
    const s = await supervisorConDispositivo();
    const decidido = await nuevoConsumo({
      orderId: orden,
      materialId: material,
      registradoPor: s.id,
      deviceId: s.deviceId,
      cantidad: 1,
    });
    await decidir(decidido, jefe, 'aprobado');
    const editarDecidido = await errorDe(() =>
      env.DB.prepare('UPDATE consumptions SET lote = ?, version = version + 1 WHERE id = ?')
        .bind('L-2', decidido)
        .run(),
    );
    expect(traducirErrorD1(editarDecidido)?.code).toBe('CONSUMO_NO_PENDIENTE');

    // Trigger sin código propio (inmutabilidad de la auditoría) → CONFLICTO.
    const auditoria = await crearAuditoria();
    const inmutable = await errorDe(() =>
      env.DB.prepare(`UPDATE audit_log SET accion = 'x' WHERE id = ?`).bind(auditoria).run(),
    );
    expect(traducirErrorD1(inmutable)).toMatchObject({ code: 'CONFLICTO', details: undefined });

    const sinBorrar = await errorDe(() =>
      env.DB.prepare('DELETE FROM materials WHERE id = ?').bind(material).run(),
    );
    expect(traducirErrorD1(sinBorrar)?.code).toBe('CONFLICTO');
  });

  it('CHECK y NOT NULL → VALIDACION; FOREIGN KEY → CONFLICTO', async () => {
    const check = await errorDe(() =>
      insertar('materials', {
        id: uuidv7(),
        codigo: `C-${uuidv7()}`,
        nombre: 'Negativo',
        unidad: 'kg',
        costo_unitario_cop: -1,
        ...marcas(),
      }),
    );
    expect(traducirErrorD1(check)).toMatchObject({
      code: 'VALIDACION',
      details: [{ campo: '', mensaje: expect.any(String) as string }],
    });
    // El nombre de la restricción no se filtra al cliente.
    expect(JSON.stringify(traducirErrorD1(check)?.details)).not.toContain('materials_');

    const notNull = await errorDe(() =>
      env.DB.prepare(
        `INSERT INTO materials (id, codigo, nombre, unidad, costo_unitario_cop, created_at, updated_at)
         VALUES (?, NULL, 'n', 'kg', 1, ?, ?)`,
      )
        .bind(uuidv7(), ahora(), ahora())
        .run(),
    );
    expect(traducirErrorD1(notNull)?.code).toBe('VALIDACION');

    const jefe = await crearUsuario('jefe');
    const orden = await nuevaOrden(jefe);
    const fk = await errorDe(() =>
      insertar('order_planned_materials', {
        order_id: orden,
        material_id: uuidv7(),
        cantidad_planeada: 1,
        unidad: 'kg',
        ...marcas(),
      }),
    );
    expect(traducirErrorD1(fk)?.code).toBe('CONFLICTO');
  });

  it('un error que no es de restricción no se traduce (sigue siendo interno o transitorio)', async () => {
    const malformado = await errorDe(() => env.DB.prepare(`SELECT json('x')`).run());
    expect(esErrorDeRestriccion(malformado)).toBe(false);
    expect(traducirErrorD1(malformado)).toBeNull();
    expect(traducirErrorD1('texto')).toBeNull();
    expect(esErrorDeRestriccion(null)).toBe(false);
    // Un mensaje de restricción sin el detalle de UNIQUE sigue siendo un conflicto.
    expect(
      traducirErrorD1(
        new Error('D1_ERROR: x: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)'),
      ),
    ).toMatchObject({ code: 'CONFLICTO', details: undefined });
    expect(traducirErrorD1(new Error('D1_ERROR: SQLITE_CONSTRAINT'))?.code).toBe('CONFLICTO');
  });
});

describe('ejecutarPlan', () => {
  async function planDeOrden(ctx: Contexto) {
    const material = await nuevoMaterial();
    return crearOrden(ctx, {
      codigo: codigoOrden(),
      linea: 'Moldeo',
      materiales: [{ material_id: material, cantidad_planeada: 10, unidad: 'kg' }],
    });
  }

  async function existeOrden(id: string): Promise<boolean> {
    return (
      (await env.DB.prepare('SELECT 1 AS x FROM production_orders WHERE id = ?')
        .bind(id)
        .first()) !== null
    );
  }

  it('un fallo forzado a mitad del batch de un comando no deja datos parciales', async () => {
    const ctx = await contextoDe('jefe');
    const plan = await planDeOrden(ctx);
    expect(plan.sentencias).toHaveLength(4); // orden, su auditoría, plan, su auditoría
    // Después de la orden y su auditoría, una sentencia que choca con un trigger de inmutabilidad.
    const auditoria = await crearAuditoria();
    const saboteada: PlanDeEscritura<unknown> = {
      ...plan,
      sentencias: [
        ...plan.sentencias.slice(0, 2),
        env.DB.prepare(`UPDATE audit_log SET accion = 'x' WHERE id = ?`).bind(auditoria),
        ...plan.sentencias.slice(2),
      ],
    };
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, saboteada)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await existeOrden(plan.respuesta.id)).toBe(false);
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    const { n } = (await env.DB.prepare(
      'SELECT count(*) AS n FROM order_planned_materials WHERE order_id = ?',
    )
      .bind(plan.respuesta.id)
      .first<{ n: number }>()) ?? { n: -1 };
    expect(n).toBe(0);
  });

  it('un error que no es de restricción se relanza tal cual y tampoco deja nada', async () => {
    const ctx = await contextoDe('jefe');
    const plan = await planDeOrden(ctx);
    const roto = { ...plan, sentencias: [...plan.sentencias, env.DB.prepare(`SELECT json('x')`)] };
    const error = await errorDe(() => ejecutarPlan(env.DB, roto));
    expect(error).not.toBeInstanceOf(ErrorApi);
    expect(await existeOrden(plan.respuesta.id)).toBe(false);
  });

  it('si la principal no aplica, la cadena condicional no escribe y lanza el error del plan', async () => {
    const ctx = await contextoDe('jefe');
    const plan = await planDeOrden(ctx);
    // Mismo plan con la principal neutralizada: un INSERT condicionado que no inserta nada.
    const sinPrincipal: PlanDeEscritura<unknown> = {
      ...plan,
      sentencias: [env.DB.prepare('SELECT 1 WHERE 0'), ...plan.sentencias.slice(1)],
      siNoAplica: new ErrorApi('ESTADO_ORDEN_INVALIDO'),
    };
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, sinPrincipal)).rejects.toMatchObject({
      code: 'ESTADO_ORDEN_INVALIDO',
    });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    expect(await existeOrden(plan.respuesta.id)).toBe(false);
  });

  it('ejecuta las sentencias adicionales al final del mismo batch (uso de /sync/push)', async () => {
    const ctx = await contextoDe('jefe');
    const plan = await planDeOrden(ctx);
    const marca = await crearAuditoria();
    const adicional = env.DB.prepare(
      `INSERT INTO audit_log (id, entidad, entidad_id, accion, server_at, created_at, updated_at)
       SELECT ?, 'prueba', ?, 'adicional', ?, ?, ? WHERE EXISTS (SELECT 1 FROM production_orders WHERE id = ?)`,
    ).bind(uuidv7(), marca, ahora(), ahora(), ahora(), plan.respuesta.id);
    const antes = await ultimoSeq();
    const respuesta = await ejecutarPlan(env.DB, plan, [adicional]);
    expect(respuesta.id).toBe(plan.respuesta.id);
    expect((await auditoriaDesde(antes)).map((f) => f.accion)).toEqual([
      'orden.crear',
      'orden.planear_material',
      'adicional',
    ]);
  });

  it('un plan sin cambios no ejecuta nada y devuelve la respuesta', async () => {
    const antes = await ultimoSeq();
    expect(await ejecutarPlan(env.DB, planSinCambios({ ok: true }))).toEqual({ ok: true });
    expect(await ejecutarPlan(env.DB, { sentencias: [], principal: null, respuesta: 1 })).toBe(1);
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });
});

describe('visibilidad', () => {
  it('jefe y admin ven todo; el supervisor solo lo asignado activo y sus propios consumos', async () => {
    const jefe = await contextoDe('jefe');
    const admin = await contextoDe('admin');
    const supervisor = await contextoDe('supervisor');
    const asignada = await nuevaOrden(jefe.actor.id);
    const quitada = await nuevaOrden(jefe.actor.id);
    const ajena = await nuevaOrden(jefe.actor.id);
    await asignar(asignada, supervisor.actor.id, admin.actor.id);
    await asignar(quitada, supervisor.actor.id, admin.actor.id, 0);

    for (const ctx of [jefe, admin]) {
      expect(veTodasLasOrdenes(ctx)).toBe(true);
      expect(await ordenesVisibles(ctx)).toEqual({ todas: true });
      expect(filtroOrdenVisible(ctx, 'o.id')).toEqual({ sql: '1 = 1', parametros: [] });
      expect(await puedeVerOrden(ctx, ajena)).toBe(true);
    }

    expect(veTodasLasOrdenes(supervisor)).toBe(false);
    const visibles = await ordenesVisibles(supervisor);
    expect(visibles).toEqual({ todas: false, ids: new Set([asignada]) });
    expect(filtroOrdenVisible(supervisor, 'c.order_id').parametros).toEqual([supervisor.actor.id]);
    expect(await puedeVerOrden(supervisor, asignada)).toBe(true);
    expect(await puedeVerOrden(supervisor, quitada)).toBe(false);
    expect(await puedeVerOrden(supervisor, ajena)).toBe(false);

    // ADR 0005 regla 2: sus propios consumos los ve aunque haya perdido la asignación.
    expect(
      await puedeVerConsumo(supervisor, { order_id: quitada, registrado_por: supervisor.actor.id }),
    ).toBe(true);
    const otro = uuidv7();
    expect(await puedeVerConsumo(supervisor, { order_id: quitada, registrado_por: otro })).toBe(
      false,
    );
    expect(await puedeVerConsumo(supervisor, { order_id: asignada, registrado_por: otro })).toBe(
      true,
    );
    expect(await puedeVerConsumo(jefe, { order_id: ajena, registrado_por: otro })).toBe(true);
  });

  it('filtroOrdenVisible solo acepta nombres de columna', async () => {
    const supervisor = await contextoDe('supervisor');
    expect(() => filtroOrdenVisible(supervisor, 'o.id; DROP TABLE x')).toThrow(/columna/);
  });

  it('contextoDesdeHono toma actor, rol y dispositivo de la sesión', () => {
    const sesion = {
      userId: uuidv7(),
      rol: 'jefe' as const,
      deviceId: uuidv7(),
      familiaId: uuidv7(),
    };
    const c = { get: () => sesion, env: { DB: env.DB } } as unknown as Parameters<
      typeof contextoDesdeHono
    >[0];
    const ctx = contextoDesdeHono(c, { clientAt: '2026-10-29T20:55:00.000Z' });
    expect(ctx).toMatchObject({
      actor: { id: sesion.userId, rol: 'jefe' },
      deviceId: sesion.deviceId,
      clientAt: '2026-10-29T20:55:00.000Z',
    });
    expect(ctx.ahora).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(contextoDesdeHono(c)).not.toHaveProperty('clientAt');
  });
});

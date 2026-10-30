// A1 (docs/correcciones-v1.2.md, ADR 0028): la auditoría y las sentencias dependientes de cada
// escritura de dominio quedan condicionadas a la MARCA que solo la sentencia principal de ese mismo
// batch pudo escribir, nunca a una coincidencia de hora o de valores.
//
// Técnica (determinista): dos planes del MISMO comando, con el MISMO `ahora`, construidos sobre el
// mismo estado inicial y ejecutados uno tras otro contra la D1 local real. El primero gana; el
// segundo no aplica y no puede dejar ninguna fila (auditoría ni dependiente) a su nombre.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { editarConsumo, registrarConsumo } from '../src/dominio/consumos';
import { buscarEvidencia, planMarcarSubida } from '../src/dominio/evidencias';
import { editarMaterial } from '../src/dominio/materiales';
import { registrarNovedad } from '../src/dominio/novedades';
import { crearOrden, finalizarOrden, iniciarOrden } from '../src/dominio/ordenes';
import { ejecutarPlan } from '../src/dominio/plan';
import { cambiarTolerancia, leerTolerancia } from '../src/dominio/settings';
import { reemplazarSupervisores } from '../src/dominio/asignaciones';
import { aprobarConsumo, rechazarConsumo } from '../src/dominio/validaciones';
import {
  contarAuditoria,
  contextoFijo,
  horaFija,
  ordenDelSupervisor,
} from './correcciones-a1-helpers';
import { codigoOrden, nuevaOrden, nuevoConsumo, nuevoMaterial } from './fase2-helpers';
import {
  crearConsumo,
  crearEscenario,
  crearEvidencia,
  crearNovedad,
  crearUsuario,
} from './fixtures-db';

describe('A1: subir evidencia', () => {
  it('dos confirmaciones con el mismo ahora: una sola evidencia.subida', async () => {
    const e = await crearEscenario();
    const evidencia = await crearEvidencia(await crearNovedad(await crearConsumo(e), e.supervisor));
    const ctx = await contextoFijo('supervisor', horaFija());
    const fila = await buscarEvidencia(env.DB, evidencia);
    if (fila === null) {
      throw new Error('evidencia inexistente');
    }
    const a = planMarcarSubida(ctx, fila);
    const b = planMarcarSubida(ctx, fila);

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'EVIDENCIA_YA_SUBIDA' });

    expect(await contarAuditoria('evidences', evidencia, 'evidencia.subida')).toBe(1);
  });
});

describe('A1: consumos por REST', () => {
  it('editar: dos ediciones de la misma versión con el mismo ahora, una sola consumo.editar', async () => {
    const ctx = await contextoFijo('supervisor', horaFija());
    const { orden, material } = await ordenDelSupervisor(ctx);
    const id = await nuevoConsumo({
      orderId: orden,
      materialId: material,
      registradoPor: ctx.actor.id,
      deviceId: ctx.deviceId,
      cantidad: 10,
    });
    const a = await editarConsumo(ctx, { id, version: 1, client_created_at: ctx.ahora, lote: 'A' });
    const b = await editarConsumo(ctx, { id, version: 1, client_created_at: ctx.ahora, lote: 'B' });

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('consumptions', id, 'consumo.editar')).toBe(1);
    const fila = await env.DB.prepare('SELECT lote, version FROM consumptions WHERE id = ?')
      .bind(id)
      .first();
    expect(fila).toEqual({ lote: 'A', version: 2 });
  });

  it('crear duplicado: el perdedor (mismo id y mismo ahora) no audita una creación', async () => {
    const ctx = await contextoFijo('supervisor', horaFija());
    const { orden, material } = await ordenDelSupervisor(ctx);
    const entrada = {
      id: uuidv7(),
      order_id: orden,
      material_id: material,
      cantidad: 10,
      unidad: 'kg' as const,
      lote: 'L-1',
      client_created_at: ctx.ahora,
    };
    const a = await registrarConsumo(ctx, entrada);
    const b = await registrarConsumo(ctx, entrada);

    await ejecutarPlan(env.DB, a);
    // El acumulado leído ya no es el actual: la principal del perdedor no inserta (y no choca).
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('consumptions', entrada.id, 'consumo.crear')).toBe(1);
  });
});

describe('A1: novedad duplicada', () => {
  // ADR 0028 punto 10: su INSERT es `VALUES`, así que el perdedor aborta el batch por la clave
  // primaria. No podía fallar antes de la corrección; queda como prueba de no regresión.
  it('el perdedor aborta por la clave primaria: una sola novedad.crear y una evidencia.crear', async () => {
    const e = await crearEscenario();
    const consumo = await crearConsumo(e);
    const ctx = {
      ...(await contextoFijo('supervisor', horaFija())),
      actor: { id: e.supervisor, rol: 'supervisor' as const },
      deviceId: e.dispositivo,
    };
    const evidencia = uuidv7();
    const entrada = {
      id: uuidv7(),
      consumption_id: consumo,
      tipo: 'merma' as const,
      descripcion: 'Derrame al cargar',
      client_created_at: ctx.ahora,
      evidencias: [
        { id: evidencia, mime: 'image/jpeg' as const, tamano_bytes: 10, sha256: 'b'.repeat(64) },
      ],
    };
    // El supervisor del escenario no está asignado a la orden: se asigna para que la vea.
    await env.DB.prepare(
      `INSERT INTO order_supervisors (order_id, user_id, asignado_por, activo, created_at, updated_at)
       SELECT order_id, ?, ?, 1, ?, ? FROM consumptions WHERE id = ?`,
    )
      .bind(e.supervisor, e.jefe, ctx.ahora, ctx.ahora, consumo)
      .run();
    const a = await registrarNovedad(ctx, entrada);
    const b = await registrarNovedad(ctx, entrada);

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'ID_DUPLICADO' });

    expect(await contarAuditoria('incidents', entrada.id, 'novedad.crear')).toBe(1);
    expect(await contarAuditoria('evidences', evidencia, 'evidencia.crear')).toBe(1);
  });
});

describe('A1: validar (incluida la lectura B11)', () => {
  async function pendiente() {
    const e = await crearEscenario();
    const consumo = await crearConsumo(e);
    const ctx = await contextoFijo('jefe', horaFija());
    return { consumo, ctx };
  }

  it('aprobar dos veces con el mismo id y el mismo ahora: el perdedor no aplica ni audita', async () => {
    const { consumo, ctx } = await pendiente();
    const entrada = {
      id: uuidv7(),
      consumption_id: consumo,
      version: 1,
      client_created_at: ctx.ahora,
    };
    const a = await aprobarConsumo(ctx, entrada);
    const b = await aprobarConsumo(ctx, entrada);

    await ejecutarPlan(env.DB, a);
    // B11: la lectura de verificación del perdedor no puede "ver" la validación del ganador.
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('validations', entrada.id, 'validacion.crear')).toBe(1);
    expect(await contarAuditoria('consumptions', consumo, 'consumo.aprobar')).toBe(1);
  });

  it('rechazar gana y luego aprobar con el mismo id: ninguna consumo.aprobar', async () => {
    const { consumo, ctx } = await pendiente();
    const entrada = {
      id: uuidv7(),
      consumption_id: consumo,
      version: 1,
      client_created_at: ctx.ahora,
    };
    const aprobar = await aprobarConsumo(ctx, entrada);
    const rechazar = await rechazarConsumo(ctx, { ...entrada, motivo: 'Lote equivocado' });

    await ejecutarPlan(env.DB, rechazar);
    await expect(ejecutarPlan(env.DB, aprobar)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('validations', entrada.id, 'validacion.crear')).toBe(1);
    expect(await contarAuditoria('consumptions', consumo, 'consumo.rechazar')).toBe(1);
    expect(await contarAuditoria('consumptions', consumo, 'consumo.aprobar')).toBe(0);
  });
});

describe('A1: materiales', () => {
  it('editar: dos ediciones sobre la misma lectura con el mismo ahora, una sola material.editar', async () => {
    const ctx = await contextoFijo('admin', horaFija());
    const material = await nuevoMaterial();
    const a = await editarMaterial(ctx, material, { nombre: 'Arena fina' });
    const b = await editarMaterial(ctx, material, { nombre: 'Arena fina' });

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('materials', material, 'material.editar')).toBe(1);
  });
});

describe('A1: órdenes', () => {
  it('iniciar dos veces con el mismo ahora: una sola orden.iniciar', async () => {
    const ctx = await contextoFijo('jefe', horaFija());
    const orden = await nuevaOrden(ctx.actor.id, 'planeada');
    const a = await iniciarOrden(ctx, orden);
    const b = await iniciarOrden(ctx, orden);

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('production_orders', orden, 'orden.iniciar')).toBe(1);
  });

  it('finalizar dos veces con el mismo ahora: una sola orden.finalizar', async () => {
    const ctx = await contextoFijo('jefe', horaFija());
    const orden = await nuevaOrden(ctx.actor.id, 'en_proceso');
    const a = await finalizarOrden(ctx, orden, {});
    const b = await finalizarOrden(ctx, orden, {});

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('production_orders', orden, 'orden.finalizar')).toBe(1);
  });

  it('crear con el mismo id, código y ahora: el perdedor no audita ni planea sus materiales', async () => {
    const ctx = await contextoFijo('jefe', horaFija());
    const [m1, m2] = [await nuevoMaterial(), await nuevoMaterial()];
    const id = uuidv7();
    const codigo = codigoOrden();
    const base = { id, codigo, linea: 'Moldeo' };
    const a = await crearOrden(ctx, {
      ...base,
      materiales: [{ material_id: m1, cantidad_planeada: 10, unidad: 'kg' }],
    });
    // Reenvío con otro material (mismo id del cliente, misma hora), que se desactiva antes de
    // escribir: su principal no inserta y no choca con la clave primaria.
    const b = await crearOrden(ctx, {
      ...base,
      materiales: [{ material_id: m2, cantidad_planeada: 5, unidad: 'kg' }],
    });
    await ejecutarPlan(env.DB, a);
    await env.DB.prepare('UPDATE materials SET activo = 0 WHERE id = ?').bind(m2).run();

    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('production_orders', id, 'orden.crear')).toBe(1);
    expect(
      await contarAuditoria('order_planned_materials', `${id}:${m2}`, 'orden.planear_material'),
    ).toBe(0);
    const planeados = await env.DB.prepare(
      'SELECT material_id FROM order_planned_materials WHERE order_id = ?',
    )
      .bind(id)
      .all<{ material_id: string }>();
    expect(planeados.results.map((f) => f.material_id)).toEqual([m1]);
  });
});

describe('A1: settings', () => {
  it('cambiar la tolerancia dos veces sobre la misma lectura con el mismo ahora: una sola auditoría', async () => {
    const ctx = await contextoFijo('admin', horaFija());
    const actual = await leerTolerancia(env.DB);
    const nueva = actual === 7 ? 8 : 7;
    const antes = await contarAuditoria('settings', 'tolerancia_pct', 'settings.tolerancia');
    const a = await cambiarTolerancia(ctx, { tolerancia_pct: nueva });
    const b = await cambiarTolerancia(ctx, { tolerancia_pct: nueva });

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('settings', 'tolerancia_pct', 'settings.tolerancia')).toBe(
      antes + 1,
    );
  });
});

describe('A1: asignaciones', () => {
  it('dos reemplazos sobre la misma lectura con el mismo ahora: una sola asignacion.crear', async () => {
    const ctx = await contextoFijo('admin', horaFija());
    const orden = await nuevaOrden(ctx.actor.id, 'en_proceso');
    const supervisor = await crearUsuario('supervisor');
    const a = await reemplazarSupervisores(ctx, orden, { supervisores: [supervisor] });
    const b = await reemplazarSupervisores(ctx, orden, { supervisores: [supervisor] });

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(
      await contarAuditoria('order_supervisors', `${orden}:${supervisor}`, 'asignacion.crear'),
    ).toBe(1);
  });

  it('la dependiente de otra asignación del perdedor no se aplica ni se audita', async () => {
    const ctx = await contextoFijo('admin', horaFija());
    const orden = await nuevaOrden(ctx.actor.id, 'en_proceso');
    const [s1, s2] = [await crearUsuario('supervisor'), await crearUsuario('supervisor')];
    const a = await reemplazarSupervisores(ctx, orden, { supervisores: [s1] });
    // El perdedor pide dos: su primera (s1) es la principal y la de s2 es una dependiente.
    const b = await reemplazarSupervisores(ctx, orden, { supervisores: [s1, s2] });

    await ejecutarPlan(env.DB, a);
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });

    expect(await contarAuditoria('order_supervisors', `${orden}:${s1}`, 'asignacion.crear')).toBe(
      1,
    );
    expect(await contarAuditoria('order_supervisors', `${orden}:${s2}`, 'asignacion.crear')).toBe(
      0,
    );
    const filas = await env.DB.prepare(
      'SELECT count(*) AS n FROM order_supervisors WHERE order_id = ?',
    )
      .bind(orden)
      .first<{ n: number }>();
    expect(filas?.n).toBe(1);
  });
});

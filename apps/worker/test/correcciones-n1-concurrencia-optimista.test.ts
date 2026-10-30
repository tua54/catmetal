// N1 (nuevo en correcciones v1.2, encontrado al corregir A1): la concurrencia optimista de algunas
// escrituras usaba como testigo solo `updated_at` (materiales) o el valor leído (settings,
// asignaciones). Con dos escrituras en el mismo milisegundo, o con un ABA del valor, una edición
// basada en una lectura vieja pisaba a otra sin enterarse (actualización perdida) y auditaba un
// `datos_antes` que ya no era el estado previo. Corrección: la marca de escritura leída
// (`escritura_id IS ?`, ADR 0028) entra también en el WHERE de la sentencia principal.
//
// Pruebas deterministas sobre la D1 local real: los planes se construyen sobre el mismo estado y
// se ejecutan en el orden que provoca la carrera.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { reemplazarSupervisores } from '../src/dominio/asignaciones';
import { editarMaterial } from '../src/dominio/materiales';
import { ejecutarPlan } from '../src/dominio/plan';
import { cambiarTolerancia, leerTolerancia } from '../src/dominio/settings';
import { contarAuditoria, contextoFijo, horaFija } from './correcciones-a1-helpers';
import { asignar, nuevaOrden } from './fase2-helpers';
import { crearUsuario, insertar } from './fixtures-db';

describe('N1: materiales', () => {
  it('tres ediciones en el mismo milisegundo: la de la lectura vieja no pisa a la otra', async () => {
    const ahora = horaFija();
    const ctx = await contextoFijo('admin', ahora);
    // El material fue escrito en este mismo milisegundo (por ejemplo, por otra edición).
    const id = uuidv7();
    await insertar('materials', {
      id,
      codigo: `MAT-${id}`,
      nombre: 'Arena',
      unidad: 'kg',
      costo_unitario_cop: 1000,
      activo: 1,
      created_at: ahora,
      updated_at: ahora,
    });
    const b = await editarMaterial(ctx, id, { nombre: 'Arena B' });
    const c = await editarMaterial(ctx, id, { costo_unitario_cop: 2000 });

    await ejecutarPlan(env.DB, b);
    // C leyó el estado anterior a B: su UPDATE no puede aplicar aunque `updated_at` coincida.
    await expect(ejecutarPlan(env.DB, c)).rejects.toMatchObject({ code: 'CONFLICTO' });

    const fila = await env.DB.prepare(
      'SELECT nombre, costo_unitario_cop FROM materials WHERE id = ?',
    )
      .bind(id)
      .first();
    expect(fila).toEqual({ nombre: 'Arena B', costo_unitario_cop: 1000 });
    expect(await contarAuditoria('materials', id, 'material.editar')).toBe(1);
  });
});

describe('N1: settings', () => {
  it('ABA de la tolerancia: la escritura basada en la lectura vieja no aplica', async () => {
    const original = await leerTolerancia(env.DB);
    const [v1, v2] = original === 3 ? [4, 6] : [3, original === 6 ? 4 : 6];
    const viejo = await contextoFijo('admin', horaFija(60_000));
    // B lee `original` …
    const b = await cambiarTolerancia(viejo, { tolerancia_pct: v2 });
    // … A la cambia a v1 y C la devuelve a `original` (otro admin, otro momento).
    const otro = await contextoFijo('admin', horaFija(61_000));
    await ejecutarPlan(env.DB, await cambiarTolerancia(otro, { tolerancia_pct: v1 }));
    const tercero = await contextoFijo('admin', horaFija(62_000));
    await ejecutarPlan(env.DB, await cambiarTolerancia(tercero, { tolerancia_pct: original }));

    // El valor es el leído, pero no es la misma escritura: B no aplica y no audita un `antes` falso.
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await leerTolerancia(env.DB)).toBe(original);
  });
});

describe('N1: asignaciones', () => {
  it('ABA de una asignación: el reemplazo basado en la lectura vieja no aplica', async () => {
    const admin = await contextoFijo('admin', horaFija(60_000));
    const orden = await nuevaOrden(admin.actor.id, 'en_proceso');
    const supervisor = await crearUsuario('supervisor');
    await asignar(orden, supervisor, admin.actor.id);
    // B lee la asignación activa y la quiere quitar …
    const b = await reemplazarSupervisores(admin, orden, { supervisores: [] });
    // … otro admin la quita y un tercero la vuelve a poner (otro `asignado_por`).
    const otro = await contextoFijo('admin', horaFija(61_000));
    await ejecutarPlan(env.DB, await reemplazarSupervisores(otro, orden, { supervisores: [] }));
    const tercero = await contextoFijo('admin', horaFija(62_000));
    await ejecutarPlan(
      env.DB,
      await reemplazarSupervisores(tercero, orden, { supervisores: [supervisor] }),
    );

    // Mismo `activo` que el leído, pero otra escritura: B no aplica (su `antes` ya no es cierto).
    await expect(ejecutarPlan(env.DB, b)).rejects.toMatchObject({ code: 'CONFLICTO' });
    const fila = await env.DB.prepare(
      'SELECT activo, asignado_por FROM order_supervisors WHERE order_id = ? AND user_id = ?',
    )
      .bind(orden, supervisor)
      .first();
    expect(fila).toEqual({ activo: 1, asignado_por: tercero.actor.id });
  });
});

import { uuidv7, type CambioSync, type SyncPullResponse } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  aplicarCambios,
  aplicarEntidades,
  completarHidratacion,
  leerMetaSync,
} from './aplicar-cambios';
import { completarSnapshot, guardarPaginaSnapshot } from './snapshot-temporal';
import { db } from './db';
import {
  aplicarResultados,
  aprobarLocal,
  contarPendientes,
  editarConsumoLocal,
  marcarEnviando,
  marcarEvidenciaSubida,
  registrarConsumoConNovedadLocal,
  registrarConsumoLocal,
  registrarNovedadLocal,
  siguienteLote,
} from './outbox';
import {
  consumoServidor,
  evidenciaServidor,
  fotoDe,
  limpiarDb,
  novedadServidor,
  resultado,
  validacionServidor,
} from './pruebas/fabricas';

const A = uuidv7();
const B = uuidv7();
const ORDEN = uuidv7();
const EPOCA = 'epoca-1';

let seq = 0;
function cambio(
  tipo: CambioSync['tipo'],
  entidad: string,
  id: string,
  datos: Record<string, unknown> | null = null,
): CambioSync {
  seq += 1;
  return { seq, tipo, entidad, id, datos };
}

function pagina(cambios: CambioSync[], extra: Partial<SyncPullResponse> = {}): SyncPullResponse {
  return { epoca: EPOCA, cursor: seq, hay_mas: false, cambios, ...extra };
}

// `datos` es cualquier fila con `id` (Consumo, Novedad…); el spread la convierte en objeto JSON plano.
function upsert<T extends { id: string }>(entidad: string, datos: T): CambioSync {
  return cambio('upsert', entidad, datos.id, { ...datos });
}

/** Guarda un snapshot completo de una sola página en el área temporal y lo reemplaza. */
async function snapshotCompleto(
  userId: string,
  entidades: CambioSync[],
  extra: { epoca?: string; cursor?: number } = {},
): Promise<Awaited<ReturnType<typeof completarSnapshot>>> {
  await guardarPaginaSnapshot(userId, {
    epoca: extra.epoca ?? EPOCA,
    cursor: extra.cursor ?? seq,
    entidades: entidades.map((c) => ({ entidad: c.entidad, id: c.id, datos: c.datos ?? {} })),
    siguiente_pagina: null,
  });
  return completarSnapshot(userId);
}

async function enviarYAplicar(userId: string): Promise<void> {
  const lote = await marcarEnviando(userId, await siguienteLote(userId));
  await aplicarResultados(
    userId,
    lote,
    lote.map((_, i) => resultado(lote, i, { resultado: 'aplicada' })),
  );
}

beforeEach(async () => {
  await limpiarDb();
});

describe('aplicarCambios: upsert', () => {
  it('guarda cada entidad conocida en la partición del usuario y avanza cursor y época', async () => {
    const material = {
      id: uuidv7(),
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      costo_unitario_cop: 1200,
      activo: true,
    };
    const orden = {
      id: ORDEN,
      codigo: 'OP-2026-0587',
      linea: 'Fundición',
      estado: 'en_proceso',
      fecha_inicio: '2026-10-29T12:00:00.000Z',
      fecha_fin: null,
      creada_por: uuidv7(),
      created_at: '2026-10-29T12:00:00.000Z',
      updated_at: '2026-10-29T12:00:00.000Z',
    };
    const consumo = consumoServidor({ order_id: ORDEN, requiere_novedad: true });
    const novedad = novedadServidor({ consumption_id: consumo.id });
    const evidencia = evidenciaServidor({ incident_id: novedad.id, subido: true });
    const validacion = validacionServidor({
      consumption_id: consumo.id,
      decision: 'rechazado',
      motivo: 'No',
    });

    const r = await aplicarCambios(
      A,
      pagina([
        upsert('materials', material),
        upsert('production_orders', orden),
        cambio('upsert', 'order_planned_materials', 'p1', {
          order_id: ORDEN,
          material_id: material.id,
          cantidad_planeada: 100,
          unidad: 'kg',
        }),
        cambio('upsert', 'order_supervisors', 's1', {
          order_id: ORDEN,
          user_id: A,
          asignado_por: uuidv7(),
          activo: 1,
        }),
        cambio('upsert', 'settings', 'tolerancia_pct', { clave: 'tolerancia_pct', valor: '7.5' }),
        upsert('users', { id: B, nombre: 'Beatriz', rol: 'jefe', email: 'b@x.co', activo: true }),
        upsert('consumptions', consumo),
        upsert('incidents', novedad),
        upsert('evidences', evidencia),
        upsert('validations', validacion),
      ]),
    );
    expect(r).toMatchObject({ aplicados: 10, ignorados: 0, epoca_cambiada: false, acciones: [] });
    expect(await db.materiales.get([A, material.id])).toMatchObject({ nombre: 'Arena sílice' });
    expect(await db.ordenes.get([A, ORDEN])).toMatchObject({
      codigo: 'OP-2026-0587',
      revocada: false,
    });
    expect(await db.planeados.get([A, 'p1'])).toMatchObject({ cantidad_planeada: 100 });
    expect(await db.asignaciones.get([A, 's1'])).toMatchObject({
      supervisor_id: A,
      activo: true,
      user_id: A,
    });
    expect(await db.settings.get([A, 'tolerancia_pct'])).toMatchObject({ valor: 7.5 });
    const usuario = await db.usuarios.get([A, B]);
    expect(usuario).toEqual({ user_id: A, id: B, nombre: 'Beatriz', rol: 'jefe', activo: true });
    expect(await db.evidencias.get([A, evidencia.id])).toMatchObject({
      estado_subida: 'subida',
      datos: null,
    });
    expect(await db.consumos.get([A, consumo.id])).toMatchObject({
      estado_local: 'rechazado',
      motivo_rechazo: 'No',
      requiere_novedad: true,
      falta_novedad: false,
    });
    expect(await leerMetaSync(A)).toMatchObject({ cursor: seq, epoca: EPOCA, acciones: [] });
    // Nada en la partición de B.
    expect(await db.consumos.get([B, consumo.id])).toBeUndefined();
  });

  it('ignora entidades desconocidas y datos malformados sin detener la página', async () => {
    const r = await aplicarCambios(
      A,
      pagina([
        cambio('upsert', 'entidad_futura', 'x', { a: 1 }),
        cambio('upsert', 'consumptions', 'y', { id: 'y' }),
        cambio('upsert', 'incidents', 'y', { id: 'y' }),
        cambio('upsert', 'evidences', 'y', { id: 'y' }),
        cambio('upsert', 'validations', 'y', { id: 'y' }),
        cambio('upsert', 'production_orders', 'y', { id: 'y' }),
        cambio('upsert', 'materials', 'y', { id: 'y' }),
        cambio('upsert', 'order_planned_materials', 'y', { order_id: 'o' }),
        cambio('upsert', 'order_supervisors', 'y', { order_id: 'o' }),
        cambio('upsert', 'users', 'y', { id: 'y' }),
        cambio('upsert', 'materials', 'y', null),
        cambio('hidratar', 'materials', 'y'),
      ]),
    );
    expect(r).toMatchObject({ aplicados: 0, ignorados: 12 });
    expect((await leerMetaSync(A)).cursor).toBe(seq);
  });

  it('novedad con evidencias anidadas, settings sin clave, usuario sin rol y valores no JSON', async () => {
    const novedad = novedadServidor();
    const evidencia = evidenciaServidor({ incident_id: novedad.id });
    await aplicarCambios(
      A,
      pagina([
        cambio('upsert', 'incidents', novedad.id, {
          ...novedad,
          evidencias: [{ ...evidencia }, { x: 1 }],
        }),
        cambio('upsert', 'settings', 'modo', { valor: 'no-json' }),
        cambio('upsert', 'settings', 'limite', { valor: 3 }),
        upsert('users', { id: B, nombre: 'Beto' }),
        cambio('upsert', 'order_supervisors', 's2', { order_id: ORDEN, user_id: B }),
      ]),
    );
    expect(await db.evidencias.get([A, evidencia.id])).toMatchObject({ estado_subida: 'remota' });
    expect(await db.settings.get([A, 'modo'])).toMatchObject({ valor: 'no-json' });
    expect(await db.settings.get([A, 'limite'])).toMatchObject({ valor: 3 });
    expect(await db.usuarios.get([A, B])).toMatchObject({ rol: null, activo: true });
    expect(await db.asignaciones.get([A, 's2'])).toMatchObject({
      activo: true,
      asignado_por: null,
    });
  });

  it('un upsert nunca pisa un consumo con mutaciones propias en cola; se adopta al vaciarse la cola', async () => {
    const { id } = await registrarConsumoLocal(A, {
      order_id: ORDEN,
      material_id: uuidv7(),
      cantidad: 5,
      unidad: 'kg',
      lote: 'L',
    });
    await enviarYAplicar(A);
    await editarConsumoLocal(A, { id, cantidad: 9 });
    const servidor = consumoServidor({
      id,
      order_id: ORDEN,
      registrado_por: A,
      cantidad: 5,
      requiere_novedad: true,
      updated_at: '2026-10-29T18:00:00.000Z',
    });
    await aplicarCambios(A, pagina([upsert('consumptions', servidor)]));
    expect(await db.consumos.get([A, id])).toMatchObject({
      cantidad: 9,
      estado_local: 'pendiente_sync',
      requiere_novedad: false,
      servidor_diferido: servidor,
    });

    const lote = await marcarEnviando(A, await siguienteLote(A));
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'rechazada', code: 'CONSUMO_NO_PENDIENTE' }),
    ]);
    expect(await db.consumos.get([A, id])).toMatchObject({
      cantidad: 5,
      requiere_novedad: true,
      falta_novedad: true,
      servidor_diferido: null,
      estado_local: 'rechazado_sync',
    });
  });

  it('novedades y validaciones en cola también difieren el estado del servidor', async () => {
    const r = await registrarConsumoConNovedadLocal(
      A,
      { order_id: ORDEN, material_id: uuidv7(), cantidad: 5, unidad: 'kg', lote: 'L' },
      { tipo: 'merma', descripcion: 'local' },
    );
    const novedad = novedadServidor({
      id: r.novedad_id,
      consumption_id: r.consumo_id,
      descripcion: 'servidor',
    });
    await aplicarCambios(A, pagina([upsert('incidents', novedad)]));
    expect(await db.novedades.get([A, r.novedad_id])).toMatchObject({
      descripcion: 'local',
      estado_local: 'pendiente_sync',
    });
    await enviarYAplicar(A);
    expect(await db.novedades.get([A, r.novedad_id])).toMatchObject({
      descripcion: 'servidor',
      estado_local: 'sincronizado',
      servidor_diferido: null,
    });

    const JEFE = uuidv7();
    const consumo = consumoServidor();
    await aplicarEntidades(JEFE, [
      { entidad: 'consumptions', id: consumo.id, datos: { ...consumo } },
    ]);
    const v = await aprobarLocal(JEFE, { consumption_id: consumo.id });
    const servidor = validacionServidor({
      id: v.id,
      consumption_id: consumo.id,
      validado_por: JEFE,
    });
    await aplicarCambios(JEFE, pagina([upsert('validations', servidor)]));
    expect(await db.validaciones.get([JEFE, v.id])).toMatchObject({
      estado_local: 'pendiente_sync',
      servidor: null,
      servidor_diferido: servidor,
    });
    await enviarYAplicar(JEFE);
    expect(await db.validaciones.get([JEFE, v.id])).toMatchObject({
      estado_local: 'sincronizado',
      servidor,
    });
    expect(await db.consumos.get([JEFE, consumo.id])).toMatchObject({ estado_local: 'aprobado' });
  });

  it('un estado viejo del servidor no hace retroceder la vista', async () => {
    const nuevo = consumoServidor({ version: 3, cantidad: 30 });
    await aplicarCambios(A, pagina([upsert('consumptions', nuevo)]));
    await aplicarCambios(
      A,
      pagina([upsert('consumptions', { ...nuevo, version: 2, cantidad: 20 })]),
    );
    expect(await db.consumos.get([A, nuevo.id])).toMatchObject({ version: 3, cantidad: 30 });
  });
});

describe('aplicarCambios: revocar', () => {
  it('revocar una orden borra lo ajeno y conserva lo propio (pendiente o sincronizado)', async () => {
    const ajeno = consumoServidor({ order_id: ORDEN });
    const novedadAjena = novedadServidor({ consumption_id: ajeno.id });
    const propioSincronizado = consumoServidor({ order_id: ORDEN, registrado_por: A });
    await aplicarCambios(
      A,
      pagina([
        upsert('production_orders', {
          id: ORDEN,
          codigo: 'OP-2026-0001',
          linea: 'L1',
          estado: 'en_proceso',
          creada_por: uuidv7(),
          created_at: '2026-10-29T12:00:00.000Z',
          updated_at: '2026-10-29T12:00:00.000Z',
        }),
        cambio('upsert', 'order_planned_materials', 'p1', {
          order_id: ORDEN,
          material_id: uuidv7(),
          cantidad_planeada: 1,
          unidad: 'kg',
        }),
        cambio('upsert', 'order_supervisors', 's1', { order_id: ORDEN, user_id: A }),
        upsert('consumptions', ajeno),
        upsert('incidents', novedadAjena),
        upsert('consumptions', propioSincronizado),
      ]),
    );
    const pendiente = await registrarConsumoLocal(A, {
      order_id: ORDEN,
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });

    await aplicarCambios(A, pagina([cambio('revocar', 'production_orders', ORDEN)]));
    expect(await db.consumos.get([A, ajeno.id])).toBeUndefined();
    expect(await db.novedades.get([A, novedadAjena.id])).toBeUndefined();
    expect(await db.consumos.get([A, propioSincronizado.id])).toBeDefined();
    expect(await db.consumos.get([A, pendiente.id])).toMatchObject({
      estado_local: 'pendiente_sync',
    });
    expect(await db.planeados.get([A, 'p1'])).toBeUndefined();
    expect(await db.asignaciones.get([A, 's1'])).toBeUndefined();
    expect(await db.ordenes.get([A, ORDEN])).toMatchObject({ revocada: true });
    expect(await contarPendientes(A)).toBe(1);
  });

  it('revocar una orden sin datos propios la borra; las novedades ajenas con cola propia se conservan', async () => {
    const otraOrden = uuidv7();
    const ajeno = consumoServidor({ order_id: otraOrden });
    await aplicarCambios(
      A,
      pagina([
        upsert('production_orders', {
          id: otraOrden,
          codigo: 'OP-2026-0002',
          linea: 'L1',
          estado: 'en_proceso',
          creada_por: uuidv7(),
          created_at: '2026-10-29T12:00:00.000Z',
          updated_at: '2026-10-29T12:00:00.000Z',
        }),
        upsert('consumptions', ajeno),
      ]),
    );
    await aplicarCambios(A, pagina([cambio('revocar', 'production_orders', otraOrden)]));
    expect(await db.ordenes.get([A, otraOrden])).toBeUndefined();
    expect(await db.consumos.get([A, ajeno.id])).toBeUndefined();

    // Un jefe con una novedad propia en cola sobre un consumo ajeno: se conserva todo.
    const ajeno2 = consumoServidor({ order_id: otraOrden });
    await aplicarEntidades(A, [{ entidad: 'consumptions', id: ajeno2.id, datos: { ...ajeno2 } }]);
    await registrarNovedadLocal(A, { consumption_id: ajeno2.id, tipo: 'otro', descripcion: 'x' }, [
      fotoDe('abc'),
    ]);
    await aplicarCambios(A, pagina([cambio('revocar', 'production_orders', otraOrden)]));
    expect(await db.consumos.get([A, ajeno2.id])).toBeDefined();
  });

  it('revocar entidades sueltas respeta lo protegido', async () => {
    const ajeno = consumoServidor();
    const novedad = novedadServidor({ consumption_id: ajeno.id });
    const evidencia = evidenciaServidor({ incident_id: novedad.id });
    const validacion = validacionServidor({ consumption_id: ajeno.id });
    const material = {
      id: uuidv7(),
      codigo: 'MP-2',
      nombre: 'Resina',
      unidad: 'l',
      costo_unitario_cop: 5,
      activo: true,
    };
    await aplicarCambios(
      A,
      pagina([
        upsert('consumptions', ajeno),
        upsert('incidents', novedad),
        upsert('evidences', evidencia),
        upsert('validations', validacion),
        upsert('materials', material),
        upsert('users', { id: B, nombre: 'B' }),
        cambio('upsert', 'settings', 'k', { valor: '1' }),
        cambio('upsert', 'order_supervisors', 's', { order_id: ORDEN, user_id: B }),
        cambio('upsert', 'order_planned_materials', 'p', {
          order_id: ORDEN,
          material_id: material.id,
          cantidad_planeada: 1,
          unidad: 'l',
        }),
      ]),
    );
    const r = await aplicarCambios(
      A,
      pagina([
        cambio('revocar', 'evidences', evidencia.id),
        cambio('revocar', 'validations', validacion.id),
        cambio('revocar', 'incidents', novedad.id),
        cambio('revocar', 'materials', material.id),
        cambio('revocar', 'users', B),
        cambio('revocar', 'settings', 'k'),
        cambio('revocar', 'order_supervisors', 's'),
        cambio('revocar', 'order_planned_materials', 'p'),
        cambio('revocar', 'entidad_futura', 'x'),
        cambio('revocar', 'consumptions', ajeno.id),
      ]),
    );
    expect(r.aplicados).toBe(10);
    for (const tabla of [
      db.consumos,
      db.novedades,
      db.evidencias,
      db.validaciones,
      db.materiales,
      db.usuarios,
      db.settings,
      db.asignaciones,
      db.planeados,
    ]) {
      expect(await tabla.count()).toBe(0);
    }

    // Una foto local sin subir y una validación en cola no se borran.
    const propio = await registrarConsumoConNovedadLocal(
      A,
      { order_id: ORDEN, material_id: uuidv7(), cantidad: 1, unidad: 'kg', lote: 'L' },
      { tipo: 'merma', descripcion: 'x' },
      [fotoDe('abc')],
    );
    const [foto] = await db.evidencias.toArray();
    await aplicarCambios(
      A,
      pagina([
        cambio('revocar', 'evidences', foto!.id),
        cambio('revocar', 'incidents', propio.novedad_id),
        cambio('revocar', 'consumptions', propio.consumo_id),
      ]),
    );
    expect(await db.evidencias.count()).toBe(1);
    expect(await db.novedades.count()).toBe(1);
    expect(await db.consumos.count()).toBe(1);

    const JEFE = uuidv7();
    const otro = consumoServidor();
    await aplicarEntidades(JEFE, [{ entidad: 'consumptions', id: otro.id, datos: { ...otro } }]);
    const v = await aprobarLocal(JEFE, { consumption_id: otro.id });
    await aplicarCambios(JEFE, pagina([cambio('revocar', 'validations', v.id)]));
    expect(await db.validaciones.get([JEFE, v.id])).toBeDefined();
  });
});

describe('aplicarCambios: hidratar, reiniciar y época', () => {
  it('hidratar se persiste como acción hasta completarla', async () => {
    const r = await aplicarCambios(A, pagina([cambio('hidratar', 'production_orders', ORDEN)]));
    expect(r.acciones).toEqual([{ tipo: 'hidratar', order_id: ORDEN }]);
    expect((await leerMetaSync(A)).acciones).toEqual([{ tipo: 'hidratar', order_id: ORDEN }]);
    await completarHidratacion(A, ORDEN);
    expect((await leerMetaSync(A)).acciones).toEqual([]);
    await completarHidratacion(B, ORDEN);
    expect(await db.meta.get(B)).toBeUndefined();
  });

  it('reiniciar no borra nada: pide snapshot y el reemplazo completo quita lo que ya no se ve', async () => {
    const ajeno = consumoServidor();
    const propio = consumoServidor({ registrado_por: A });
    const huerfana = novedadServidor();
    const validacionHuerfana = validacionServidor();
    const evidenciaHuerfana = evidenciaServidor();
    await aplicarCambios(
      A,
      pagina([
        upsert('consumptions', ajeno),
        upsert('consumptions', propio),
        upsert('incidents', huerfana),
        upsert('validations', validacionHuerfana),
        upsert('evidences', evidenciaHuerfana),
        cambio('hidratar', 'production_orders', ORDEN),
      ]),
    );
    const pendiente = await registrarConsumoLocal(A, {
      order_id: ORDEN,
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });
    const r = await aplicarCambios(A, pagina([cambio('reiniciar', 'users', A)]));
    expect(r.acciones).toEqual([{ tipo: 'snapshot', motivo: 'reiniciar' }]);
    // ADR 0022 (M5): hasta que el snapshot esté completo, nada se borra.
    expect(await db.consumos.get([A, ajeno.id])).toBeDefined();
    expect(await db.consumos.get([A, propio.id])).toBeDefined();
    expect(await db.consumos.get([A, pendiente.id])).toBeDefined();
    expect(await db.novedades.count()).toBe(1);
    expect(await db.validaciones.count()).toBe(1);
    expect(await db.evidencias.count()).toBe(1);
    expect(await leerMetaSync(A)).toMatchObject({
      requiere_snapshot: true,
      hidrataciones: [],
      acciones: [{ tipo: 'snapshot', motivo: 'reiniciar' }],
    });

    // Mientras no se complete, la acción sigue aunque lleguen más páginas.
    const otra = await aplicarCambios(A, pagina([]));
    expect(otra.acciones).toEqual([{ tipo: 'snapshot', motivo: 'reiniciar' }]);
    // El snapshot completo solo trae el consumo propio: lo ajeno y lo huérfano no protegido se va.
    expect(await snapshotCompleto(A, [upsert('consumptions', propio)], { cursor: 500 })).toEqual({
      reemplazado: true,
      epoca_cambiada: false,
      aplicados: 1,
      ignorados: 0,
    });
    expect(await db.consumos.get([A, ajeno.id])).toBeUndefined();
    expect(await db.consumos.get([A, propio.id])).toMatchObject({
      perdido_en_restauracion: false,
    });
    expect(await db.consumos.get([A, pendiente.id])).toBeDefined();
    expect(await db.novedades.count()).toBe(0);
    expect(await db.validaciones.count()).toBe(0);
    expect(await db.evidencias.count()).toBe(0);
    expect(await leerMetaSync(A)).toMatchObject({
      cursor: 500,
      requiere_snapshot: false,
      acciones: [],
    });
  });

  it('cambio de época: reencola las aplicadas conservadas y pide snapshot sin borrar ni mover el cursor', async () => {
    await aplicarCambios(A, pagina([]));
    const r = await registrarConsumoConNovedadLocal(
      A,
      { order_id: ORDEN, material_id: uuidv7(), cantidad: 1, unidad: 'kg', lote: 'L' },
      { tipo: 'merma', descripcion: 'x' },
      [fotoDe('abc')],
    );
    await enviarYAplicar(A);
    const [foto] = await db.evidencias.toArray();
    await marcarEvidenciaSubida(A, foto!.id);
    const rechazada = await registrarConsumoLocal(A, {
      order_id: ORDEN,
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });
    const lote = await marcarEnviando(A, await siguienteLote(A));
    await aplicarResultados(A, lote, [resultado(lote, 0, { resultado: 'rechazada' })]);
    const ajeno = consumoServidor();
    await aplicarCambios(A, pagina([upsert('consumptions', ajeno)]));
    await aplicarCambios(B, pagina([]));
    expect(await contarPendientes(A)).toBe(0);
    const antes = await leerMetaSync(A);

    const respuesta = await aplicarCambios(
      A,
      pagina([upsert('consumptions', consumoServidor())], { epoca: 'epoca-2', cursor: 3 }),
    );
    expect(respuesta).toMatchObject({
      epoca_cambiada: true,
      reencoladas: 2,
      cursor: antes.cursor,
      aplicados: 0,
      acciones: [{ tipo: 'snapshot', motivo: 'epoca' }],
    });
    expect(await contarPendientes(A)).toBe(2);
    const reenvio = await siguienteLote(A);
    expect(reenvio.map((m) => m.mutation_id)).toEqual(r.mutation_ids);
    expect(await db.outbox.get(rechazada.mutation_id)).toMatchObject({ estado: 'rechazada' });
    expect(await db.consumos.get([A, r.consumo_id])).toMatchObject({
      estado_local: 'pendiente_sync',
    });
    // ADR 0022 (M5): lo ajeno sigue hasta el reemplazo; el cursor y la época, también.
    expect(await db.consumos.get([A, ajeno.id])).toBeDefined();
    expect(await db.evidencias.get([A, foto!.id])).toMatchObject({ estado_subida: 'pendiente' });
    expect(await leerMetaSync(A)).toMatchObject({
      cursor: antes.cursor,
      epoca: EPOCA,
      acciones: [{ tipo: 'snapshot', motivo: 'epoca' }],
    });
    // B no se toca.
    expect(await leerMetaSync(B)).toMatchObject({ epoca: EPOCA });

    // El snapshot completo de la época nueva (vacío) reemplaza el estado y confirma la época.
    expect(await snapshotCompleto(A, [], { epoca: 'epoca-2', cursor: 3 })).toMatchObject({
      epoca_cambiada: true,
    });
    expect(await db.consumos.get([A, ajeno.id])).toBeUndefined();
    expect(await db.consumos.get([A, r.consumo_id])).toMatchObject({
      estado_local: 'pendiente_sync',
      perdido_en_restauracion: false,
    });
    expect(await db.evidencias.get([A, foto!.id])).toMatchObject({ estado_subida: 'pendiente' });
    expect(await contarPendientes(A)).toBe(2);
    expect(await leerMetaSync(A)).toMatchObject({ cursor: 3, epoca: 'epoca-2', acciones: [] });
    expect(await leerMetaSync(B)).toMatchObject({ epoca: EPOCA });
  });

  it('un snapshot completo con otra época confirma la época nueva y reencola las aplicadas', async () => {
    await aplicarCambios(A, pagina([]));
    await registrarConsumoLocal(A, {
      order_id: ORDEN,
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });
    await enviarYAplicar(A);
    expect(await snapshotCompleto(A, [], { cursor: 10, epoca: 'otra' })).toMatchObject({
      epoca_cambiada: true,
    });
    expect(await contarPendientes(A)).toBe(1);
    expect(await leerMetaSync(A)).toMatchObject({ cursor: 10, epoca: 'otra', acciones: [] });
    expect(await snapshotCompleto(B, [], { cursor: 4, epoca: 'otra' })).toMatchObject({
      epoca_cambiada: false,
    });
    expect(await leerMetaSync(B)).toMatchObject({ cursor: 4, epoca: 'otra' });
  });

  it('rechaza una respuesta que no cumple el contrato sin aplicar nada', async () => {
    await expect(
      aplicarCambios(A, { epoca: '', cursor: -1, hay_mas: false, cambios: [] }),
    ).rejects.toThrow();
    expect(await db.meta.get(A)).toBeUndefined();
  });
});

describe('protección ante revocar y reiniciar', () => {
  it('una validación propia en cola o una novedad rechazada conservan el consumo ajeno', async () => {
    const JEFE = uuidv7();
    const conValidacion = consumoServidor({ order_id: ORDEN });
    const conNovedadRechazada = consumoServidor({ order_id: ORDEN });
    await aplicarEntidades(JEFE, [
      { entidad: 'consumptions', id: conValidacion.id, datos: { ...conValidacion } },
      { entidad: 'consumptions', id: conNovedadRechazada.id, datos: { ...conNovedadRechazada } },
    ]);
    await aprobarLocal(JEFE, { consumption_id: conValidacion.id });
    const novedad = await registrarNovedadLocal(JEFE, {
      consumption_id: conNovedadRechazada.id,
      tipo: 'otro',
      descripcion: 'x',
    });
    const lote = await marcarEnviando(JEFE, await siguienteLote(JEFE));
    await aplicarResultados(JEFE, lote, [
      resultado(lote, 1, { resultado: 'rechazada', code: 'PERMISO_DENEGADO' }),
    ]);
    expect(await db.novedades.get([JEFE, novedad.id])).toMatchObject({
      estado_local: 'rechazado_sync',
    });

    await aplicarCambios(JEFE, pagina([cambio('revocar', 'production_orders', ORDEN)]));
    expect(await db.consumos.get([JEFE, conValidacion.id])).toBeDefined();
    expect(await db.consumos.get([JEFE, conNovedadRechazada.id])).toBeDefined();

    await aplicarCambios(JEFE, pagina([cambio('reiniciar', 'users', JEFE)]));
    expect(await db.consumos.get([JEFE, conNovedadRechazada.id])).toBeDefined();
    expect(await db.novedades.get([JEFE, novedad.id])).toBeDefined();
  });
});

import { uuidv7 } from '@catmetal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aplicarEntidades } from './aplicar-cambios';
import {
  consumoLocal,
  consumosDeOrden,
  consumosEnConflicto,
  consumosPendientesDeSync,
  consumosRechazados,
  consumosSinNovedad,
  evidenciasDeNovedad,
  mutacionesConProblema,
  novedadesDeConsumo,
  ordenesAsignadasEnProceso,
  ordenesEnProceso,
  planeadoVsConsumido,
  registrosDelDia,
  toleranciaLocal,
  trazabilidadDelDispositivo,
} from './consultas';
import { db } from './db';
import {
  aplicarResultados,
  marcarEnviando,
  registrarConsumoConNovedadLocal,
  registrarConsumoLocal,
  siguienteLote,
} from './outbox';
import {
  consumoServidor,
  fotoDe,
  guardarPerfil,
  limpiarDb,
  resultado,
  validacionServidor,
} from './pruebas/fabricas';
import { nombreCorto, textoEvento } from './trazabilidad';

const A = uuidv7();
const B = uuidv7();
const ORDEN = uuidv7();
const ARENA = uuidv7();
const RESINA = uuidv7();
const COQUE = uuidv7();

function orden(id: string, codigo: string, estado = 'en_proceso') {
  return {
    entidad: 'production_orders',
    id,
    datos: {
      id,
      codigo,
      linea: 'Fundición',
      estado,
      creada_por: uuidv7(),
      created_at: '2026-10-29T12:00:00.000Z',
      updated_at: '2026-10-29T12:00:00.000Z',
    },
  };
}

beforeEach(async () => {
  await limpiarDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registrosDelDia', () => {
  it('usa el día calendario de Bogotá y, por defecto, solo los propios', async () => {
    const base = {
      order_id: ORDEN,
      material_id: ARENA,
      cantidad: 1,
      unidad: 'kg' as const,
      lote: 'L',
    };
    // 29/10 en Bogotá: de 05:00Z del 29 a 04:59:59Z del 30.
    const temprano = await registrarConsumoLocal(A, {
      ...base,
      client_created_at: '2026-10-29T05:00:00.000Z',
    });
    const tarde = await registrarConsumoLocal(A, {
      ...base,
      client_created_at: '2026-10-30T04:59:59.000Z',
    });
    await registrarConsumoLocal(A, { ...base, client_created_at: '2026-10-29T04:59:59.000Z' });
    await registrarConsumoLocal(B, { ...base, client_created_at: '2026-10-29T15:00:00.000Z' });
    const ajeno = consumoServidor({ client_created_at: '2026-10-29T16:00:00.000Z' });
    await aplicarEntidades(A, [{ entidad: 'consumptions', id: ajeno.id, datos: { ...ajeno } }]);

    const ahora = new Date('2026-10-29T23:00:00.000Z'); // 18:00 del 29 en Bogotá
    const propios = await registrosDelDia(A, ahora);
    expect(propios.map((c) => c.id)).toEqual([tarde.id, temprano.id]);
    const todos = await registrosDelDia(A, ahora, { soloPropios: false });
    expect(todos.map((c) => c.id)).toEqual([tarde.id, ajeno.id, temprano.id]);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ahora);
    expect(await registrosDelDia(A)).toHaveLength(2);
  });
});

describe('estados para la UI', () => {
  it('pendientes, rechazados, conflictos, sin novedad y problemas de sync', async () => {
    const base = {
      order_id: ORDEN,
      material_id: ARENA,
      cantidad: 1,
      unidad: 'kg' as const,
      lote: 'L',
    };
    const pendiente = await registrarConsumoLocal(A, base);
    const rechazadoSync = await registrarConsumoLocal(A, base);
    const conflicto = await registrarConsumoLocal(A, base);
    const lote = await marcarEnviando(A, (await siguienteLote(A)).slice(1));
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'rechazada', code: 'VALIDACION' }),
      resultado(lote, 1, { resultado: 'conflicto' }),
    ]);
    const rechazadoJefe = consumoServidor({ estado: 'rechazado', registrado_por: A });
    const validacion = validacionServidor({
      consumption_id: rechazadoJefe.id,
      decision: 'rechazado',
      motivo: 'Lote mal escrito',
    });
    const sinNovedad = consumoServidor({ requiere_novedad: true, registrado_por: A });
    await aplicarEntidades(A, [
      { entidad: 'consumptions', id: rechazadoJefe.id, datos: { ...rechazadoJefe } },
      { entidad: 'validations', id: validacion.id, datos: { ...validacion } },
      { entidad: 'consumptions', id: sinNovedad.id, datos: { ...sinNovedad } },
    ]);

    expect((await consumosPendientesDeSync(A)).map((c) => c.id)).toEqual([pendiente.id]);
    const rechazados = await consumosRechazados(A);
    expect(rechazados.map((c) => c.id).sort()).toEqual([rechazadoSync.id, rechazadoJefe.id].sort());
    expect(rechazados.find((c) => c.id === rechazadoJefe.id)?.motivo_rechazo).toBe(
      'Lote mal escrito',
    );
    expect((await consumosEnConflicto(A)).map((c) => c.id)).toEqual([conflicto.id]);
    expect((await consumosSinNovedad(A)).map((c) => c.id)).toEqual([sinNovedad.id]);
    expect((await mutacionesConProblema(A)).map((m) => m.estado)).toEqual([
      'rechazada',
      'conflicto',
    ]);
    expect(await mutacionesConProblema(B)).toEqual([]);
    expect(await consumoLocal(A, pendiente.id)).not.toBeNull();
    expect(await consumoLocal(B, pendiente.id)).toBeNull();
  });

  it('consumos de una orden, sus novedades y los metadatos de sus fotos (sin bytes)', async () => {
    const r = await registrarConsumoConNovedadLocal(
      A,
      { order_id: ORDEN, material_id: ARENA, cantidad: 2, unidad: 'kg', lote: 'L' },
      { tipo: 'dano', descripcion: 'Molde roto' },
      [fotoDe('abc'), fotoDe('def', 'image/png')],
    );
    await registrarConsumoLocal(A, {
      order_id: uuidv7(),
      material_id: ARENA,
      cantidad: 2,
      unidad: 'kg',
      lote: 'L',
    });
    expect((await consumosDeOrden(A, ORDEN)).map((c) => c.id)).toEqual([r.consumo_id]);
    const novedades = await novedadesDeConsumo(A, r.consumo_id);
    expect(novedades.map((n) => n.descripcion)).toEqual(['Molde roto']);
    const fotos = await evidenciasDeNovedad(A, r.novedad_id);
    expect(fotos).toHaveLength(2);
    expect(fotos.every((f) => !('datos' in f))).toBe(true);
    expect(fotos.map((f) => f.mime).sort()).toEqual(['image/jpeg', 'image/png']);
  });
});

describe('trazabilidad', () => {
  it('lista los eventos del dispositivo del usuario, más recientes primero', async () => {
    await guardarPerfil(A, 'Juan Sebastián Pérez');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T15:24:00.000Z'));
    const base = {
      order_id: ORDEN,
      material_id: ARENA,
      cantidad: 1,
      unidad: 'kg' as const,
      lote: 'L',
    };
    await registrarConsumoLocal(A, base);
    vi.setSystemTime(new Date('2026-10-29T15:30:00.000Z'));
    await registrarConsumoConNovedadLocal(A, base, { tipo: 'merma', descripcion: 'x' });
    await registrarConsumoLocal(B, base);

    const eventos = await trazabilidadDelDispositivo(A);
    expect(eventos.map((e) => e.descripcion)).toEqual([
      'registró consumo + novedad',
      'registró consumo',
    ]);
    expect(textoEvento(eventos[1]!)).toBe('10:24 a. m. · Juan S. registró consumo');
    expect(await trazabilidadDelDispositivo(A, 1)).toHaveLength(1);
  });

  it('nombreCorto', () => {
    expect(nombreCorto('  juan   sebastián ')).toBe('juan S.');
    expect(nombreCorto('Ana')).toBe('Ana');
    expect(nombreCorto('')).toBe('Usuario');
    expect(nombreCorto(null)).toBe('Usuario');
  });
});

describe('órdenes', () => {
  it('en proceso visibles y asignadas al usuario (sin revocadas)', async () => {
    const asignada = uuidv7();
    const noAsignada = uuidv7();
    const planeada = uuidv7();
    const revocada = uuidv7();
    await aplicarEntidades(A, [
      orden(asignada, 'OP-2026-0002'),
      orden(noAsignada, 'OP-2026-0001'),
      orden(planeada, 'OP-2026-0003', 'planeada'),
      orden(revocada, 'OP-2026-0004'),
      { entidad: 'order_supervisors', id: 's1', datos: { order_id: asignada, user_id: A } },
      { entidad: 'order_supervisors', id: 's2', datos: { order_id: noAsignada, user_id: B } },
      { entidad: 'order_supervisors', id: 's3', datos: { order_id: planeada, user_id: A } },
      {
        entidad: 'order_supervisors',
        id: 's4',
        datos: { order_id: noAsignada, user_id: A, activo: false },
      },
    ]);
    const fila = await db.ordenes.get([A, revocada]);
    await db.ordenes.put({ ...fila!, revocada: true });

    expect((await ordenesEnProceso(A)).map((o) => o.codigo)).toEqual([
      'OP-2026-0001',
      'OP-2026-0002',
    ]);
    expect((await ordenesAsignadasEnProceso(A)).map((o) => o.id)).toEqual([asignada]);
    expect(await ordenesEnProceso(B)).toEqual([]);
  });
});

describe('planeadoVsConsumido', () => {
  it('suma lo local no rechazado, convierte unidades y separa lo fuera de plan', async () => {
    await aplicarEntidades(A, [
      {
        entidad: 'settings',
        id: 'tolerancia_pct',
        datos: { clave: 'tolerancia_pct', valor: '10' },
      },
      {
        entidad: 'materials',
        id: ARENA,
        datos: {
          id: ARENA,
          codigo: 'MP-1',
          nombre: 'Arena sílice',
          unidad: 'kg',
          costo_unitario_cop: 1,
          activo: true,
        },
      },
      {
        entidad: 'materials',
        id: COQUE,
        datos: {
          id: COQUE,
          codigo: 'MP-3',
          nombre: 'Carbón coque',
          unidad: 'kg',
          costo_unitario_cop: 1,
          activo: true,
        },
      },
      {
        entidad: 'order_planned_materials',
        id: 'p1',
        datos: { order_id: ORDEN, material_id: ARENA, cantidad_planeada: 100, unidad: 'kg' },
      },
      {
        entidad: 'order_planned_materials',
        id: 'p2',
        datos: { order_id: ORDEN, material_id: RESINA, cantidad_planeada: 0, unidad: 'l' },
      },
    ]);
    const base = { order_id: ORDEN, lote: 'L' };
    await registrarConsumoLocal(A, { ...base, material_id: ARENA, cantidad: 100, unidad: 'kg' });
    await registrarConsumoLocal(A, { ...base, material_id: ARENA, cantidad: 10_500, unidad: 'g' });
    await registrarConsumoLocal(A, { ...base, material_id: ARENA, cantidad: 3, unidad: 'und' });
    await registrarConsumoLocal(A, { ...base, material_id: COQUE, cantidad: 500, unidad: 'g' });
    await registrarConsumoLocal(A, { ...base, material_id: COQUE, cantidad: 1, unidad: 'kg' });
    await registrarConsumoLocal(A, { ...base, material_id: COQUE, cantidad: 2, unidad: 'l' });
    const rechazado = consumoServidor({
      order_id: ORDEN,
      material_id: ARENA,
      cantidad: 999,
      estado: 'rechazado',
    });
    await aplicarEntidades(A, [
      { entidad: 'consumptions', id: rechazado.id, datos: { ...rechazado } },
    ]);

    const avance = await planeadoVsConsumido(A, ORDEN);
    expect(avance.tolerancia_pct).toBe(10);
    expect(avance.materiales).toEqual([
      {
        material_id: ARENA,
        codigo: 'MP-1',
        nombre: 'Arena sílice',
        unidad: 'kg',
        cantidad_planeada: 100,
        consumido: 110.5,
        porcentaje: 110.5,
        excede_tolerancia: true,
      },
      {
        material_id: RESINA,
        codigo: null,
        nombre: null,
        unidad: 'l',
        cantidad_planeada: 0,
        consumido: 0,
        porcentaje: 0,
        excede_tolerancia: false,
      },
    ]);
    expect(avance.fuera_de_plan).toEqual([
      { material_id: COQUE, codigo: 'MP-3', nombre: 'Carbón coque', unidad: 'kg', consumido: 1.5 },
    ]);
    expect(avance.incompatibles).toBe(2);
  });

  it('tolerancia por defecto 5 % y valores anidados', async () => {
    expect(await toleranciaLocal(A)).toBe(5);
    await aplicarEntidades(A, [
      { entidad: 'settings', id: 'tolerancia_pct', datos: { valor: { tolerancia_pct: 8 } } },
    ]);
    expect(await toleranciaLocal(A)).toBe(8);
    await aplicarEntidades(A, [
      { entidad: 'settings', id: 'tolerancia_pct', datos: { valor: { tolerancia_pct: 'x' } } },
    ]);
    expect(await toleranciaLocal(A)).toBe(5);
  });
});

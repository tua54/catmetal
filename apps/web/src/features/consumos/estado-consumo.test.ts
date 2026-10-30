import { describe, expect, it } from 'vitest';
import type { ConsumoLocal } from '../../datos';
import { consumoServidor } from '../../datos/pruebas/fabricas';
import { accionesDeConsumo, chipDeConsumo, explicacionEstado } from './estado-consumo';

const YO = 'yo';

function consumo(parcial: Partial<ConsumoLocal> = {}): ConsumoLocal {
  return {
    user_id: YO,
    id: 'c1',
    order_id: 'o1',
    material_id: 'm1',
    cantidad: 10,
    unidad: 'kg',
    lote: 'L',
    corrige_a: null,
    registrado_por: YO,
    client_created_at: '2026-10-29T15:00:00.000Z',
    dia_bogota: '2026-10-29',
    base_local: null,
    servidor: null,
    servidor_diferido: null,
    version: null,
    estado_local: 'pendiente_sync',
    ultimo_resultado: null,
    falta_novedad: false,
    requiere_novedad: false,
    registro_tardio: false,
    motivo_rechazo: null,
    error_sync: null,
    conflicto_servidor: null,
    actualizado_at: '2026-10-29T15:00:00.000Z',
    ...parcial,
  };
}

const enServidor = (estado: 'pendiente' | 'aprobado' | 'rechazado') =>
  consumoServidor({ estado, registrado_por: YO });

describe('chip por estado (§8)', () => {
  it.each([
    [consumo(), 'pendiente_sync'],
    [consumo({ estado_local: 'sincronizado', servidor: enServidor('pendiente') }), 'sincronizado'],
    [consumo({ estado_local: 'aprobado', servidor: enServidor('aprobado') }), 'validado'],
    [consumo({ estado_local: 'rechazado', servidor: enServidor('rechazado') }), 'rechazado'],
    [consumo({ estado_local: 'rechazado_sync' }), 'rechazado'],
    [consumo({ estado_local: 'conflicto', servidor: enServidor('pendiente') }), 'conflicto'],
    [
      consumo({
        estado_local: 'sincronizado',
        falta_novedad: true,
        servidor: enServidor('pendiente'),
      }),
      'falta_novedad',
    ],
  ] as const)('%#', (c, chip) => {
    expect(chipDeConsumo(c)).toBe(chip);
    expect(explicacionEstado(c).length).toBeGreaterThan(10);
  });
});

describe('consumo perdido en el servidor (ADR 0016)', () => {
  it('chip propio, explicación y la única acción es enviarlo de nuevo', () => {
    const perdido = consumo({
      estado_local: 'sincronizado',
      servidor: enServidor('pendiente'),
      perdido_en_restauracion: true,
      falta_novedad: true,
    });
    expect(chipDeConsumo(perdido)).toBe('perdido');
    expect(explicacionEstado(perdido)).toMatch(/ya no tiene este registro/);
    expect(accionesDeConsumo(perdido, YO)).toEqual({
      editar: false,
      corregir: false,
      registrarDeNuevo: false,
      justificar: false,
      reenviar: true,
    });
    expect(accionesDeConsumo({ ...perdido, registrado_por: 'otro' }, YO).reenviar).toBe(false);
  });
});

describe('acciones por estado', () => {
  it('S4: edita su consumo pendiente (local o ya en el servidor), no uno ajeno', () => {
    expect(accionesDeConsumo(consumo(), YO).editar).toBe(true);
    expect(
      accionesDeConsumo(
        consumo({ estado_local: 'sincronizado', servidor: enServidor('pendiente') }),
        YO,
      ).editar,
    ).toBe(true);
    expect(accionesDeConsumo(consumo({ registrado_por: 'otro' }), YO).editar).toBe(false);
  });

  it('S3: un rechazado por el jefe no se edita, se corrige', () => {
    const rechazado = consumo({ estado_local: 'rechazado', servidor: enServidor('rechazado') });
    expect(accionesDeConsumo(rechazado, YO)).toEqual({
      editar: false,
      corregir: true,
      registrarDeNuevo: false,
      justificar: false,
      reenviar: false,
    });
  });

  it('S10: un validado no se edita ni se corrige, aunque el servidor haya rechazado la edición', () => {
    const validado = consumo({ estado_local: 'rechazado_sync', servidor: enServidor('aprobado') });
    expect(accionesDeConsumo(validado, YO)).toEqual({
      editar: false,
      corregir: false,
      registrarDeNuevo: false,
      justificar: false,
      reenviar: false,
    });
  });

  it('creación rechazada por el servidor: registrar de nuevo', () => {
    const c = consumo({
      estado_local: 'rechazado_sync',
      error_sync: { code: 'MATERIAL_INACTIVO', message: '' },
    });
    expect(accionesDeConsumo(c, YO)).toMatchObject({ editar: false, registrarDeNuevo: true });
  });

  it('conflicto con el servidor aún pendiente: editar de nuevo', () => {
    const c = consumo({ estado_local: 'conflicto', servidor: enServidor('pendiente') });
    expect(accionesDeConsumo(c, YO).editar).toBe(true);
  });

  it('falta novedad: justificarla', () => {
    const c = consumo({
      estado_local: 'sincronizado',
      falta_novedad: true,
      servidor: enServidor('pendiente'),
    });
    expect(accionesDeConsumo(c, YO).justificar).toBe(true);
  });
});

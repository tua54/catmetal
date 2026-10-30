import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  aprobarSchema,
  asignarSupervisoresSchema,
  cantidadSchema,
  crearConsumoSchema,
  crearMaterialSchema,
  crearNovedadSchema,
  crearOrdenSchema,
  crearUsuarioSchema,
  detallesValidacion,
  editarConsumoSchema,
  editarMaterialSchema,
  editarUsuarioSchema,
  emailSchema,
  evidenciaMetaSchema,
  finalizarOrdenSchema,
  isoFechaSchema,
  leerMutationId,
  loginSchema,
  loteSchema,
  type Mutacion,
  mutacionSchema,
  passwordSchema,
  rechazarSchema,
  resultadoMutacionSchema,
  syncPullQuerySchema,
  syncPullResponseSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
  tieneCaracteresDeControl,
  TIPOS_CAMBIO_SYNC,
  toleranciaSchema,
  uuidV7Schema,
} from './esquemas';
import { uuidv7 } from './uuid';

const FECHA = '2026-10-29T20:55:00.000Z';
const SHA = 'a'.repeat(64);

function mensajes(schema: z.ZodType, valor: unknown): string[] {
  const resultado = schema.safeParse(valor);
  expect(resultado.success, `debía fallar: ${JSON.stringify(valor)}`).toBe(false);
  return resultado.success ? [] : resultado.error.issues.map((issue) => issue.message);
}

function valido(schema: z.ZodType, valor: unknown): void {
  const resultado = schema.safeParse(valor);
  expect(
    resultado.success,
    resultado.success ? '' : JSON.stringify(resultado.error.issues, null, 2),
  ).toBe(true);
}

function invalido(schema: z.ZodType, valor: unknown): void {
  expect(schema.safeParse(valor).success, `debía fallar: ${JSON.stringify(valor)}`).toBe(false);
}

function consumoValido() {
  return {
    id: uuidv7(),
    order_id: uuidv7(),
    material_id: uuidv7(),
    cantidad: 125.5,
    unidad: 'kg' as const,
    lote: 'L-2026-114',
    client_created_at: FECHA,
  };
}

function novedadValida() {
  return {
    id: uuidv7(),
    consumption_id: uuidv7(),
    tipo: 'merma' as const,
    descripcion: 'Se derramó parte de la arena al cargar la tolva.',
    client_created_at: FECHA,
    evidencias: [{ id: uuidv7(), mime: 'image/jpeg', tamano_bytes: 204_800, sha256: SHA }],
  };
}

describe('primitivos', () => {
  it('uuidV7Schema acepta v7 en minúsculas y rechaza lo demás', () => {
    valido(uuidV7Schema, uuidv7());
    invalido(uuidV7Schema, uuidv7().toUpperCase());
    invalido(uuidV7Schema, '01920d5e-8f3a-4b2c-9d4e-0123456789ab');
    invalido(uuidV7Schema, 42);
    expect(mensajes(uuidV7Schema, 'x')).toEqual(['El identificador no es un UUID v7 válido.']);
  });

  it('isoFechaSchema exige ISO-8601 UTC con Z', () => {
    valido(isoFechaSchema, FECHA);
    valido(isoFechaSchema, '2026-10-29T20:55:00Z');
    invalido(isoFechaSchema, '2026-10-29T20:55:00.000-05:00');
    invalido(isoFechaSchema, '2026-10-29 20:55:00');
    invalido(isoFechaSchema, '2026-02-30T00:00:00.000Z');
    invalido(isoFechaSchema, '2026-10-29');
    invalido(isoFechaSchema, 1_761_771_300_000);
  });

  it('isoFechaSchema normaliza a 24 caracteres con milisegundos', () => {
    expect(isoFechaSchema.parse('2026-10-29T20:55:00Z')).toBe('2026-10-29T20:55:00.000Z');
    expect(isoFechaSchema.parse('2026-10-29T20:55:00.5Z')).toBe('2026-10-29T20:55:00.500Z');
    expect(isoFechaSchema.parse('2026-10-29T20:55:00.123456Z')).toBe('2026-10-29T20:55:00.123Z');
    expect(isoFechaSchema.parse(FECHA)).toBe(FECHA);
    expect(isoFechaSchema.parse('2028-02-29T23:59:59.999Z')).toHaveLength(24);
    // Los esquemas que usan la fecha devuelven la versión normalizada.
    const consumo = crearConsumoSchema.parse({
      ...consumoValido(),
      client_created_at: '2026-10-29T20:55:00Z',
    });
    expect(consumo.client_created_at).toBe('2026-10-29T20:55:00.000Z');
    const fecha: string = isoFechaSchema.parse(FECHA);
    expect(typeof fecha).toBe('string');
  });

  it('isoFechaSchema rechaza fechas inexistentes en el calendario', () => {
    for (const fecha of [
      '2026-10-29T23:59:60Z',
      '2026-10-29T24:00:00Z',
      '2026-02-29T00:00:00Z',
      '1900-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
    ]) {
      expect(mensajes(isoFechaSchema, fecha), fecha).toEqual([
        'La fecha debe estar en formato ISO-8601 UTC (terminada en Z).',
      ]);
    }
    expect(isoFechaSchema.parse('2000-02-29T00:00:00Z')).toBe('2000-02-29T00:00:00.000Z');
  });

  it('cantidadSchema: > 0, máximo 3 decimales y ≤ 1e9', () => {
    valido(cantidadSchema, 0.001);
    valido(cantidadSchema, 125.5);
    valido(cantidadSchema, 1e9);
    valido(cantidadSchema, 999_999_999.999);
    expect(mensajes(cantidadSchema, 0)).toEqual(['La cantidad debe ser mayor que cero.']);
    invalido(cantidadSchema, -1);
    expect(mensajes(cantidadSchema, 1.2345)).toEqual(['La cantidad admite máximo 3 decimales.']);
    invalido(cantidadSchema, 0.1 + 0.2);
    invalido(cantidadSchema, 1e9 + 1);
    invalido(cantidadSchema, Number.NaN);
    invalido(cantidadSchema, Number.POSITIVE_INFINITY);
    invalido(cantidadSchema, '125');
  });

  it('loteSchema recorta espacios y exige 1–64 caracteres', () => {
    expect(loteSchema.parse('  L-1  ')).toBe('L-1');
    valido(loteSchema, 'x'.repeat(64));
    invalido(loteSchema, '   ');
    invalido(loteSchema, 'x'.repeat(65));
  });

  it('emailSchema recorta y pasa a minúsculas', () => {
    expect(emailSchema.parse('  Jefe.Planta@Catmetal.COM ')).toBe('jefe.planta@catmetal.com');
    invalido(emailSchema, 'no-es-correo');
    invalido(emailSchema, '');
    invalido(emailSchema, `${'a'.repeat(250)}@x.co`);
  });

  it('passwordSchema exige 10–128 caracteres', () => {
    valido(passwordSchema, 'a'.repeat(10));
    valido(passwordSchema, 'a'.repeat(128));
    expect(mensajes(passwordSchema, 'corta')).toEqual([
      'La contraseña debe tener al menos 10 caracteres.',
    ]);
    invalido(passwordSchema, 'a'.repeat(129));
  });
});

describe('auth', () => {
  it('loginSchema válido, con y sin nombre de dispositivo', () => {
    valido(loginSchema, { email: 'a@b.co', password: 'x', device_id: uuidv7() });
    const datos = loginSchema.parse({
      email: 'A@B.CO',
      password: 'secreta',
      device_id: uuidv7(),
      device_nombre: '  Tablet línea 2 ',
    });
    expect(datos.email).toBe('a@b.co');
    expect(datos.device_nombre).toBe('Tablet línea 2');
  });

  it('loginSchema acepta instalacion_id opcional (UUID v7)', () => {
    const instalacion_id = uuidv7();
    const datos = loginSchema.parse({
      email: 'a@b.co',
      password: 'x',
      device_id: uuidv7(),
      instalacion_id,
    });
    expect(datos.instalacion_id).toBe(instalacion_id);
    invalido(loginSchema, {
      email: 'a@b.co',
      password: 'x',
      device_id: uuidv7(),
      instalacion_id: 'navegador-1',
    });
  });

  it('loginSchema inválido', () => {
    invalido(loginSchema, { email: 'a@b.co', password: '', device_id: uuidv7() });
    invalido(loginSchema, { email: 'a@b.co', password: 'x', device_id: 'tablet-1' });
    invalido(loginSchema, { email: 'a@b.co', device_id: uuidv7() });
    invalido(loginSchema, { email: 'a@b.co', password: 'x'.repeat(129), device_id: uuidv7() });
  });
});

describe('administración', () => {
  it('crearUsuarioSchema', () => {
    valido(crearUsuarioSchema, {
      nombre: 'Ana Gómez',
      email: 'ana@catmetal.co',
      rol: 'supervisor',
      password: 'contraseña-larga',
    });
    invalido(crearUsuarioSchema, {
      nombre: 'Ana',
      email: 'ana@catmetal.co',
      rol: 'gerente',
      password: 'contraseña-larga',
    });
    invalido(crearUsuarioSchema, {
      nombre: '',
      email: 'ana@catmetal.co',
      rol: 'jefe',
      password: 'contraseña-larga',
    });
  });

  it('crearUsuarioSchema descarta claves desconocidas como password_hash', () => {
    const datos = crearUsuarioSchema.parse({
      nombre: 'Ana',
      email: 'ana@catmetal.co',
      rol: 'admin',
      password: 'contraseña-larga',
      password_hash: 'inyectado',
    });
    expect(datos).not.toHaveProperty('password_hash');
  });

  it('editarUsuarioSchema exige al menos un campo', () => {
    valido(editarUsuarioSchema, { activo: false });
    valido(editarUsuarioSchema, { rol: 'jefe', nombre: 'Luis' });
    valido(editarUsuarioSchema, { password: 'nueva-contraseña' });
    expect(mensajes(editarUsuarioSchema, {})).toEqual([
      'Indique al menos un campo para modificar.',
    ]);
    invalido(editarUsuarioSchema, { activo: 'no' });
    invalido(editarUsuarioSchema, { password: 'corta' });
    valido(editarUsuarioSchema, { desbloquear: true });
    expect(mensajes(editarUsuarioSchema, { desbloquear: false })).toEqual([
      'El campo desbloquear solo admite true.',
    ]);
  });

  it('crearMaterialSchema', () => {
    valido(crearMaterialSchema, {
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      costo_unitario_cop: 850,
    });
    invalido(crearMaterialSchema, {
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'ton',
      costo_unitario_cop: 850,
    });
    invalido(crearMaterialSchema, {
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      costo_unitario_cop: 850.5,
    });
    invalido(crearMaterialSchema, {
      codigo: 'MP-001',
      nombre: 'Arena sílice',
      unidad: 'kg',
      costo_unitario_cop: -1,
    });
  });

  it('editarMaterialSchema no permite cambiar unidad ni código', () => {
    valido(editarMaterialSchema, { costo_unitario_cop: 900 });
    valido(editarMaterialSchema, { activo: false, nombre: 'Arena sílice fina' });
    const datos = editarMaterialSchema.parse({ nombre: 'Nuevo', unidad: 'g', codigo: 'X' });
    expect(datos).toEqual({ nombre: 'Nuevo' });
    invalido(editarMaterialSchema, { unidad: 'g' });
    invalido(editarMaterialSchema, {});
  });

  it('toleranciaSchema: 0–100 con máximo 2 decimales', () => {
    valido(toleranciaSchema, { tolerancia_pct: 0 });
    valido(toleranciaSchema, { tolerancia_pct: 5 });
    valido(toleranciaSchema, { tolerancia_pct: 7.25 });
    valido(toleranciaSchema, { tolerancia_pct: 100 });
    invalido(toleranciaSchema, { tolerancia_pct: -0.5 });
    invalido(toleranciaSchema, { tolerancia_pct: 100.01 });
    invalido(toleranciaSchema, { tolerancia_pct: 5.125 });
    invalido(toleranciaSchema, { tolerancia_pct: '5' });
  });

  it('asignarSupervisoresSchema', () => {
    valido(asignarSupervisoresSchema, { supervisores: [] });
    valido(asignarSupervisoresSchema, { supervisores: [uuidv7(), uuidv7()] });
    const repetido = uuidv7();
    expect(mensajes(asignarSupervisoresSchema, { supervisores: [repetido, repetido] })).toEqual([
      'Hay supervisores repetidos.',
    ]);
    invalido(asignarSupervisoresSchema, { supervisores: ['x'] });
    invalido(asignarSupervisoresSchema, {});
  });
});

describe('órdenes', () => {
  function orden() {
    return {
      codigo: 'OP-2026-0587',
      linea: 'Moldeo 2',
      materiales: [
        { material_id: uuidv7(), cantidad_planeada: 1200, unidad: 'kg' },
        { material_id: uuidv7(), cantidad_planeada: 35.5, unidad: 'l' },
      ],
    };
  }

  it('crearOrdenSchema válido, con id opcional', () => {
    valido(crearOrdenSchema, orden());
    valido(crearOrdenSchema, { ...orden(), id: uuidv7() });
    expect(crearOrdenSchema.parse({ ...orden(), codigo: ' OP-2026-0001 ' }).codigo).toBe(
      'OP-2026-0001',
    );
  });

  it('crearOrdenSchema inválido', () => {
    expect(mensajes(crearOrdenSchema, { ...orden(), codigo: 'OP-26-587' })).toEqual([
      'El código de la orden debe tener el formato OP-AAAA-NNNN.',
    ]);
    invalido(crearOrdenSchema, { ...orden(), codigo: 'op-2026-0587' });
    invalido(crearOrdenSchema, { ...orden(), materiales: [] });
    invalido(crearOrdenSchema, { ...orden(), linea: '' });
    const repetido = uuidv7();
    invalido(crearOrdenSchema, {
      ...orden(),
      materiales: [
        { material_id: repetido, cantidad_planeada: 1, unidad: 'kg' },
        { material_id: repetido, cantidad_planeada: 2, unidad: 'kg' },
      ],
    });
    invalido(crearOrdenSchema, {
      ...orden(),
      materiales: [{ material_id: uuidv7(), cantidad_planeada: 0, unidad: 'kg' }],
    });
  });

  it('finalizarOrdenSchema', () => {
    valido(finalizarOrdenSchema, {});
    valido(finalizarOrdenSchema, { force: true });
    invalido(finalizarOrdenSchema, { force: 'si' });
  });
});

describe('consumos', () => {
  it('crearConsumoSchema válido, con y sin corrige_a', () => {
    valido(crearConsumoSchema, consumoValido());
    valido(crearConsumoSchema, { ...consumoValido(), corrige_a: null });
    valido(crearConsumoSchema, { ...consumoValido(), corrige_a: uuidv7() });
  });

  it('crearConsumoSchema inválido', () => {
    invalido(crearConsumoSchema, { ...consumoValido(), id: 'abc' });
    invalido(crearConsumoSchema, { ...consumoValido(), cantidad: 0 });
    invalido(crearConsumoSchema, { ...consumoValido(), cantidad: 1.0005 });
    invalido(crearConsumoSchema, { ...consumoValido(), unidad: 'lb' });
    invalido(crearConsumoSchema, { ...consumoValido(), lote: '' });
    invalido(crearConsumoSchema, { ...consumoValido(), client_created_at: '29/10/2026' });
    invalido(crearConsumoSchema, { ...consumoValido(), corrige_a: 'x' });
    const sinLote: Record<string, unknown> = consumoValido();
    delete sinLote.lote;
    invalido(crearConsumoSchema, sinLote);
  });

  it('crearConsumoSchema descarta campos que solo calcula el servidor', () => {
    const datos = crearConsumoSchema.parse({
      ...consumoValido(),
      estado: 'aprobado',
      costo_unitario_cop_snapshot: 1,
      requiere_novedad: false,
    });
    expect(datos).not.toHaveProperty('estado');
    expect(datos).not.toHaveProperty('costo_unitario_cop_snapshot');
    expect(datos).not.toHaveProperty('requiere_novedad');
  });

  it('editarConsumoSchema exige versión y al menos un campo editable', () => {
    valido(editarConsumoSchema, {
      id: uuidv7(),
      version: 1,
      cantidad: 10,
      client_created_at: FECHA,
    });
    valido(editarConsumoSchema, {
      id: uuidv7(),
      version: 3,
      material_id: uuidv7(),
      unidad: 'g',
      lote: 'L-9',
      client_created_at: FECHA,
    });
    expect(
      mensajes(editarConsumoSchema, { id: uuidv7(), version: 1, client_created_at: FECHA }),
    ).toEqual(['Indique al menos un campo para modificar.']);
    invalido(editarConsumoSchema, { id: uuidv7(), cantidad: 10, client_created_at: FECHA });
    invalido(editarConsumoSchema, {
      id: uuidv7(),
      version: 0,
      cantidad: 10,
      client_created_at: FECHA,
    });
    invalido(editarConsumoSchema, {
      id: uuidv7(),
      version: 1.5,
      cantidad: 10,
      client_created_at: FECHA,
    });
    invalido(editarConsumoSchema, { id: uuidv7(), version: 1, cantidad: 10 });
  });
});

describe('novedades y evidencias', () => {
  it('evidenciaMetaSchema', () => {
    valido(evidenciaMetaSchema, { id: uuidv7(), mime: 'image/webp', tamano_bytes: 1, sha256: SHA });
    valido(evidenciaMetaSchema, {
      id: uuidv7(),
      mime: 'image/png',
      tamano_bytes: 5 * 1024 * 1024,
      sha256: SHA,
    });
    invalido(evidenciaMetaSchema, {
      id: uuidv7(),
      mime: 'image/gif',
      tamano_bytes: 10,
      sha256: SHA,
    });
    expect(
      mensajes(evidenciaMetaSchema, {
        id: uuidv7(),
        mime: 'image/jpeg',
        tamano_bytes: 5 * 1024 * 1024 + 1,
        sha256: SHA,
      }),
    ).toEqual(['La foto es demasiado grande. El máximo es 5 MB.']);
    invalido(evidenciaMetaSchema, {
      id: uuidv7(),
      mime: 'image/jpeg',
      tamano_bytes: 0,
      sha256: SHA,
    });
    invalido(evidenciaMetaSchema, {
      id: uuidv7(),
      mime: 'image/jpeg',
      tamano_bytes: 10,
      sha256: 'A'.repeat(64),
    });
    invalido(evidenciaMetaSchema, {
      id: uuidv7(),
      mime: 'image/jpeg',
      tamano_bytes: 10,
      sha256: 'a'.repeat(63),
    });
  });

  it('crearNovedadSchema válido, con 0 a 5 evidencias', () => {
    valido(crearNovedadSchema, novedadValida());
    valido(crearNovedadSchema, { ...novedadValida(), evidencias: [] });
    const cinco = Array.from({ length: 5 }, () => ({
      id: uuidv7(),
      mime: 'image/jpeg',
      tamano_bytes: 100,
      sha256: SHA,
    }));
    valido(crearNovedadSchema, { ...novedadValida(), evidencias: cinco });
  });

  it('crearNovedadSchema inválido', () => {
    const seis = Array.from({ length: 6 }, () => ({
      id: uuidv7(),
      mime: 'image/jpeg',
      tamano_bytes: 100,
      sha256: SHA,
    }));
    expect(mensajes(crearNovedadSchema, { ...novedadValida(), evidencias: seis })).toEqual([
      'Máximo 5 fotos por novedad.',
    ]);
    invalido(crearNovedadSchema, { ...novedadValida(), tipo: 'robo' });
    invalido(crearNovedadSchema, { ...novedadValida(), descripcion: '   ' });
    invalido(crearNovedadSchema, { ...novedadValida(), descripcion: 'x'.repeat(2001) });
    const evidencia = { id: uuidv7(), mime: 'image/jpeg', tamano_bytes: 100, sha256: SHA };
    invalido(crearNovedadSchema, { ...novedadValida(), evidencias: [evidencia, evidencia] });
    const sinEvidencias: Record<string, unknown> = novedadValida();
    delete sinEvidencias.evidencias;
    invalido(crearNovedadSchema, sinEvidencias);
  });
});

describe('validación del jefe', () => {
  it('aprobarSchema', () => {
    valido(aprobarSchema, { id: uuidv7(), version: 1, client_created_at: FECHA });
    invalido(aprobarSchema, { id: uuidv7(), version: 1 });
    // La versión que vio el jefe es obligatoria (ADR 0010).
    expect(mensajes(aprobarSchema, { id: uuidv7(), client_created_at: FECHA })).toEqual([
      'La versión es obligatoria.',
    ]);
    invalido(aprobarSchema, { id: uuidv7(), version: 0, client_created_at: FECHA });
    invalido(aprobarSchema, { id: uuidv7(), version: 1.5, client_created_at: FECHA });
  });

  it('rechazarSchema exige motivo de 3 a 500 caracteres', () => {
    valido(rechazarSchema, {
      id: uuidv7(),
      version: 2,
      motivo: 'Lote no coincide con la remisión.',
      client_created_at: FECHA,
    });
    expect(
      mensajes(rechazarSchema, {
        id: uuidv7(),
        version: 1,
        motivo: ' no ',
        client_created_at: FECHA,
      }),
    ).toEqual(['El motivo del rechazo debe tener al menos 3 caracteres.']);
    invalido(rechazarSchema, { id: uuidv7(), version: 1, client_created_at: FECHA });
    invalido(rechazarSchema, {
      id: uuidv7(),
      version: 1,
      motivo: 'x'.repeat(501),
      client_created_at: FECHA,
    });
    invalido(rechazarSchema, { id: uuidv7(), motivo: 'Motivo válido', client_created_at: FECHA });
  });
});

describe('sincronización', () => {
  function mutaciones(): Mutacion[] {
    const consumo = consumoValido();
    return [
      {
        mutation_id: uuidv7(),
        client_created_at: FECHA,
        tipo: 'consumo.crear',
        payload: consumoValido(),
      },
      {
        mutation_id: uuidv7(),
        client_created_at: FECHA,
        tipo: 'consumo.editar',
        payload: { id: consumo.id, version: 1, cantidad: 130, client_created_at: FECHA },
      },
      {
        mutation_id: uuidv7(),
        client_created_at: FECHA,
        tipo: 'novedad.crear',
        payload: crearNovedadSchema.parse(novedadValida()),
      },
      {
        mutation_id: uuidv7(),
        client_created_at: FECHA,
        tipo: 'consumo.aprobar',
        payload: { id: uuidv7(), consumption_id: consumo.id, version: 1, client_created_at: FECHA },
      },
      {
        mutation_id: uuidv7(),
        client_created_at: FECHA,
        tipo: 'consumo.rechazar',
        payload: {
          id: uuidv7(),
          consumption_id: consumo.id,
          version: 1,
          motivo: 'Cantidad no corresponde.',
          client_created_at: FECHA,
        },
      },
    ];
  }

  it('mutacionSchema acepta cada tipo de mutación', () => {
    const lista = mutaciones();
    expect(lista.map((m) => m.tipo)).toEqual([
      'consumo.crear',
      'consumo.editar',
      'novedad.crear',
      'consumo.aprobar',
      'consumo.rechazar',
    ]);
    for (const mutacion of lista) {
      valido(mutacionSchema, mutacion);
    }
  });

  it('mutacionSchema valida el payload según el tipo', () => {
    const [crear, , , aprobar, rechazar] = mutaciones();
    // Un payload de consumo con el tipo de novedad no es válido.
    invalido(mutacionSchema, { ...crear, tipo: 'novedad.crear' });
    invalido(mutacionSchema, { ...crear, tipo: 'consumo.borrar' });
    invalido(mutacionSchema, { ...crear, mutation_id: 'x' });
    invalido(mutacionSchema, { ...crear, client_created_at: 'ayer' });
    // aprobar y rechazar exigen consumption_id.
    if (aprobar?.tipo === 'consumo.aprobar') {
      const sinConsumo: Record<string, unknown> = { ...aprobar.payload };
      delete sinConsumo.consumption_id;
      invalido(mutacionSchema, { ...aprobar, payload: sinConsumo });
      // También exigen la versión del consumo que vio el jefe (ADR 0010).
      const sinVersion: Record<string, unknown> = { ...aprobar.payload };
      delete sinVersion.version;
      invalido(mutacionSchema, { ...aprobar, payload: sinVersion });
    }
    if (rechazar?.tipo === 'consumo.rechazar') {
      invalido(mutacionSchema, { ...rechazar, payload: { ...rechazar.payload, motivo: '' } });
      invalido(mutacionSchema, { ...rechazar, payload: { ...rechazar.payload, version: 0 } });
    }
    invalido(mutacionSchema, { tipo: 'consumo.crear' });
  });

  it('syncPushRequestSchema: sobre laxo con user_id y entre 1 y 25 mutaciones', () => {
    const user_id = uuidv7();
    valido(syncPushRequestSchema, { user_id, mutaciones: mutaciones() });
    // El sobre no valida cada mutación: una inválida no atasca el lote (ADR 0009).
    const datos = syncPushRequestSchema.parse({
      user_id,
      mutaciones: [{ tipo: 'consumo.borrar' }, 'basura', null, 42, mutaciones()[0]],
    });
    expect(datos.mutaciones).toHaveLength(5);
    const veinticinco = Array.from({ length: 25 }, () => ({}));
    valido(syncPushRequestSchema, { user_id, mutaciones: veinticinco });
    expect(mensajes(syncPushRequestSchema, { user_id, mutaciones: [...veinticinco, {}] })).toEqual([
      'Máximo 25 mutaciones por envío.',
    ]);
    invalido(syncPushRequestSchema, { user_id, mutaciones: [] });
    invalido(syncPushRequestSchema, { user_id: 'yo', mutaciones: mutaciones() });
    invalido(syncPushRequestSchema, { mutaciones: mutaciones() });
    invalido(syncPushRequestSchema, { user_id, mutaciones: 'no es lista' });
  });

  it('syncPushRequestSchema descarta device_id del sobre (se usa el did de la sesión)', () => {
    const datos = syncPushRequestSchema.parse({
      user_id: uuidv7(),
      device_id: uuidv7(),
      mutaciones: [{}],
    });
    expect(datos).not.toHaveProperty('device_id');
  });

  it('cada mutación del sobre se valida aparte con mutacionSchema.safeParse', () => {
    const { mutaciones: lista } = syncPushRequestSchema.parse({
      user_id: uuidv7(),
      mutaciones: [mutaciones()[0], { mutation_id: uuidv7(), tipo: 'consumo.crear' }],
    });
    expect(lista.map((m) => mutacionSchema.safeParse(m).success)).toEqual([true, false]);
  });

  it('leerMutationId extrae un mutation_id válido aunque el resto sea inválido', () => {
    const id = uuidv7();
    expect(leerMutationId({ mutation_id: id, tipo: 'inventado', payload: 5 })).toBe(id);
    expect(leerMutationId({ mutation_id: id.toUpperCase() })).toBeNull();
    expect(leerMutationId({ mutation_id: 'abc' })).toBeNull();
    expect(leerMutationId({ mutation_id: 123 })).toBeNull();
    expect(leerMutationId({})).toBeNull();
    expect(leerMutationId(Object.create({ mutation_id: id }))).toBeNull();
    expect(leerMutationId([id])).toBeNull();
    expect(leerMutationId(null)).toBeNull();
    expect(leerMutationId(undefined)).toBeNull();
    expect(leerMutationId(id)).toBeNull();
  });

  it('resultadoMutacionSchema exige indice y admite mutation_id ausente', () => {
    const aplicada = { indice: 0, mutation_id: uuidv7(), resultado: 'aplicada' };
    const rechazada = {
      indice: 1,
      mutation_id: uuidv7(),
      resultado: 'rechazada',
      code: 'DEPENDENCIA_RECHAZADA',
      message: 'No se aplicó.',
    };
    const conflicto = {
      indice: 2,
      mutation_id: uuidv7(),
      resultado: 'conflicto',
      code: 'CONFLICTO',
      servidor: { version: 2, cantidad: 10 },
    };
    // mutation_id ilegible: el resultado se identifica solo por su posición.
    const sinId = { indice: 3, resultado: 'rechazada', code: 'VALIDACION' };
    valido(syncPushResponseSchema, { resultados: [aplicada, rechazada, conflicto, sinId] });
    invalido(resultadoMutacionSchema, { mutation_id: uuidv7(), resultado: 'aplicada' });
    invalido(resultadoMutacionSchema, { ...aplicada, indice: -1 });
    invalido(resultadoMutacionSchema, { ...aplicada, indice: 1.5 });
    invalido(resultadoMutacionSchema, { ...aplicada, resultado: 'ok' });
    invalido(resultadoMutacionSchema, { ...rechazada, code: 'INVENTADO' });
    invalido(resultadoMutacionSchema, { ...aplicada, mutation_id: 'x' });
  });

  it('syncPullQuerySchema convierte el cursor y usa 0 por defecto', () => {
    expect(syncPullQuerySchema.parse({ cursor: '1234' })).toEqual({ cursor: 1234 });
    expect(syncPullQuerySchema.parse({ cursor: '0' })).toEqual({ cursor: 0 });
    expect(syncPullQuerySchema.parse({})).toEqual({ cursor: 0 });
    for (const cursor of ['-1', '1.5', 'abc', '', '007', '1e3', '99999999999999999']) {
      invalido(syncPullQuerySchema, { cursor });
    }
  });

  it('syncPullResponseSchema con época y los cuatro tipos de cambio', () => {
    expect(TIPOS_CAMBIO_SYNC).toEqual(['upsert', 'revocar', 'hidratar', 'reiniciar']);
    const epoca = crypto.randomUUID();
    valido(syncPullResponseSchema, {
      epoca,
      cursor: 1500,
      hay_mas: false,
      cambios: [
        {
          seq: 1497,
          tipo: 'upsert',
          entidad: 'validations',
          id: uuidv7(),
          datos: { decision: 'aprobado' },
        },
        { seq: 1498, tipo: 'revocar', entidad: 'production_orders', id: uuidv7(), datos: null },
        { seq: 1499, tipo: 'hidratar', entidad: 'production_orders', id: uuidv7(), datos: null },
        { seq: 1500, tipo: 'reiniciar', entidad: 'users', id: uuidv7(), datos: null },
      ],
    });
    // Una entidad desconocida no rompe el contrato (compatibilidad hacia adelante).
    valido(syncPullResponseSchema, {
      epoca,
      cursor: 1,
      hay_mas: false,
      cambios: [{ seq: 1, tipo: 'upsert', entidad: 'tabla_futura', id: 'x', datos: {} }],
    });
    invalido(syncPullResponseSchema, {
      epoca,
      cursor: 1,
      hay_mas: false,
      cambios: [{ seq: 1, tipo: 'borrar', entidad: 'x', id: 'y', datos: null }],
    });
    invalido(syncPullResponseSchema, { epoca, cursor: -1, hay_mas: false, cambios: [] });
    invalido(syncPullResponseSchema, { cursor: 1, hay_mas: false, cambios: [] });
    invalido(syncPullResponseSchema, { epoca: '', cursor: 1, hay_mas: false, cambios: [] });
  });
});

describe('mensajes y detalles de validación', () => {
  it('los mensajes genéricos de Zod salen en español', () => {
    const resultado = loginSchema.safeParse({ email: 'a@b.co', password: 5, device_id: uuidv7() });
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.issues[0]?.message).toBe('La contraseña es obligatoria.');
    }
    const generico = aprobarSchema.safeParse('no es objeto');
    expect(generico.success).toBe(false);
    if (!generico.success) {
      expect(generico.error.issues[0]?.message).toMatch(/Entrada inválida/);
    }
  });

  it('detallesValidacion devuelve campo y mensaje, sin los valores recibidos', () => {
    const resultado = crearOrdenSchema.safeParse({
      codigo: 'mal',
      linea: 'Moldeo',
      materiales: [{ material_id: uuidv7(), cantidad_planeada: -5, unidad: 'kg' }],
    });
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      const detalles = detallesValidacion(resultado.error);
      expect(detalles).toEqual([
        { campo: 'codigo', mensaje: 'El código de la orden debe tener el formato OP-AAAA-NNNN.' },
        {
          campo: 'materiales.0.cantidad_planeada',
          mensaje: 'La cantidad debe ser mayor que cero.',
        },
      ]);
      expect(JSON.stringify(detalles)).not.toContain('-5');
    }
    const objeto = editarUsuarioSchema.safeParse({});
    if (!objeto.success) {
      expect(detallesValidacion(objeto.error)).toEqual([
        { campo: '', mensaje: 'Indique al menos un campo para modificar.' },
      ]);
    }
  });

  it('detallesValidacion acepta cualquier objeto con issues ($ZodError de zod core)', () => {
    const errorCore = {
      issues: [
        { code: 'too_small', path: ['payload', 0, 'cantidad'], message: 'Muy pequeño.' },
        { code: 'custom', path: [Symbol.for('raro')], message: 'Raro.' },
        { path: [], message: 'Sin código.' },
      ],
    } as const;
    expect(detallesValidacion(errorCore)).toEqual([
      { campo: 'payload.0.cantidad', mensaje: 'Muy pequeño.' },
      { campo: 'Symbol(raro)', mensaje: 'Raro.' },
      { campo: '', mensaje: 'Sin código.' },
    ]);
    expect(detallesValidacion({ issues: [] })).toEqual([]);
  });
});

describe('caracteres de control en textos libres', () => {
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(0x1b);
  const DEL = String.fromCharCode(0x7f);
  const CR = String.fromCharCode(0x0d);
  const VT = String.fromCharCode(0x0b);
  const US = String.fromCharCode(0x1f);

  it('tieneCaracteresDeControl detecta C0 y DEL; en multilínea permite salto de línea y tabulador', () => {
    for (const control of [NUL, ESC, DEL, CR, VT, US, '\n', '\t']) {
      expect(tieneCaracteresDeControl(`a${control}b`), JSON.stringify(control)).toBe(true);
    }
    for (const control of [NUL, ESC, DEL, CR, VT, US]) {
      expect(tieneCaracteresDeControl(`a${control}b`, true), JSON.stringify(control)).toBe(true);
    }
    expect(tieneCaracteresDeControl('línea 1\nlínea 2\tcon tab', true)).toBe(false);
    expect(tieneCaracteresDeControl('Ñandú — 5 % · “ok” é ü')).toBe(false);
    expect(tieneCaracteresDeControl('')).toBe(false);
  });

  it('los textos de una línea rechazan caracteres de control (material, usuario, orden, lote)', () => {
    const material = { codigo: 'MP-1', nombre: 'Arena', unidad: 'kg', costo_unitario_cop: 1 };
    valido(crearMaterialSchema, material);
    for (const control of [NUL, ESC, DEL, '\n', '\t']) {
      invalido(crearMaterialSchema, { ...material, nombre: `Are${control}na` });
      invalido(crearMaterialSchema, { ...material, codigo: `MP${control}1` });
      invalido(editarMaterialSchema, { nombre: `Are${control}na` });
      invalido(editarUsuarioSchema, { nombre: `Ana${control}Gómez` });
      invalido(loteSchema, `L-${control}1`);
      invalido(crearConsumoSchema, { ...consumoValido(), lote: `L${control}9` });
    }
    const resultado = editarMaterialSchema.safeParse({ nombre: `Are${ESC}na` });
    expect(resultado.success).toBe(false);
    expect(resultado.error?.issues.map((i) => i.message)).toEqual([
      'El nombre tiene caracteres no permitidos.',
    ]);
  });

  it('el recorte de espacios sigue funcionando: un salto de línea al borde se elimina', () => {
    expect(loteSchema.parse('\n L-1 \t')).toBe('L-1');
    expect(editarMaterialSchema.parse({ nombre: ' Arena\n' })).toEqual({ nombre: 'Arena' });
  });

  it('descripción de novedad y motivo de rechazo admiten saltos de línea y tabuladores, nada más', () => {
    valido(crearNovedadSchema, { ...novedadValida(), descripcion: 'Merma:\n\t- 2 kg' });
    for (const control of [NUL, ESC, DEL, CR, VT]) {
      invalido(crearNovedadSchema, { ...novedadValida(), descripcion: `Mer${control}ma` });
    }
    const rechazo = { id: uuidv7(), version: 1, client_created_at: FECHA };
    valido(rechazarSchema, { ...rechazo, motivo: 'Lote no\ncoincide' });
    invalido(rechazarSchema, { ...rechazo, motivo: `Lote${NUL} no coincide` });
    const resultado = rechazarSchema.safeParse({ ...rechazo, motivo: `Lote${DEL} no coincide` });
    expect(resultado.error?.issues.map((i) => i.message)).toEqual([
      'El motivo del rechazo tiene caracteres no permitidos (solo se admiten saltos de línea y tabuladores).',
    ]);
  });

  it('la línea de una orden rechaza caracteres de control', () => {
    const orden = {
      codigo: 'OP-2026-0001',
      linea: 'Línea 1',
      materiales: [{ material_id: uuidv7(), cantidad_planeada: 1, unidad: 'kg' }],
    };
    valido(crearOrdenSchema, orden);
    invalido(crearOrdenSchema, { ...orden, linea: `Línea${NUL}1` });
  });
});

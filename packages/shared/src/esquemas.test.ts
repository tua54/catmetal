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
    valido(aprobarSchema, { id: uuidv7(), client_created_at: FECHA });
    invalido(aprobarSchema, { id: uuidv7() });
  });

  it('rechazarSchema exige motivo de 3 a 500 caracteres', () => {
    valido(rechazarSchema, {
      id: uuidv7(),
      motivo: 'Lote no coincide con la remisión.',
      client_created_at: FECHA,
    });
    expect(
      mensajes(rechazarSchema, { id: uuidv7(), motivo: ' no ', client_created_at: FECHA }),
    ).toEqual(['El motivo del rechazo debe tener al menos 3 caracteres.']);
    invalido(rechazarSchema, { id: uuidv7(), client_created_at: FECHA });
    invalido(rechazarSchema, { id: uuidv7(), motivo: 'x'.repeat(501), client_created_at: FECHA });
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
        payload: { id: uuidv7(), consumption_id: consumo.id, client_created_at: FECHA },
      },
      {
        mutation_id: uuidv7(),
        client_created_at: FECHA,
        tipo: 'consumo.rechazar',
        payload: {
          id: uuidv7(),
          consumption_id: consumo.id,
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
    }
    if (rechazar?.tipo === 'consumo.rechazar') {
      invalido(mutacionSchema, { ...rechazar, payload: { ...rechazar.payload, motivo: '' } });
    }
    invalido(mutacionSchema, { tipo: 'consumo.crear' });
  });

  it('syncPushRequestSchema: entre 1 y 25 mutaciones', () => {
    const device_id = uuidv7();
    valido(syncPushRequestSchema, { device_id, mutaciones: mutaciones() });
    const veinticinco = Array.from({ length: 25 }, () => mutaciones()[0]);
    valido(syncPushRequestSchema, { device_id, mutaciones: veinticinco });
    expect(
      mensajes(syncPushRequestSchema, { device_id, mutaciones: [...veinticinco, mutaciones()[0]] }),
    ).toEqual(['Máximo 25 mutaciones por envío.']);
    invalido(syncPushRequestSchema, { device_id, mutaciones: [] });
    invalido(syncPushRequestSchema, { device_id: 'tablet', mutaciones: mutaciones() });
  });

  it('resultadoMutacionSchema y syncPushResponseSchema', () => {
    const aplicada = { mutation_id: uuidv7(), resultado: 'aplicada' };
    const rechazada = {
      mutation_id: uuidv7(),
      resultado: 'rechazada',
      code: 'DEPENDENCIA_RECHAZADA',
      message: 'No se aplicó.',
    };
    const conflicto = {
      mutation_id: uuidv7(),
      resultado: 'conflicto',
      code: 'CONFLICTO',
      servidor: { version: 2, cantidad: 10 },
    };
    valido(syncPushResponseSchema, { resultados: [aplicada, rechazada, conflicto] });
    invalido(resultadoMutacionSchema, { ...aplicada, resultado: 'ok' });
    invalido(resultadoMutacionSchema, { ...rechazada, code: 'INVENTADO' });
  });

  it('syncPullQuerySchema convierte el cursor y usa 0 por defecto', () => {
    expect(syncPullQuerySchema.parse({ cursor: '1234' })).toEqual({ cursor: 1234 });
    expect(syncPullQuerySchema.parse({ cursor: '0' })).toEqual({ cursor: 0 });
    expect(syncPullQuerySchema.parse({})).toEqual({ cursor: 0 });
    for (const cursor of ['-1', '1.5', 'abc', '', '007', '1e3', '99999999999999999']) {
      invalido(syncPullQuerySchema, { cursor });
    }
  });

  it('syncPullResponseSchema', () => {
    valido(syncPullResponseSchema, {
      cursor: 1500,
      hay_mas: false,
      cambios: [
        {
          seq: 1499,
          tipo: 'upsert',
          entidad: 'validations',
          id: uuidv7(),
          datos: { decision: 'aprobado' },
        },
        { seq: 1500, tipo: 'revocar', entidad: 'production_orders', id: uuidv7(), datos: null },
      ],
    });
    invalido(syncPullResponseSchema, {
      cursor: 1,
      hay_mas: false,
      cambios: [{ seq: 1, tipo: 'borrar', entidad: 'x', id: 'y', datos: null }],
    });
    invalido(syncPullResponseSchema, { cursor: -1, hay_mas: false, cambios: [] });
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
});

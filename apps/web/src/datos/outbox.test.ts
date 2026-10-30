import { MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { ErrorDatosLocales } from './errores';
import {
  RETRASO_MAXIMO_MS,
  aMutacion,
  aplicarResultados,
  aprobarLocal,
  borrarDatosDeUsuario,
  calcularRetrasoMs,
  contarEvidenciasPendientes,
  contarPendientes,
  editarConsumoLocal,
  ErrorValidacionLocal,
  evidenciasListasParaSubir,
  marcarEnviando,
  marcarEvidenciaSubida,
  pendientesPorUsuario,
  programarReintento,
  programarReintentoEvidencia,
  puedeBorrarDatosDeUsuario,
  purgarAplicadasAntiguas,
  rechazarLocal,
  recuperarEnviando,
  registrarConsumoConNovedadLocal,
  registrarConsumoLocal,
  registrarNovedadLocal,
  sha256Hex,
  siguienteLote,
  type EntradaConsumoLocal,
} from './outbox';
import { aplicarEntidades } from './aplicar-cambios';
import {
  consumoServidor,
  fotoDe,
  guardarPerfil,
  limpiarDb,
  novedadServidor,
  resultado,
  validacionServidor,
} from './pruebas/fabricas';
import type { MutacionOutbox } from './tipos';

const A = uuidv7();
const B = uuidv7();
const ORDEN = uuidv7();
const MATERIAL = uuidv7();

function entradaConsumo(base: Partial<EntradaConsumoLocal> = {}): EntradaConsumoLocal {
  return {
    order_id: ORDEN,
    material_id: MATERIAL,
    cantidad: 12.5,
    unidad: 'kg',
    lote: 'L-77',
    ...base,
  };
}

/** Toma el siguiente lote del usuario y lo marca como enviando (lo que hará el motor). */
async function enviar(userId: string, ahora = new Date()): Promise<MutacionOutbox[]> {
  const lote = await siguienteLote(userId, 25, ahora);
  return marcarEnviando(userId, lote, ahora);
}

async function mutacion(id: string): Promise<MutacionOutbox> {
  const m = await db.outbox.get(id);
  if (m === undefined) {
    throw new Error('mutación inexistente');
  }
  return m;
}

beforeEach(async () => {
  await limpiarDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('registrarConsumoLocal', () => {
  it('escribe el consumo, su mutación y la trazabilidad en la misma transacción', async () => {
    await guardarPerfil(A, 'Juan Sebastián Pérez');
    const { id, mutation_id } = await registrarConsumoLocal(A, entradaConsumo());

    const consumo = await db.consumos.get([A, id]);
    expect(consumo).toMatchObject({
      user_id: A,
      registrado_por: A,
      cantidad: 12.5,
      estado_local: 'pendiente_sync',
      servidor: null,
      version: null,
    });
    const m = await mutacion(mutation_id);
    expect(m).toMatchObject({
      user_id: A,
      tipo: 'consumo.crear',
      estado: 'pendiente',
      entidad_id: id,
      consumo_id: id,
      intentos: 0,
      seq_local: 1,
    });
    expect(aMutacion(m)).toEqual({
      mutation_id,
      tipo: 'consumo.crear',
      client_created_at: m.client_created_at,
      payload: m.payload,
    });
    const eventos = await db.trazabilidad.toArray();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      actor_nombre: 'Juan S.',
      descripcion: 'registró consumo',
      entidad_id: id,
      order_id: ORDEN,
    });
  });

  it('si falla la escritura de la mutación, no queda el consumo', async () => {
    vi.spyOn(db.outbox, 'add').mockImplementation(() => {
      throw new Error('disco lleno');
    });
    await expect(registrarConsumoLocal(A, entradaConsumo())).rejects.toThrow('disco lleno');
    expect(await db.consumos.count()).toBe(0);
    expect(await db.trazabilidad.count()).toBe(0);
  });

  it('si falla la escritura del consumo, no queda la mutación', async () => {
    const id = uuidv7();
    await registrarConsumoLocal(A, entradaConsumo({ id }));
    // Mismo id en la misma partición: ConstraintError en `consumos.add`.
    await expect(registrarConsumoLocal(A, entradaConsumo({ id }))).rejects.toThrow();
    expect(await db.outbox.count()).toBe(1);
    expect(await db.trazabilidad.count()).toBe(1);
  });

  it('valida la entrada con el contrato y no escribe nada si es inválida', async () => {
    const error = await registrarConsumoLocal(A, entradaConsumo({ cantidad: -1 })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ErrorValidacionLocal);
    expect((error as ErrorValidacionLocal).code).toBe('VALIDACION');
    expect((error as ErrorValidacionLocal).detalles[0]?.campo).toBe('payload.cantidad');
    expect(await db.outbox.count()).toBe(0);
    expect(await db.consumos.count()).toBe(0);
  });

  it('usa "Usuario" en la trazabilidad si no hay perfil cacheado', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    expect((await db.trazabilidad.toArray())[0]?.actor_nombre).toBe('Usuario');
  });
});

describe('partición por usuario (tablet compartida)', () => {
  it('siguienteLote(A) nunca devuelve mutaciones de B', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    await registrarConsumoLocal(B, entradaConsumo());
    await registrarConsumoLocal(A, entradaConsumo());
    await registrarConsumoLocal(B, entradaConsumo());

    const loteA = await siguienteLote(A);
    expect(loteA).toHaveLength(2);
    expect(loteA.every((m) => m.user_id === A)).toBe(true);
    const loteB = await siguienteLote(B);
    expect(loteB.every((m) => m.user_id === B)).toBe(true);
    expect(await contarPendientes(A)).toBe(2);
    expect(await contarPendientes(B)).toBe(2);
  });

  it('marcarEnviando y aplicarResultados rechazan mutaciones de otro usuario sin modificar nada', async () => {
    await registrarConsumoLocal(B, entradaConsumo());
    const loteB = await siguienteLote(B);
    await expect(marcarEnviando(A, loteB)).rejects.toMatchObject({ code: 'AUTOR_NO_COINCIDE' });
    expect((await mutacion(loteB[0]!.mutation_id)).estado).toBe('pendiente');

    const enviadas = await marcarEnviando(B, loteB);
    await expect(
      aplicarResultados(A, enviadas, [resultado(enviadas, 0, { resultado: 'aplicada' })]),
    ).rejects.toMatchObject({ code: 'AUTOR_NO_COINCIDE' });
    expect((await mutacion(loteB[0]!.mutation_id)).estado).toBe('enviando');
  });

  it('la misma entidad vista por dos usuarios son dos filas independientes', async () => {
    const s = consumoServidor();
    await aplicarEntidades(A, [{ entidad: 'consumptions', id: s.id, datos: { ...s } }]);
    await aplicarEntidades(B, [{ entidad: 'consumptions', id: s.id, datos: { ...s } }]);
    expect(await db.consumos.count()).toBe(2);
    await db.consumos.delete([A, s.id]);
    expect(await db.consumos.get([B, s.id])).toBeDefined();
  });

  it('pendientesPorUsuario agrupa por autor con el nombre del perfil', async () => {
    await guardarPerfil(A, 'Ana Gómez');
    await registrarConsumoLocal(A, entradaConsumo());
    const { id } = await registrarConsumoLocal(B, entradaConsumo());
    await registrarNovedadLocal(B, { consumption_id: id, tipo: 'merma', descripcion: 'x' }, [
      fotoDe('abc'),
    ]);
    const pendientes = await pendientesPorUsuario();
    expect(pendientes).toHaveLength(2);
    expect(pendientes.find((p) => p.user_id === A)).toEqual({
      user_id: A,
      nombre: 'Ana Gómez',
      mutaciones: 1,
      evidencias: 0,
    });
    expect(pendientes.find((p) => p.user_id === B)).toEqual({
      user_id: B,
      nombre: null,
      mutaciones: 2,
      evidencias: 1,
    });
  });
});

describe('orden de envío', () => {
  it('es estable aunque las mutaciones compartan client_created_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T15:24:00.000Z'));
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await registrarConsumoLocal(A, entradaConsumo({ lote: `L-${i}` }))).id);
    }
    const lote = await siguienteLote(A);
    expect(new Set(lote.map((m) => m.client_created_at)).size).toBe(1);
    expect(lote.map((m) => m.entidad_id)).toEqual(ids);
    const seqs = lote.map((m) => m.seq_local);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(5);
  });

  it('limita el lote a 25 (y al máximo pedido)', async () => {
    for (let i = 0; i < 27; i += 1) {
      await registrarConsumoLocal(A, entradaConsumo());
    }
    expect(await siguienteLote(A)).toHaveLength(25);
    expect(await siguienteLote(A, 100)).toHaveLength(25);
    expect(await siguienteLote(A, 2)).toHaveLength(2);
    expect(await siguienteLote(A, 0)).toHaveLength(1);
  });

  it('salta las que esperan backoff y las posteriores del mismo consumo, no las independientes', async () => {
    const ahora = new Date('2026-10-29T15:00:00.000Z');
    const uno = await registrarConsumoLocal(A, entradaConsumo());
    const dos = await registrarConsumoLocal(A, entradaConsumo());
    const edicionUno = await editarConsumoLocal(A, { id: uno.id, cantidad: 3 });
    const m = await mutacion(uno.mutation_id);
    await db.outbox.put({ ...m, siguiente_intento_at: '2026-10-29T15:01:00.000Z' });

    const lote = await siguienteLote(A, 25, ahora);
    expect(lote.map((x) => x.mutation_id)).toEqual([dos.mutation_id]);

    const despues = await siguienteLote(A, 25, new Date('2026-10-29T15:01:00.000Z'));
    expect(despues.map((x) => x.mutation_id)).toEqual([
      uno.mutation_id,
      dos.mutation_id,
      edicionUno.mutation_id,
    ]);
  });

  it('no envía las mutaciones de un consumo que tiene otra en vuelo (enviando)', async () => {
    const uno = await registrarConsumoLocal(A, entradaConsumo());
    await marcarEnviando(A, await siguienteLote(A));
    await registrarNovedadLocal(A, { consumption_id: uno.id, tipo: 'otro', descripcion: 'x' });
    const otro = await registrarConsumoLocal(A, entradaConsumo());
    const lote = await siguienteLote(A);
    expect(lote.map((m) => m.mutation_id)).toEqual([otro.mutation_id]);
  });

  it('marcarEnviando incrementa los intentos y exige que la mutación siga pendiente', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    const lote = await siguienteLote(A);
    const [marcada] = await marcarEnviando(A, lote, new Date('2026-10-29T15:00:00.000Z'));
    expect(marcada).toMatchObject({
      estado: 'enviando',
      intentos: 1,
      enviada_at: '2026-10-29T15:00:00.000Z',
    });
    await expect(marcarEnviando(A, lote)).rejects.toMatchObject({ code: 'CONFLICTO' });
    await expect(marcarEnviando(A, [{ mutation_id: uuidv7() }])).rejects.toMatchObject({
      code: 'NO_ENCONTRADO',
    });
  });

  it('recuperarEnviando devuelve a pendiente lo que quedó en vuelo', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    await registrarConsumoLocal(B, entradaConsumo());
    await enviar(A);
    await enviar(B);
    expect(await recuperarEnviando(A)).toBe(1);
    expect(await siguienteLote(A)).toHaveLength(1);
    expect(await siguienteLote(B)).toHaveLength(0);
  });
});

describe('editarConsumoLocal', () => {
  it('calcula la versión esperada encadenando las ediciones en cola', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo());
    const e1 = await editarConsumoLocal(A, { id, cantidad: 20 });
    const e2 = await editarConsumoLocal(A, { id, lote: 'L-2' });
    expect((await mutacion(e1.mutation_id)).payload).toMatchObject({ version: 1 });
    expect((await mutacion(e2.mutation_id)).payload).toMatchObject({ version: 2 });

    // La vista local muestra la creación más las ediciones en cola.
    expect(await db.consumos.get([A, id])).toMatchObject({
      cantidad: 20,
      lote: 'L-2',
      estado_local: 'pendiente_sync',
    });

    // El servidor aplica la creación (v1) y la primera edición (v2); la segunda queda sin
    // resultado (error transitorio) y sigue en cola.
    const lote = await enviar(A);
    expect(lote.map((m) => m.mutation_id).slice(1)).toEqual([e1.mutation_id, e2.mutation_id]);
    const base = consumoServidor({ id, order_id: ORDEN, material_id: MATERIAL, registrado_por: A });
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { ...base, cantidad: 12.5 } }),
      resultado(lote, 1, {
        resultado: 'aplicada',
        servidor: { ...base, cantidad: 20, version: 2, updated_at: '2026-10-29T15:05:00.000Z' },
      }),
    ]);
    // e2 quedó sin resultado → vuelve a pendiente. La siguiente edición espera v2 + 1 (e2) = 3.
    const e3 = await editarConsumoLocal(A, { id, cantidad: 30 });
    expect((await mutacion(e3.mutation_id)).payload).toMatchObject({ version: 3 });
    expect(await db.consumos.get([A, id])).toMatchObject({
      version: 2,
      cantidad: 30,
      lote: 'L-2',
    });
  });

  it('una edición rechazada desaparece de la vista local', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo({ cantidad: 5 }));
    const base = consumoServidor({ id, registrado_por: A, cantidad: 5, order_id: ORDEN });
    const lote = await enviar(A);
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { ...base } }),
    ]);
    await editarConsumoLocal(A, { id, cantidad: 9 });
    expect((await db.consumos.get([A, id]))?.cantidad).toBe(9);

    const lote2 = await enviar(A);
    await aplicarResultados(A, lote2, [
      resultado(lote2, 0, {
        resultado: 'rechazada',
        code: 'CONSUMO_NO_PENDIENTE',
        message: 'Ya fue validado.',
      }),
    ]);
    expect(await db.consumos.get([A, id])).toMatchObject({
      cantidad: 5,
      estado_local: 'rechazado_sync',
      error_sync: { code: 'CONSUMO_NO_PENDIENTE', message: 'Ya fue validado.' },
    });
  });

  it('rechaza localmente lo que el servidor rechazaría', async () => {
    await expect(editarConsumoLocal(A, { id: uuidv7(), cantidad: 1 })).rejects.toMatchObject({
      code: 'NO_ENCONTRADO',
    });

    const ajeno = consumoServidor();
    await aplicarEntidades(A, [{ entidad: 'consumptions', id: ajeno.id, datos: { ...ajeno } }]);
    await expect(editarConsumoLocal(A, { id: ajeno.id, cantidad: 1 })).rejects.toMatchObject({
      code: 'PERMISO_DENEGADO',
    });

    const aprobado = consumoServidor({ registrado_por: A, estado: 'aprobado' });
    await aplicarEntidades(A, [
      { entidad: 'consumptions', id: aprobado.id, datos: { ...aprobado } },
    ]);
    await expect(editarConsumoLocal(A, { id: aprobado.id, cantidad: 1 })).rejects.toMatchObject({
      code: 'CONSUMO_NO_PENDIENTE',
    });

    const validado = consumoServidor({ registrado_por: A });
    const validacion = validacionServidor({ consumption_id: validado.id });
    await aplicarEntidades(A, [
      { entidad: 'consumptions', id: validado.id, datos: { ...validado } },
      { entidad: 'validations', id: validacion.id, datos: { ...validacion } },
    ]);
    await expect(editarConsumoLocal(A, { id: validado.id, cantidad: 1 })).rejects.toMatchObject({
      code: 'CONSUMO_NO_PENDIENTE',
    });

    const { id } = await registrarConsumoLocal(A, entradaConsumo());
    const lote = await enviar(A);
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'rechazada', code: 'UNIDAD_INCOMPATIBLE' }),
    ]);
    await expect(editarConsumoLocal(A, { id, cantidad: 1 })).rejects.toMatchObject({
      code: 'DEPENDENCIA_RECHAZADA',
    });
    await expect(
      registrarNovedadLocal(A, { consumption_id: id, tipo: 'otro', descripcion: 'x' }),
    ).rejects.toMatchObject({ code: 'DEPENDENCIA_RECHAZADA' });
  });
});

describe('novedades y fotos', () => {
  it('guarda la foto con su sha256, tamaño y subida pendiente', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo());
    const novedad = await registrarNovedadLocal(
      A,
      { consumption_id: id, tipo: 'merma', descripcion: 'Se derramó' },
      [fotoDe('abc')],
    );
    const fotos = await db.evidencias.toArray();
    expect(fotos).toHaveLength(1);
    expect(fotos[0]).toMatchObject({
      user_id: A,
      incident_id: novedad.id,
      mime: 'image/jpeg',
      tamano_bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      estado_subida: 'pendiente',
    });
    // Se compara como arreglo: fake-indexeddb clona en otro "realm" y `toEqual` distingue clases.
    expect(Array.from(new Uint8Array(fotos[0]!.datos!))).toEqual([97, 98, 99]);
    const m = await mutacion(novedad.mutation_id);
    expect(m.tipo).toBe('novedad.crear');
    expect(m.consumo_id).toBe(id);
    expect(m.payload).toMatchObject({
      evidencias: [{ id: fotos[0]!.id, sha256: fotos[0]!.sha256 }],
    });
    expect(await contarEvidenciasPendientes(A)).toBe(1);
    expect((await db.trazabilidad.toArray()).map((e) => e.descripcion)).toContain(
      'registró novedad',
    );
  });

  it('sha256Hex coincide con el vector de prueba de FIPS 180-2', async () => {
    const datos = new TextEncoder().encode('abc').buffer;
    expect(await sha256Hex(datos)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('rechaza un tipo de foto no permitido sin escribir nada', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo());
    await expect(
      registrarNovedadLocal(A, { consumption_id: id, tipo: 'otro', descripcion: 'x' }, [
        fotoDe('GIF89a', 'image/gif'),
      ]),
    ).rejects.toBeInstanceOf(ErrorValidacionLocal);
    expect(await db.novedades.count()).toBe(0);
    expect(await db.evidencias.count()).toBe(0);
  });

  it('exige que el consumo exista en la partición del usuario', async () => {
    const { id } = await registrarConsumoLocal(B, entradaConsumo());
    await expect(
      registrarNovedadLocal(A, { consumption_id: id, tipo: 'otro', descripcion: 'x' }),
    ).rejects.toMatchObject({ code: 'NO_ENCONTRADO' });
  });

  it('consumo + novedad en una sola transacción: si falla la novedad, no queda nada', async () => {
    vi.spyOn(db.evidencias, 'bulkAdd').mockImplementation(() => {
      throw new Error('cuota excedida');
    });
    await expect(
      registrarConsumoConNovedadLocal(A, entradaConsumo(), { tipo: 'merma', descripcion: 'x' }, [
        fotoDe('abc'),
      ]),
    ).rejects.toThrow('cuota excedida');
    expect(await db.consumos.count()).toBe(0);
    expect(await db.novedades.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('consumo + novedad: dos mutaciones en orden y un evento "registró consumo + novedad"', async () => {
    await guardarPerfil(A, 'Juan Sebastián');
    const r = await registrarConsumoConNovedadLocal(A, entradaConsumo(), {
      tipo: 'reproceso',
      descripcion: 'Pieza con poros',
    });
    const lote = await siguienteLote(A);
    expect(lote.map((m) => m.mutation_id)).toEqual(r.mutation_ids);
    expect(lote.map((m) => m.tipo)).toEqual(['consumo.crear', 'novedad.crear']);
    const eventos = await db.trazabilidad.toArray();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      actor_nombre: 'Juan S.',
      descripcion: 'registró consumo + novedad',
      entidad_id: r.consumo_id,
    });
  });

  it('solo sube fotos de novedades aplicadas y reintenta con backoff', async () => {
    const r = await registrarConsumoConNovedadLocal(
      A,
      entradaConsumo(),
      { tipo: 'merma', descripcion: 'x' },
      [fotoDe('abc')],
    );
    expect(await evidenciasListasParaSubir(A)).toHaveLength(0);

    const lote = await enviar(A);
    const novedad = novedadServidor({
      id: r.novedad_id,
      consumption_id: r.consumo_id,
      registrado_por: A,
    });
    await aplicarResultados(A, lote, [
      resultado(lote, 0, {
        resultado: 'aplicada',
        servidor: { ...consumoServidor({ id: r.consumo_id, registrado_por: A }) },
      }),
      resultado(lote, 1, { resultado: 'aplicada', servidor: { ...novedad, evidencias: [] } }),
    ]);
    const listas = await evidenciasListasParaSubir(A);
    expect(listas).toHaveLength(1);
    const foto = listas[0]!;
    expect(foto.mime).toBe('image/jpeg');
    await expect(evidenciasListasParaSubir(B)).resolves.toHaveLength(0);

    const ahora = new Date('2026-10-29T15:00:00.000Z');
    await programarReintentoEvidencia(
      A,
      foto.id,
      { code: 'EVIDENCIA_DESCONOCIDA', message: MENSAJES_ERROR.EVIDENCIA_DESCONOCIDA },
      { ahora, aleatorio: () => 0 },
    );
    expect(await evidenciasListasParaSubir(A, ahora)).toHaveLength(0);
    expect(await evidenciasListasParaSubir(A, new Date('2026-10-29T15:00:01.000Z'))).toHaveLength(
      1,
    );
    await programarReintentoEvidencia(A, uuidv7(), { code: null, message: 'x' });

    await marcarEvidenciaSubida(A, foto.id, ahora);
    expect(await db.evidencias.get([A, foto.id])).toMatchObject({
      estado_subida: 'subida',
      subido_at: '2026-10-29T15:00:00.000Z',
      error_subida: null,
    });
    expect(await contarEvidenciasPendientes(A)).toBe(0);
  });
});

describe('aprobarLocal / rechazarLocal (jefe con cortes, S5)', () => {
  const JEFE = uuidv7();

  async function consumoAjeno(): Promise<string> {
    const s = consumoServidor({ version: 4 });
    await aplicarEntidades(JEFE, [{ entidad: 'consumptions', id: s.id, datos: { ...s } }]);
    return s.id;
  }

  it('aprobar: validación local pendiente, mutación con la versión vista y estado final del servidor', async () => {
    const id = await consumoAjeno();
    const r = await aprobarLocal(JEFE, { consumption_id: id });
    const m = await mutacion(r.mutation_id);
    expect(m).toMatchObject({ tipo: 'consumo.aprobar', consumo_id: id, entidad_id: r.id });
    expect(m.payload).toMatchObject({ id: r.id, consumption_id: id, version: 4 });
    expect(await db.consumos.get([JEFE, id])).toMatchObject({ estado_local: 'pendiente_sync' });
    expect(await db.validaciones.get([JEFE, r.id])).toMatchObject({
      decision: 'aprobado',
      estado_local: 'pendiente_sync',
    });

    const lote = await enviar(JEFE);
    const consumo = consumoServidor({ id, estado: 'aprobado', version: 5 });
    const validacion = validacionServidor({ id: r.id, consumption_id: id, validado_por: JEFE });
    await aplicarResultados(JEFE, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { consumo, validacion } }),
    ]);
    expect(await db.consumos.get([JEFE, id])).toMatchObject({
      estado_local: 'aprobado',
      version: 5,
    });
    expect(await db.validaciones.get([JEFE, r.id])).toMatchObject({ estado_local: 'sincronizado' });
  });

  it('rechazar: el motivo se muestra en el consumo aunque el servidor solo devuelva la validación', async () => {
    const id = await consumoAjeno();
    const r = await rechazarLocal(JEFE, { consumption_id: id, motivo: 'Lote equivocado' });
    expect((await mutacion(r.mutation_id)).payload).toMatchObject({ motivo: 'Lote equivocado' });
    const lote = await enviar(JEFE);
    const validacion = validacionServidor({
      id: r.id,
      consumption_id: id,
      decision: 'rechazado',
      motivo: 'Lote equivocado',
    });
    await aplicarResultados(JEFE, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { ...validacion } }),
    ]);
    expect(await db.consumos.get([JEFE, id])).toMatchObject({
      estado_local: 'rechazado',
      motivo_rechazo: 'Lote equivocado',
    });
  });

  it('una validación rechazada por el servidor no bloquea otra posterior', async () => {
    const id = await consumoAjeno();
    const r = await aprobarLocal(JEFE, { consumption_id: id });
    const lote = await enviar(JEFE);
    await aplicarResultados(JEFE, lote, [
      resultado(lote, 0, { resultado: 'rechazada', code: 'REQUIERE_NOVEDAD' }),
    ]);
    expect(await db.validaciones.get([JEFE, r.id])).toMatchObject({
      estado_local: 'rechazado_sync',
      error_sync: { code: 'REQUIERE_NOVEDAD', message: MENSAJES_ERROR.REQUIERE_NOVEDAD },
    });
    expect(await db.consumos.get([JEFE, id])).toMatchObject({ estado_local: 'sincronizado' });
    await expect(
      rechazarLocal(JEFE, { consumption_id: id, motivo: 'No cuadra' }),
    ).resolves.toBeDefined();
  });

  it('impide autoaprobación, doble validación y consumos desconocidos', async () => {
    await expect(aprobarLocal(JEFE, { consumption_id: uuidv7() })).rejects.toMatchObject({
      code: 'NO_ENCONTRADO',
    });
    const propio = consumoServidor({ registrado_por: JEFE });
    await aplicarEntidades(JEFE, [
      { entidad: 'consumptions', id: propio.id, datos: { ...propio } },
    ]);
    await expect(aprobarLocal(JEFE, { consumption_id: propio.id })).rejects.toBeInstanceOf(
      ErrorDatosLocales,
    );
    await expect(aprobarLocal(JEFE, { consumption_id: propio.id })).rejects.toMatchObject({
      code: 'AUTOAPROBACION',
    });
    const id = await consumoAjeno();
    await aprobarLocal(JEFE, { consumption_id: id });
    await expect(
      rechazarLocal(JEFE, { consumption_id: id, motivo: 'Otra vez' }),
    ).rejects.toMatchObject({ code: 'CONSUMO_NO_PENDIENTE' });
  });

  it('valida el motivo del rechazo con el contrato', async () => {
    const id = await consumoAjeno();
    await expect(rechazarLocal(JEFE, { consumption_id: id, motivo: 'no' })).rejects.toBeInstanceOf(
      ErrorValidacionLocal,
    );
    expect(await db.validaciones.count()).toBe(0);
  });
});

describe('aplicarResultados', () => {
  it('aplicada: guarda el estado del servidor y marca el consumo como sincronizado', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo());
    const lote = await enviar(A);
    const s = consumoServidor({
      id,
      registrado_por: A,
      requiere_novedad: true,
      registro_tardio: true,
    });
    const ahora = new Date('2026-10-29T15:10:00.000Z');
    const resumen = await aplicarResultados(
      A,
      lote,
      [resultado(lote, 0, { resultado: 'aplicada', servidor: { ...s } })],
      { ahora },
    );
    expect(resumen).toMatchObject({ aplicadas: 1, rechazadas: 0, conflictos: 0, sin_resultado: 0 });
    expect(await mutacion(lote[0]!.mutation_id)).toMatchObject({
      estado: 'aplicada',
      aplicada_at: '2026-10-29T15:10:00.000Z',
    });
    expect(await db.consumos.get([A, id])).toMatchObject({
      estado_local: 'sincronizado',
      version: 1,
      requiere_novedad: true,
      registro_tardio: true,
      falta_novedad: true,
    });
    expect(await contarPendientes(A)).toBe(0);

    // Repetir la misma respuesta no cambia nada (ya no está en cola).
    const repetido = await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { ...s } }),
    ]);
    expect(repetido.aplicadas).toBe(0);
  });

  it('aplicada sin `servidor`: el consumo queda sincronizado con sus datos locales', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo());
    const lote = await enviar(A);
    await aplicarResultados(A, lote, [resultado(lote, 0, { resultado: 'aplicada' })]);
    expect(await db.consumos.get([A, id])).toMatchObject({
      estado_local: 'sincronizado',
      cantidad: 12.5,
      servidor: null,
    });
  });

  it('rechazada: rechazado_sync con código y mensaje; las dependientes en cola pasan a DEPENDENCIA_RECHAZADA', async () => {
    const r = await registrarConsumoConNovedadLocal(
      A,
      entradaConsumo(),
      { tipo: 'merma', descripcion: 'x' },
      [fotoDe('abc')],
    );
    const edicion = await editarConsumoLocal(A, { id: r.consumo_id, cantidad: 1 });
    const independiente = await registrarConsumoLocal(A, entradaConsumo());

    // Solo se envía la creación (el resto queda en cola, fuera del lote).
    const lote = await marcarEnviando(A, [{ mutation_id: r.mutation_ids[0] }]);
    const resumen = await aplicarResultados(A, lote, [
      resultado(lote, 0, {
        resultado: 'rechazada',
        code: 'UNIDAD_INCOMPATIBLE',
        message: 'La unidad no corresponde.',
      }),
    ]);
    expect(resumen).toMatchObject({ rechazadas: 1, dependientes_rechazadas: 2 });

    expect(await db.consumos.get([A, r.consumo_id])).toMatchObject({
      estado_local: 'rechazado_sync',
      error_sync: { code: 'UNIDAD_INCOMPATIBLE', message: 'La unidad no corresponde.' },
      cantidad: 12.5,
    });
    for (const id of [r.mutation_ids[1], edicion.mutation_id]) {
      expect(await mutacion(id)).toMatchObject({
        estado: 'rechazada',
        error: { code: 'DEPENDENCIA_RECHAZADA', message: MENSAJES_ERROR.DEPENDENCIA_RECHAZADA },
      });
    }
    expect(await db.novedades.get([A, r.novedad_id])).toMatchObject({
      estado_local: 'rechazado_sync',
      error_sync: { code: 'DEPENDENCIA_RECHAZADA' },
    });
    const [foto] = await db.evidencias.toArray();
    expect(foto).toMatchObject({ estado_subida: 'bloqueada' });
    expect(foto?.datos).not.toBeNull();
    // La independiente sigue pendiente: un rechazo no bloquea a las demás.
    expect((await siguienteLote(A)).map((m) => m.mutation_id)).toEqual([independiente.mutation_id]);
  });

  it('rechazada en el mismo lote: las dependientes sin resultado no se reintentan', async () => {
    const r = await registrarConsumoConNovedadLocal(A, entradaConsumo(), {
      tipo: 'merma',
      descripcion: 'x',
    });
    const lote = await enviar(A);
    expect(lote).toHaveLength(2);
    await aplicarResultados(A, lote, [resultado(lote, 0, { resultado: 'rechazada' })]);
    expect(await mutacion(r.mutation_ids[0])).toMatchObject({
      estado: 'rechazada',
      error: { code: null, message: 'El servidor rechazó el registro.' },
    });
    expect((await mutacion(r.mutation_ids[1])).estado).toBe('rechazada');
    expect(await contarPendientes(A)).toBe(0);
  });

  it('conflicto: guarda la versión del servidor y la siguiente edición parte de ella', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo());
    let lote = await enviar(A);
    const base = consumoServidor({ id, registrado_por: A, order_id: ORDEN });
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { ...base } }),
    ]);
    await editarConsumoLocal(A, { id, cantidad: 2 });
    lote = await enviar(A);
    const servidor = { ...base, cantidad: 7, version: 3, updated_at: '2026-10-29T16:00:00.000Z' };
    const resumen = await aplicarResultados(A, lote, [
      resultado(lote, 0, {
        resultado: 'conflicto',
        servidor: { consumo: servidor, version_servidor: 3 },
      }),
    ]);
    expect(resumen.conflictos).toBe(1);
    expect(await mutacion(lote[0]!.mutation_id)).toMatchObject({
      estado: 'conflicto',
      error: { code: 'CONFLICTO', message: MENSAJES_ERROR.CONFLICTO },
    });
    expect(await db.consumos.get([A, id])).toMatchObject({
      estado_local: 'conflicto',
      cantidad: 7,
      version: 3,
      conflicto_servidor: { consumo: servidor, version_servidor: 3 },
      error_sync: { code: 'CONFLICTO' },
    });
    const nueva = await editarConsumoLocal(A, { id, cantidad: 8 });
    expect((await mutacion(nueva.mutation_id)).payload).toMatchObject({ version: 3 });

    // Si el servidor avanza (pull con una versión mayor), el aviso de conflicto deja de aplicar.
    lote = await enviar(A);
    await aplicarResultados(A, lote, [
      resultado(lote, 0, {
        resultado: 'aplicada',
        servidor: { ...servidor, cantidad: 8, version: 4 },
      }),
    ]);
    expect(await db.consumos.get([A, id])).toMatchObject({
      estado_local: 'sincronizado',
      cantidad: 8,
      conflicto_servidor: null,
    });
  });

  it('conflicto en una creación (colisión de id): nunca adopta la entidad ajena', async () => {
    const { id } = await registrarConsumoLocal(A, entradaConsumo({ cantidad: 3 }));
    const lote = await enviar(A);
    const ajeno = consumoServidor({ id, cantidad: 999 });
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'conflicto', servidor: { ...ajeno } }),
    ]);
    expect(await db.consumos.get([A, id])).toMatchObject({
      cantidad: 3,
      servidor: null,
      estado_local: 'conflicto',
    });
  });

  it('sin resultado: vuelve a pendiente con UN mismo siguiente intento y backoff', async () => {
    for (let i = 0; i < 3; i += 1) {
      await registrarConsumoLocal(A, entradaConsumo());
    }
    const ahora = new Date('2026-10-29T15:00:00.000Z');
    const lote = await enviar(A, ahora);
    const resumen = await aplicarResultados(
      A,
      lote,
      [resultado(lote, 0, { resultado: 'aplicada' })],
      { ahora, aleatorio: () => 0 },
    );
    // Primer intento: e = 2 s, con aleatorio 0 → 1 s.
    expect(resumen).toMatchObject({
      aplicadas: 1,
      sin_resultado: 2,
      siguiente_intento_at: '2026-10-29T15:00:01.000Z',
    });
    for (const m of lote.slice(1)) {
      expect(await mutacion(m.mutation_id)).toMatchObject({
        estado: 'pendiente',
        intentos: 1,
        siguiente_intento_at: '2026-10-29T15:00:01.000Z',
      });
    }
    expect(await siguienteLote(A, 25, ahora)).toHaveLength(0);
    expect(await siguienteLote(A, 25, new Date('2026-10-29T15:00:01.000Z'))).toHaveLength(2);
  });

  it('un resultado con otro mutation_id no se aplica a la mutación de ese índice', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    const lote = await enviar(A);
    const resumen = await aplicarResultados(A, lote, [
      { indice: 0, mutation_id: uuidv7(), resultado: 'aplicada' },
    ]);
    expect(resumen).toMatchObject({ aplicadas: 0, sin_resultado: 1 });
    expect((await mutacion(lote[0]!.mutation_id)).estado).toBe('pendiente');
  });

  it('acepta un resultado por índice sin mutation_id (mutación ilegible para el servidor)', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    const lote = await enviar(A);
    await aplicarResultados(A, lote, [{ indice: 0, resultado: 'rechazada', code: 'VALIDACION' }]);
    expect(await mutacion(lote[0]!.mutation_id)).toMatchObject({
      estado: 'rechazada',
      error: { code: 'VALIDACION', message: MENSAJES_ERROR.VALIDACION },
    });
  });

  it('ignora mutaciones del lote que ya no existen', async () => {
    const resumen = await aplicarResultados(A, [{ mutation_id: uuidv7() }], []);
    expect(resumen.sin_resultado).toBe(0);
  });
});

describe('backoff', () => {
  it('crece exponencialmente con jitter acotado y nunca supera 5 min', () => {
    expect(calcularRetrasoMs(1, () => 0)).toBe(1_000);
    expect(calcularRetrasoMs(1, () => 0.999_999)).toBe(2_000);
    expect(calcularRetrasoMs(3, () => 0)).toBe(4_000);
    expect(calcularRetrasoMs(3, () => 0.5)).toBe(6_000);
    expect(calcularRetrasoMs(20, () => 0)).toBe(150_000);
    expect(calcularRetrasoMs(20, () => 1)).toBe(RETRASO_MAXIMO_MS);
    // Valores fuera de rango del aleatorio o de los intentos se acotan.
    expect(calcularRetrasoMs(0, () => -5)).toBe(1_000);
    expect(calcularRetrasoMs(Number.NaN, () => 7)).toBe(2_000);
    expect(calcularRetrasoMs(10_000, () => 0.5)).toBeLessThanOrEqual(RETRASO_MAXIMO_MS);
    for (let intentos = 1; intentos <= 40; intentos += 1) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const retraso = calcularRetrasoMs(intentos, () => r);
        const exponencial = Math.min(RETRASO_MAXIMO_MS, 2_000 * 2 ** (intentos - 1));
        expect(retraso).toBeGreaterThanOrEqual(exponencial / 2);
        expect(retraso).toBeLessThanOrEqual(Math.min(exponencial, RETRASO_MAXIMO_MS));
      }
    }
    expect(calcularRetrasoMs(2)).toBeGreaterThanOrEqual(2_000);
  });

  it('programarReintento devuelve la mutación pendiente con su siguiente intento', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    const [m] = await enviar(A);
    const ahora = new Date('2026-10-29T15:00:00.000Z');
    const reprogramada = programarReintento({ ...m!, intentos: 4 }, ahora, () => 0);
    expect(reprogramada).toMatchObject({
      estado: 'pendiente',
      siguiente_intento_at: '2026-10-29T15:00:08.000Z',
      actualizada_at: '2026-10-29T15:00:00.000Z',
    });
    expect(programarReintento(m!, ahora).siguiente_intento_at).not.toBeNull();
  });
});

describe('retención y cierre de sesión', () => {
  async function aplicarTodo(userId: string, ahora: Date): Promise<void> {
    const lote = await enviar(userId, ahora);
    await aplicarResultados(
      userId,
      lote,
      lote.map((_, i) => resultado(lote, i, { resultado: 'aplicada' })),
      { ahora },
    );
  }

  it('purga solo las aplicadas con más de 7 días, nunca las rechazadas', async () => {
    await registrarConsumoLocal(A, entradaConsumo());
    await aplicarTodo(A, new Date('2026-10-01T10:00:00.000Z'));
    await registrarConsumoLocal(A, entradaConsumo());
    await aplicarTodo(A, new Date('2026-10-25T10:00:00.000Z'));
    await registrarConsumoLocal(A, entradaConsumo());
    const lote = await enviar(A);
    await aplicarResultados(A, lote, [resultado(lote, 0, { resultado: 'rechazada' })], {
      ahora: new Date('2026-10-01T10:00:00.000Z'),
    });
    await registrarConsumoLocal(B, entradaConsumo());
    await aplicarTodo(B, new Date('2026-10-01T10:00:00.000Z'));

    const purgado = await purgarAplicadasAntiguas(A, new Date('2026-10-29T10:00:00.000Z'));
    expect(purgado.mutaciones).toBe(1);
    const restantes = (await db.outbox.toArray()).filter((m) => m.user_id === A);
    expect(restantes.map((m) => m.estado).sort()).toEqual(['aplicada', 'rechazada']);
    // La de B no se toca.
    expect((await db.outbox.toArray()).filter((m) => m.user_id === B)).toHaveLength(1);
  });

  it('libera los bytes de fotos subidas hace más de 7 días', async () => {
    const r = await registrarConsumoConNovedadLocal(
      A,
      entradaConsumo(),
      { tipo: 'merma', descripcion: 'x' },
      [fotoDe('abc')],
    );
    const [foto] = await db.evidencias.toArray();
    await marcarEvidenciaSubida(A, foto!.id, new Date('2026-10-01T10:00:00.000Z'));
    const purgado = await purgarAplicadasAntiguas(A, new Date('2026-10-29T10:00:00.000Z'));
    expect(purgado.fotos_liberadas).toBe(1);
    expect((await db.evidencias.get([A, foto!.id]))?.datos).toBeNull();
    expect(r.novedad_id).toBeDefined();
  });

  it('borrar datos del usuario solo sin pendientes; conserva rechazos y no toca a otros', async () => {
    await guardarPerfil(A, 'Ana');
    const rechazado = await registrarConsumoLocal(A, entradaConsumo());
    await registrarConsumoLocal(B, entradaConsumo());

    expect(await puedeBorrarDatosDeUsuario(A)).toEqual({
      puede: false,
      mutaciones: 1,
      evidencias: 0,
    });
    await expect(borrarDatosDeUsuario(A)).rejects.toMatchObject({ code: 'PENDIENTES_LOCALES' });
    expect(await db.consumos.get([A, rechazado.id])).toBeDefined();

    let lote = await enviar(A);
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'rechazada', code: 'VALIDACION' }),
    ]);
    const sincronizado = await registrarConsumoLocal(A, entradaConsumo());
    lote = await enviar(A);
    await aplicarResultados(A, lote, [resultado(lote, 0, { resultado: 'aplicada' })]);

    expect((await puedeBorrarDatosDeUsuario(A)).puede).toBe(true);
    const { conservadas } = await borrarDatosDeUsuario(A, { conservarPerfil: true });
    expect(conservadas).toBe(1);
    expect(await db.consumos.get([A, rechazado.id])).toMatchObject({
      estado_local: 'rechazado_sync',
    });
    expect(await db.consumos.get([A, sincronizado.id])).toBeUndefined();
    expect(await db.trazabilidad.where('[user_id+ts]').between([A, ''], [A, '￿']).count()).toBe(0);
    expect(await db.perfiles.get(A)).toBeDefined();
    expect(await contarPendientes(B)).toBe(1);

    await borrarDatosDeUsuario(A);
    expect(await db.perfiles.get(A)).toBeUndefined();
  });

  it('una foto sin subir también impide borrar los datos', async () => {
    const r = await registrarConsumoConNovedadLocal(
      A,
      entradaConsumo(),
      { tipo: 'merma', descripcion: 'x' },
      [fotoDe('abc')],
    );
    const lote = await enviar(A);
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'aplicada' }),
      resultado(lote, 1, { resultado: 'aplicada' }),
    ]);
    expect(await puedeBorrarDatosDeUsuario(A)).toEqual({
      puede: false,
      mutaciones: 0,
      evidencias: 1,
    });
    expect(r.consumo_id).toBeDefined();
  });
});

// Snapshot en un área temporal y autoridad del servidor tras un reinicio (ADR 0022; M5 y M6).

import { uuidv7, type CambioSync, type SyncPullResponse } from '@catmetal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aplicarCambios, aplicarEntidades, leerMetaSync } from './aplicar-cambios';
import { db } from './db';
import {
  aplicarResultados,
  aprobarLocal,
  borrarDatosDeUsuario,
  editarConsumoLocal,
  marcarEnviando,
  registrarConsumoLocal,
  siguienteLote,
} from './outbox';
import {
  consumoServidor,
  limpiarDb,
  novedadServidor,
  resultado,
  validacionServidor,
} from './pruebas/fabricas';
import {
  completarSnapshot,
  descartarSnapshot,
  guardarPaginaSnapshot,
  leerProgresoSnapshot,
  MAX_EDAD_SNAPSHOT_MS,
  progresoVigente,
} from './snapshot-temporal';

const A = uuidv7();
const B = uuidv7();
const JEFE = uuidv7();
const ORDEN = uuidv7();
const OTRA_ORDEN = uuidv7();
const MATERIAL = uuidv7();
const EPOCA = 'epoca-1';

let seq = 0;
function cambio(entidad: string, id: string, datos: Record<string, unknown>): CambioSync {
  seq += 1;
  return { seq, tipo: 'upsert', entidad, id, datos };
}

function pagina(cambios: CambioSync[], extra: Partial<SyncPullResponse> = {}): SyncPullResponse {
  return { epoca: EPOCA, cursor: seq, hay_mas: false, cambios, ...extra };
}

function orden(id: string, codigo: string): Record<string, unknown> {
  return {
    id,
    codigo,
    linea: 'Fundición',
    estado: 'en_proceso',
    fecha_inicio: null,
    fecha_fin: null,
    creada_por: JEFE,
    created_at: '2026-10-29T12:00:00.000Z',
    updated_at: '2026-10-29T12:00:00.000Z',
  };
}

function material(id: string, nombre: string): Record<string, unknown> {
  return { id, codigo: `MP-${nombre}`, nombre, unidad: 'kg', costo_unitario_cop: 1, activo: true };
}

/** Entidad del snapshot. */
function ent(
  entidad: string,
  id: string,
  datos: object,
): { entidad: string; id: string; datos: Record<string, unknown> } {
  return { entidad, id, datos: { ...datos } };
}

/** Estado de una tablet con catálogo completo para `userId` (época 1). */
async function tabletConCatalogo(userId: string): Promise<void> {
  await aplicarCambios(
    userId,
    pagina([
      cambio('production_orders', ORDEN, orden(ORDEN, 'OP-1')),
      cambio('production_orders', OTRA_ORDEN, orden(OTRA_ORDEN, 'OP-2')),
      cambio('materials', MATERIAL, material(MATERIAL, 'Arena')),
      cambio('order_supervisors', `${ORDEN}:${userId}`, { order_id: ORDEN, user_id: userId }),
      cambio('order_planned_materials', `${ORDEN}:${MATERIAL}`, {
        order_id: ORDEN,
        material_id: MATERIAL,
        cantidad_planeada: 100,
        unidad: 'kg',
      }),
      cambio('settings', 'tolerancia_pct', { clave: 'tolerancia_pct', valor: '5' }),
    ]),
  );
}

beforeEach(async () => {
  await limpiarDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M5: snapshot interrumpido', () => {
  it.each([
    ['cambio de época', pagina([], { epoca: 'epoca-2' })],
    ['reiniciar', pagina([{ seq: 999, tipo: 'reiniciar', entidad: 'users', id: A, datos: null }])],
  ])(
    '%s: con solo una página descargada, los catálogos siguen y se registra offline',
    async (_motivo, respuesta) => {
      await tabletConCatalogo(A);
      const antes = await leerMetaSync(A);
      const r = await aplicarCambios(A, respuesta);
      expect(r.acciones).toEqual([
        { tipo: 'snapshot', motivo: respuesta.epoca === EPOCA ? 'reiniciar' : 'epoca' },
      ]);
      // Primera página guardada; faltan más.
      expect(
        await guardarPaginaSnapshot(A, {
          epoca: respuesta.epoca,
          cursor: 50,
          entidades: [ent('materials', MATERIAL, material(MATERIAL, 'Arena nueva'))],
          siguiente_pagina: 'p1',
        }),
      ).toEqual({ resultado: 'guardada', completo: false });
      // Sin el resto (la red se cayó), un intento de completar no hace nada.
      expect(await completarSnapshot(A)).toMatchObject({ reemplazado: false });

      expect(await db.ordenes.count()).toBe(2);
      expect(await db.materiales.get([A, MATERIAL])).toMatchObject({ nombre: 'Arena' });
      expect(await db.asignaciones.count()).toBe(1);
      expect(await db.planeados.count()).toBe(1);
      expect(await db.settings.count()).toBe(1);
      const meta = await leerMetaSync(A);
      expect(meta).toMatchObject({ epoca: EPOCA, requiere_snapshot: true });
      if (respuesta.epoca !== EPOCA) {
        expect(meta.cursor).toBe(antes.cursor);
      }

      const registro = await registrarConsumoLocal(A, {
        order_id: ORDEN,
        material_id: MATERIAL,
        cantidad: 3,
        unidad: 'kg',
        lote: 'L-1',
      });
      expect(await db.outbox.get(registro.mutation_id)).toMatchObject({ estado: 'pendiente' });
      expect(await db.consumos.get([A, registro.id])).toMatchObject({
        estado_local: 'pendiente_sync',
      });
    },
  );

  it('una página de otra época no se guarda (nunca se mezclan épocas)', async () => {
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 5,
      entidades: [ent('materials', MATERIAL, material(MATERIAL, 'Arena'))],
      siguiente_pagina: 'p1',
    });
    expect(
      await guardarPaginaSnapshot(A, {
        epoca: 'epoca-3',
        cursor: 9,
        entidades: [ent('materials', uuidv7(), material(uuidv7(), 'Coque'))],
        siguiente_pagina: null,
      }),
    ).toEqual({ resultado: 'epoca_distinta', completo: false });
    expect(await db.snapshot_entidades.count()).toBe(1);
    expect(await leerProgresoSnapshot(A)).toMatchObject({
      epoca: 'epoca-2',
      cursor: 5,
      paginas: 1,
      completo: false,
    });
    await descartarSnapshot(A);
    expect(await db.snapshot_entidades.count()).toBe(0);
    expect(await leerProgresoSnapshot(A)).toBeUndefined();
  });

  it('una descarga a medias de más de 24 h no se reanuda; una completa sí se reemplaza', () => {
    const ahora = new Date('2026-10-30T12:00:00.000Z');
    const base = {
      user_id: A,
      alcance: 'inicial' as const,
      epoca: EPOCA,
      cursor: 1,
      siguiente_pagina: 'p1',
      paginas: 1,
      completo: false,
      iniciado_at: new Date(ahora.getTime() - MAX_EDAD_SNAPSHOT_MS + 1000).toISOString(),
      actualizado_at: ahora.toISOString(),
    };
    expect(progresoVigente(base, ahora)).toBe(true);
    expect(
      progresoVigente(
        { ...base, iniciado_at: new Date(ahora.getTime() - MAX_EDAD_SNAPSHOT_MS).toISOString() },
        ahora,
      ),
    ).toBe(false);
    expect(progresoVigente({ ...base, siguiente_pagina: null }, ahora)).toBe(false);
    expect(
      progresoVigente(
        {
          ...base,
          completo: true,
          siguiente_pagina: null,
          iniciado_at: '2020-01-01T00:00:00.000Z',
        },
        ahora,
      ),
    ).toBe(true);
  });
});

describe('M5: snapshot completo', () => {
  it('reemplaza el estado; cursor y época son los de la primera página; el área queda vacía', async () => {
    await tabletConCatalogo(A);
    const nuevoMaterial = uuidv7();
    expect(
      await guardarPaginaSnapshot(A, {
        epoca: 'epoca-2',
        cursor: 77,
        entidades: [
          ent('production_orders', ORDEN, orden(ORDEN, 'OP-1 bis')),
          ent('materials', MATERIAL, material(MATERIAL, 'Arena fina')),
        ],
        siguiente_pagina: 'p1',
      }),
    ).toMatchObject({ resultado: 'guardada' });
    // Una página repetida (reintento) no duplica nada.
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 77,
      entidades: [ent('materials', MATERIAL, material(MATERIAL, 'Arena fina'))],
      siguiente_pagina: 'p2',
    });
    expect(
      await guardarPaginaSnapshot(A, {
        epoca: 'epoca-2',
        cursor: 90,
        entidades: [
          ent('materials', nuevoMaterial, material(nuevoMaterial, 'Coque')),
          ent('settings', 'tolerancia_pct', { clave: 'tolerancia_pct', valor: '7.5' }),
          ent('entidad_futura', 'x', { a: 1 }),
        ],
        siguiente_pagina: null,
      }),
    ).toEqual({ resultado: 'guardada', completo: true });
    expect(await db.snapshot_entidades.count()).toBe(4);

    expect(await completarSnapshot(A)).toEqual({
      reemplazado: true,
      epoca_cambiada: true,
      aplicados: 4,
      ignorados: 0,
    });
    expect(await db.ordenes.toArray()).toEqual([
      expect.objectContaining({ id: ORDEN, codigo: 'OP-1 bis', revocada: false }),
    ]);
    expect(await db.materiales.get([A, MATERIAL])).toMatchObject({ nombre: 'Arena fina' });
    expect(await db.materiales.get([A, nuevoMaterial])).toMatchObject({ nombre: 'Coque' });
    expect(await db.asignaciones.count()).toBe(0);
    expect(await db.planeados.count()).toBe(0);
    expect(await db.settings.get([A, 'tolerancia_pct'])).toMatchObject({ valor: 7.5 });
    expect(await leerMetaSync(A)).toMatchObject({
      cursor: 77,
      epoca: 'epoca-2',
      requiere_snapshot: false,
      acciones: [],
    });
    expect(await db.snapshot_entidades.count()).toBe(0);
    expect(await leerProgresoSnapshot(A)).toBeUndefined();
    // Sin snapshot completo, no hace nada.
    expect(await completarSnapshot(A)).toMatchObject({ reemplazado: false });
  });

  it('es atómico: si algo falla, quedan los datos vivos, la meta y el área temporal', async () => {
    await tabletConCatalogo(A);
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 10,
      entidades: [ent('materials', MATERIAL, material(MATERIAL, 'Otra'))],
      siguiente_pagina: null,
    });
    const meta = await leerMetaSync(A);
    vi.spyOn(db.meta, 'put').mockRejectedValueOnce(new Error('cuota agotada'));
    await expect(completarSnapshot(A)).rejects.toThrow('cuota agotada');
    expect(await db.ordenes.count()).toBe(2);
    expect(await db.materiales.get([A, MATERIAL])).toMatchObject({ nombre: 'Arena' });
    expect(await db.asignaciones.count()).toBe(1);
    expect(await leerMetaSync(A)).toEqual(meta);
    expect(await leerProgresoSnapshot(A)).toMatchObject({ completo: true });
    // El reintento (sin red) termina.
    expect(await completarSnapshot(A)).toMatchObject({ reemplazado: true });
    expect(await db.materiales.get([A, MATERIAL])).toMatchObject({ nombre: 'Otra' });
  });

  it('solo toca la partición del usuario: B conserva su outbox, sus datos, su meta y su descarga', async () => {
    await tabletConCatalogo(A);
    await tabletConCatalogo(B);
    const deB = await registrarConsumoLocal(B, {
      order_id: ORDEN,
      material_id: MATERIAL,
      cantidad: 1,
      unidad: 'kg',
      lote: 'B',
    });
    await guardarPaginaSnapshot(B, {
      epoca: 'epoca-2',
      cursor: 3,
      entidades: [ent('materials', MATERIAL, material(MATERIAL, 'De B'))],
      siguiente_pagina: 'p1',
    });
    const metaB = await leerMetaSync(B);
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 10,
      entidades: [],
      siguiente_pagina: null,
    });
    await completarSnapshot(A);
    expect(await db.ordenes.where('[user_id+estado]').between([A, ''], [A, '￿']).count()).toBe(0);
    expect(await db.ordenes.get([B, ORDEN])).toBeDefined();
    expect(await db.materiales.get([B, MATERIAL])).toMatchObject({ nombre: 'Arena' });
    expect(await db.outbox.get(deB.mutation_id)).toMatchObject({ user_id: B, estado: 'pendiente' });
    expect(await db.consumos.get([B, deB.id])).toBeDefined();
    expect(await leerMetaSync(B)).toEqual(metaB);
    expect(await leerProgresoSnapshot(B)).toMatchObject({ completo: false, paginas: 1 });
    expect(await db.snapshot_entidades.count()).toBe(1);
  });

  it('cerrar sesión borra la descarga a medias del usuario y no la de los demás', async () => {
    for (const u of [A, B]) {
      await guardarPaginaSnapshot(u, {
        epoca: EPOCA,
        cursor: 1,
        entidades: [ent('materials', MATERIAL, material(MATERIAL, 'X'))],
        siguiente_pagina: 'p1',
      });
    }
    await borrarDatosDeUsuario(A);
    expect(await leerProgresoSnapshot(A)).toBeUndefined();
    expect(await leerProgresoSnapshot(B)).toBeDefined();
    expect(await db.snapshot_entidades.count()).toBe(1);
  });
});

describe('M6: el servidor manda tras un cambio de época', () => {
  /** Consumo propio de A ya sincronizado (v3, aprobado por el jefe) con la validación ajena. */
  async function consumoAprobado(): Promise<{ id: string; validacionId: string }> {
    const c = consumoServidor({
      registrado_por: A,
      order_id: ORDEN,
      estado: 'aprobado',
      version: 3,
    });
    const v = validacionServidor({ consumption_id: c.id, validado_por: JEFE });
    await aplicarCambios(
      A,
      pagina([cambio('consumptions', c.id, { ...c }), cambio('validations', v.id, { ...v })]),
    );
    return { id: c.id, validacionId: v.id };
  }

  it('lo local no pendiente se reemplaza aunque su versión sea mayor, y la validación perdida se va', async () => {
    const { id, validacionId } = await consumoAprobado();
    expect(await db.consumos.get([A, id])).toMatchObject({ estado_local: 'aprobado', version: 3 });

    await aplicarCambios(A, pagina([], { epoca: 'epoca-2' }));
    const restaurado = consumoServidor({ id, registrado_por: A, order_id: ORDEN, version: 2 });
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 4,
      entidades: [ent('consumptions', id, restaurado)],
      siguiente_pagina: null,
    });
    await completarSnapshot(A);
    expect(await db.consumos.get([A, id])).toMatchObject({
      estado_local: 'sincronizado',
      version: 2,
      servidor: { estado: 'pendiente', version: 2 },
      servidor_diferido: null,
    });
    expect(await db.validaciones.get([A, validacionId])).toBeUndefined();
  });

  it('lo pendiente se conserva: la copia del servidor espera en servidor_diferido hasta vaciar la cola', async () => {
    const c = consumoServidor({ registrado_por: A, order_id: ORDEN, version: 3, cantidad: 10 });
    await aplicarCambios(A, pagina([cambio('consumptions', c.id, { ...c })]));
    const edicion = await editarConsumoLocal(A, { id: c.id, cantidad: 7 });

    await aplicarCambios(A, pagina([], { epoca: 'epoca-2' }));
    const restaurado = { ...c, cantidad: 9, version: 2 };
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 4,
      entidades: [ent('consumptions', c.id, restaurado)],
      siguiente_pagina: null,
    });
    await completarSnapshot(A);
    expect(await db.outbox.get(edicion.mutation_id)).toMatchObject({ estado: 'pendiente' });
    expect(await db.consumos.get([A, c.id])).toMatchObject({
      estado_local: 'pendiente_sync',
      cantidad: 7,
      servidor: { version: 3 },
      servidor_diferido: { version: 2, cantidad: 9 },
      servidor_obsoleto: true,
    });

    // El reenvío se aplica sobre el estado restaurado: la respuesta reemplaza al obsoleto.
    const lote = await marcarEnviando(A, await siguienteLote(A));
    await aplicarResultados(A, lote, [
      resultado(lote, 0, {
        resultado: 'aplicada',
        servidor: {
          ...restaurado,
          cantidad: 7,
          version: 3,
          updated_at: '2026-10-30T10:00:00.000Z',
        },
      }),
    ]);
    expect(await db.consumos.get([A, c.id])).toMatchObject({
      estado_local: 'sincronizado',
      cantidad: 7,
      version: 3,
      servidor_diferido: null,
      servidor_obsoleto: false,
    });
  });

  it('con la cola vacía y sin respuesta, el diferido de la época nueva gana aunque su versión sea menor', async () => {
    const c = consumoServidor({ registrado_por: A, order_id: ORDEN, version: 5, cantidad: 10 });
    await aplicarCambios(A, pagina([cambio('consumptions', c.id, { ...c })]));
    const edicion = await editarConsumoLocal(A, { id: c.id, cantidad: 7 });
    await aplicarCambios(A, pagina([], { epoca: 'epoca-2' }));
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 4,
      entidades: [ent('consumptions', c.id, { ...c, version: 2, cantidad: 4 })],
      siguiente_pagina: null,
    });
    await completarSnapshot(A);
    // La edición se rechaza sin estado del servidor: la cola queda vacía.
    const lote = await marcarEnviando(A, await siguienteLote(A));
    expect(lote.map((m) => m.mutation_id)).toEqual([edicion.mutation_id]);
    await aplicarResultados(A, lote, [resultado(lote, 0, { resultado: 'rechazada' })]);
    expect(await db.consumos.get([A, c.id])).toMatchObject({
      servidor: { version: 2, cantidad: 4 },
      servidor_diferido: null,
      servidor_obsoleto: false,
    });
  });

  it('un consumo propio que el servidor ya no tiene queda perdido; la orden que solo él usa queda revocada', async () => {
    const propio = consumoServidor({ registrado_por: A, order_id: OTRA_ORDEN });
    await tabletConCatalogo(A);
    await aplicarCambios(A, pagina([cambio('consumptions', propio.id, { ...propio })]));
    await aplicarCambios(A, pagina([], { epoca: 'epoca-2' }));
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 4,
      entidades: [ent('production_orders', ORDEN, orden(ORDEN, 'OP-1'))],
      siguiente_pagina: null,
    });
    await completarSnapshot(A);
    expect(await db.consumos.get([A, propio.id])).toMatchObject({
      perdido_en_restauracion: true,
      verificar_en_snapshot: false,
    });
    expect(await db.ordenes.get([A, OTRA_ORDEN])).toMatchObject({ codigo: 'OP-2', revocada: true });
    expect(await db.ordenes.get([A, ORDEN])).toMatchObject({ revocada: false });
  });

  it('en la misma época, lo que un push confirmó durante la descarga ni se borra ni se marca perdido', async () => {
    await aplicarCambios(A, pagina([]));
    // La descarga (reiniciar) empieza antes del push.
    await guardarPaginaSnapshot(
      A,
      { epoca: EPOCA, cursor: 4, entidades: [], siguiente_pagina: 'p1' },
      '2000-01-01T00:00:00.000Z',
    );
    const registro = await registrarConsumoLocal(A, {
      order_id: ORDEN,
      material_id: MATERIAL,
      cantidad: 2,
      unidad: 'kg',
      lote: 'L',
    });
    const lote = await marcarEnviando(A, await siguienteLote(A));
    const s = consumoServidor({ id: registro.id, registrado_por: A, order_id: ORDEN, version: 1 });
    await aplicarResultados(A, lote, [
      resultado(lote, 0, { resultado: 'aplicada', servidor: { ...s } }),
    ]);
    // Un validación ajena confirmada por el push del jefe también se conserva.
    await aplicarEntidades(JEFE, [ent('consumptions', s.id, { ...s, registrado_por: B })]);
    const v = await aprobarLocal(JEFE, { consumption_id: s.id });
    const loteJefe = await marcarEnviando(JEFE, await siguienteLote(JEFE));
    await aplicarResultados(JEFE, loteJefe, [
      resultado(loteJefe, 0, {
        resultado: 'aplicada',
        servidor: {
          consumo: { ...s, registrado_por: B, estado: 'aprobado', version: 2 },
          validacion: validacionServidor({ id: v.id, consumption_id: s.id, validado_por: JEFE }),
        },
      }),
    ]);
    for (const u of [A, JEFE]) {
      await guardarPaginaSnapshot(
        u,
        { epoca: EPOCA, cursor: 4, entidades: [], siguiente_pagina: null },
        '2000-01-01T00:00:00.000Z',
      );
      await completarSnapshot(u);
    }
    expect(await db.consumos.get([A, registro.id])).toMatchObject({
      perdido_en_restauracion: false,
      estado_local: 'sincronizado',
    });
    expect(await db.consumos.get([JEFE, s.id])).toMatchObject({ estado_local: 'aprobado' });
    expect(await db.validaciones.get([JEFE, v.id])).toBeDefined();
  });

  it('las novedades propias del consumo conservado se quedan; las ajenas que el servidor no tiene se van', async () => {
    const propio = consumoServidor({ registrado_por: A, order_id: ORDEN });
    const nPropia = novedadServidor({ consumption_id: propio.id, registrado_por: A });
    const nAjena = novedadServidor({ consumption_id: propio.id, registrado_por: JEFE });
    await aplicarCambios(
      A,
      pagina([
        cambio('consumptions', propio.id, { ...propio }),
        cambio('incidents', nPropia.id, { ...nPropia }),
        cambio('incidents', nAjena.id, { ...nAjena }),
      ]),
    );
    await guardarPaginaSnapshot(A, {
      epoca: 'epoca-2',
      cursor: 1,
      entidades: [ent('consumptions', propio.id, propio)],
      siguiente_pagina: null,
    });
    await completarSnapshot(A);
    expect(await db.novedades.get([A, nPropia.id])).toBeDefined();
    expect(await db.novedades.get([A, nAjena.id])).toBeUndefined();
  });
});

describe('duración del reemplazo (informativa)', () => {
  // N por defecto acotado para la suite; la medición de 10.000 se corre aparte con
  // CATMETAL_N_REEMPLAZO=10000 (fake-indexeddb en Node es órdenes de magnitud más lento que Chromium).
  const N = Number(process.env.CATMETAL_N_REEMPLAZO ?? '500');
  it(`${N} entidades: el reemplazo termina y deja el estado del servidor`, async () => {
    await tabletConCatalogo(A);
    const inicioDescarga = performance.now();
    const entidades = Array.from({ length: N }, (_, i) => {
      const c = consumoServidor({ order_id: ORDEN, lote: `L-${i}` });
      return ent('consumptions', c.id, c);
    });
    for (let i = 0; i < N; i += 500) {
      await guardarPaginaSnapshot(A, {
        epoca: 'epoca-2',
        cursor: 1,
        entidades: entidades.slice(i, i + 500),
        siguiente_pagina: i + 500 < N ? `p${i + 500}` : null,
      });
    }
    const msDescarga = Math.round(performance.now() - inicioDescarga);
    const inicio = performance.now();
    const r = await completarSnapshot(A);
    const ms = Math.round(performance.now() - inicio);
    // Medición informativa (fake-indexeddb en Node; no es la tablet real): se publica en la salida.
    process.stdout.write(
      `[ADR 0022] ${N} consumos: guardar páginas ${msDescarga} ms, reemplazo ${ms} ms\n`,
    );
    expect(r).toMatchObject({ reemplazado: true, aplicados: N });
    expect(await db.consumos.count()).toBe(N);
  }, 600_000);
});

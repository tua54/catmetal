// M3 (ADR 0020, punto 4): `payload_json` de las mutaciones NO aplicadas se guarda entero hasta
// 16 KiB; por encima, un JSON reducido que conserva `$.payload.id` y `$.payload.consumption_id`
// (los usa la detección de DEPENDENCIA_RECHAZADA y el índice de la migración 0006). D1 local real.
import { mutacionSchema, uuidv7 } from '@catmetal/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PAYLOAD_NO_APLICADA_BYTES, payloadJson } from '../src/sync/push';
import { escenarioOrden } from './fase2-consumos-helpers';
import { sesion, type SesionDeRol } from './fase2-helpers';
import { crearConsumo, crearNovedadMut, filaSync, pushOk } from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let jefe: SesionDeRol;

beforeAll(async () => {
  [supervisor, jefe] = await Promise.all([sesion('supervisor'), sesion('jefe')]);
});

const bytes = (texto: string) => new TextEncoder().encode(texto).length;

describe('payload_json de las mutaciones no aplicadas (ADR 0020)', () => {
  it('el umbral es de 16 KiB', () => {
    expect(MAX_PAYLOAD_NO_APLICADA_BYTES).toBe(16 * 1024);
  });

  it('un rechazo de ~10 KiB se guarda entero', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material, { lote: 'x'.repeat(10_000) });
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'VALIDACION' });
    const fila = await filaSync(m.mutation_id);
    expect(JSON.parse(fila?.payload_json ?? 'null')).toEqual(m);
  });

  it('un rechazo de ~20 KiB se guarda reducido, con sus ids, y su dependiente sigue detectándose', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material, { lote: 'x'.repeat(20_000) });
    const id = String(m.payload.id);
    const dependiente = crearNovedadMut(id);
    const [r, rDependiente] = await pushOk(supervisor.token, supervisor.usuario.id, [m]).then(
      async (primero) => [
        ...primero,
        ...(await pushOk(supervisor.token, supervisor.usuario.id, [dependiente])),
      ],
    );
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'VALIDACION' });
    const fila = await filaSync(m.mutation_id);
    const guardado = JSON.parse(fila?.payload_json ?? 'null') as Record<string, unknown>;
    expect(guardado).toEqual({
      recortado: true,
      motivo: 'supera 16 KiB',
      tamano_bytes: bytes(JSON.stringify(m)),
      tipo: 'consumo.crear',
      payload: { id },
    });
    expect(bytes(fila?.payload_json ?? '')).toBeLessThan(1024);
    // La creación rechazada se sigue reconociendo por `$.payload.id` (CONSULTA_CREACION_NO_APLICADA).
    expect(rDependiente).toMatchObject({ resultado: 'rechazada', code: 'DEPENDENCIA_RECHAZADA' });
  });

  it('el JSON reducido omite los ids que no son UUID v7', () => {
    const texto = payloadJson({
      mutation_id: 'x',
      tipo: 'novedad.crear',
      payload: { id: 'no-es-uuid', consumption_id: uuidv7(), relleno: 'y'.repeat(20_000) },
    });
    const reducido = JSON.parse(texto) as { payload: Record<string, unknown> };
    expect(Object.keys(reducido.payload)).toEqual(['consumption_id']);
  });

  // Peor caso de escape JSON: el esquema rechaza los caracteres de control (salvo \n y \t), pero no
  // los sustitutos UTF-16 sueltos, que JSON.stringify escapa como `\udXXX` (6 bytes por unidad).
  it('la mutación válida más grande de cada tipo, con el peor escape, cabe entera', () => {
    const peor = (unidades: number) => '\ud800'.repeat(unidades);
    const t = new Date().toISOString();
    const evidencias = Array.from({ length: 5 }, () => ({
      id: uuidv7(),
      mime: 'image/webp',
      tamano_bytes: 5_242_880,
      sha256: 'f'.repeat(64),
    }));
    const base = { mutation_id: uuidv7(), client_created_at: t };
    const maximas = [
      {
        ...base,
        tipo: 'consumo.crear',
        payload: {
          id: uuidv7(),
          order_id: uuidv7(),
          material_id: uuidv7(),
          cantidad: 999_999_999.999,
          unidad: 'und',
          lote: peor(64),
          client_created_at: t,
          corrige_a: uuidv7(),
        },
      },
      {
        ...base,
        tipo: 'consumo.editar',
        payload: {
          id: uuidv7(),
          version: Number.MAX_SAFE_INTEGER,
          material_id: uuidv7(),
          cantidad: 999_999_999.999,
          unidad: 'und',
          lote: peor(64),
          client_created_at: t,
        },
      },
      {
        ...base,
        tipo: 'novedad.crear',
        payload: {
          id: uuidv7(),
          consumption_id: uuidv7(),
          tipo: 'error_registro',
          descripcion: peor(2000),
          client_created_at: t,
          evidencias,
        },
      },
      {
        ...base,
        tipo: 'consumo.aprobar',
        payload: {
          id: uuidv7(),
          consumption_id: uuidv7(),
          version: Number.MAX_SAFE_INTEGER,
          client_created_at: t,
        },
      },
      {
        ...base,
        tipo: 'consumo.rechazar',
        payload: {
          id: uuidv7(),
          consumption_id: uuidv7(),
          version: Number.MAX_SAFE_INTEGER,
          motivo: peor(500),
          client_created_at: t,
        },
      },
    ];
    for (const m of maximas) {
      expect(mutacionSchema.safeParse(m).success, m.tipo).toBe(true);
      const serializada = JSON.stringify(m);
      expect(bytes(serializada), m.tipo).toBeLessThanOrEqual(MAX_PAYLOAD_NO_APLICADA_BYTES);
      expect(payloadJson(m), m.tipo).toBe(serializada);
    }
  });
});

// A1 (docs/correcciones-v1.2.md, ADR 0028) en `/sync/push`: la auditoría y la fila `aplicada` de
// `sync_mutations` del perdedor de una carrera nunca se escriben.
//
// Técnica (determinista): el lote A corre con un reloj fijo; justo antes de su batch de escritura
// (ya leyó el estado y armó el plan), otra petición B con la MISMA hora procesa su lote completo
// sobre ese mismo estado y gana. Después se ejecuta el batch de A. D1 local real (sin mocks): la
// interferencia es otra escritura real, como la de otra petición concurrente.
import { type ResultadoMutacion, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Contexto } from '../src/dominio/contexto';
import { procesarLote, type SesionPush } from '../src/sync/push';
import {
  contarAuditoria,
  contextoFijo,
  horaFija,
  ordenDelSupervisor,
  unaVez,
} from './correcciones-a1-helpers';
import { nuevoConsumo } from './fase2-helpers';
import {
  crearConsumo,
  dbConInterferencia,
  decidirMut,
  editarConsumoMut,
  filaSync,
  type MutacionPrueba,
} from './fase3-helpers';
import { crearConsumo as consumoPorSql, crearEscenario } from './fixtures-db';

function sesionDe(ctx: Contexto, db: D1Database = env.DB): SesionPush {
  return {
    db,
    actor: ctx.actor,
    deviceId: ctx.deviceId,
    alertaReloj: false,
    reloj: () => ctx.ahora,
  };
}

/**
 * Procesa `perdedora` con su batch precedido del lote completo de `ganadora` (misma sesión y misma
 * hora). Devuelve el resultado de cada una.
 */
async function carrera(
  ctx: Contexto,
  perdedora: MutacionPrueba,
  ganadora: MutacionPrueba,
): Promise<{ perdedor: ResultadoMutacion | undefined; ganador: ResultadoMutacion | undefined }> {
  let ganador: ResultadoMutacion | undefined;
  const db = dbConInterferencia(
    'INSERT INTO sync_mutations',
    unaVez(async () => {
      [ganador] = await procesarLote(sesionDe(ctx), [ganadora]);
    }),
  );
  const [perdedor] = await procesarLote(sesionDe(ctx, db), [perdedora]);
  return { perdedor, ganador };
}

describe('A1 por /sync/push', () => {
  it('editar: el perdedor no audita ni registra su mutación como aplicada', async () => {
    const ctx = await contextoFijo('supervisor', horaFija());
    const { orden, material } = await ordenDelSupervisor(ctx);
    const id = await nuevoConsumo({
      orderId: orden,
      materialId: material,
      registradoPor: ctx.actor.id,
      deviceId: ctx.deviceId,
      cantidad: 10,
    });
    const a = editarConsumoMut(id, 1, { lote: 'A' });
    const b = editarConsumoMut(id, 1, { lote: 'B' });

    const { perdedor, ganador } = await carrera(ctx, a, b);

    expect(ganador).toMatchObject({ resultado: 'aplicada' });
    expect(perdedor).toMatchObject({ resultado: 'conflicto', code: 'CONFLICTO' });
    expect(await contarAuditoria('consumptions', id, 'consumo.editar')).toBe(1);
    expect((await filaSync(a.mutation_id))?.resultado).toBe('conflicto');
  });

  it('crear duplicado: el perdedor no audita y su fila de sync_mutations no queda aplicada', async () => {
    const ctx = await contextoFijo('supervisor', horaFija());
    const { orden, material } = await ordenDelSupervisor(ctx);
    const id = uuidv7();
    // Mismo id de consumo, otra hora del dispositivo: no es la misma creación (clave natural).
    const a = crearConsumo(orden, material, { id, client_created_at: '2026-10-30T10:00:00.000Z' });
    const b = crearConsumo(orden, material, { id, client_created_at: '2026-10-30T10:00:01.000Z' });

    const { perdedor, ganador } = await carrera(ctx, a, b);

    expect(ganador).toMatchObject({ resultado: 'aplicada' });
    expect(perdedor).toMatchObject({ resultado: 'conflicto', code: 'ID_DUPLICADO' });
    expect(await contarAuditoria('consumptions', id, 'consumo.crear')).toBe(1);
    expect((await filaSync(a.mutation_id))?.resultado).not.toBe('aplicada');
  });

  it('validar: rechazar gana y aprobar con el mismo id pierde sin auditar ni quedar aplicada', async () => {
    const e = await crearEscenario();
    const consumo = await consumoPorSql(e);
    const ctx = await contextoFijo('jefe', horaFija());
    const validacion = uuidv7();
    const a = decidirMut('aprobar', consumo, 1);
    a.payload.id = validacion;
    const b = decidirMut('rechazar', consumo, 1);
    b.payload.id = validacion;

    const { perdedor, ganador } = await carrera(ctx, a, b);

    expect(ganador).toMatchObject({ resultado: 'aplicada' });
    expect(perdedor?.resultado).not.toBe('aplicada');
    expect(await contarAuditoria('validations', validacion, 'validacion.crear')).toBe(1);
    expect(await contarAuditoria('consumptions', consumo, 'consumo.rechazar')).toBe(1);
    expect(await contarAuditoria('consumptions', consumo, 'consumo.aprobar')).toBe(0);
    expect((await filaSync(a.mutation_id))?.resultado).not.toBe('aplicada');
  });

  it('validar: aprobar dos veces con el mismo id, una sola auditoría por entidad', async () => {
    const e = await crearEscenario();
    const consumo = await consumoPorSql(e);
    const ctx = await contextoFijo('jefe', horaFija());
    const validacion = uuidv7();
    const a = decidirMut('aprobar', consumo, 1);
    a.payload.id = validacion;
    const b = decidirMut('aprobar', consumo, 1);
    b.payload.id = validacion;

    const { perdedor, ganador } = await carrera(ctx, a, b);

    expect(ganador).toMatchObject({ resultado: 'aplicada' });
    // La misma validación (clave natural): el perdedor la reconoce como aplicada, sin reescribirla.
    expect(perdedor).toMatchObject({ resultado: 'aplicada' });
    expect(await contarAuditoria('validations', validacion, 'validacion.crear')).toBe(1);
    expect(await contarAuditoria('consumptions', consumo, 'consumo.aprobar')).toBe(1);
  });
});

// S9 / P1: si el único jefe registró el consumo, no puede validarlo y queda pendiente (el admin
// tampoco valida). Archivo propio: cada archivo de pruebas tiene su propia D1, así este jefe es el
// único de la base.
import { type ColaValidacion, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { cuerpoConsumo, escenarioOrden, registrarOk } from './fase2-consumos-helpers';
import { api, esperarError, sesion } from './fase2-helpers';

describe('único jefe', () => {
  it('no aprueba su propio consumo, el admin tampoco, y sigue en la cola como propio', async () => {
    const [jefe, admin, supervisor] = await Promise.all([
      sesion('jefe'),
      sesion('admin'),
      sesion('supervisor'),
    ]);
    const jefes = await env.DB.prepare(
      `SELECT count(*) AS n FROM users WHERE rol = 'jefe' AND activo = 1`,
    ).first<{ n: number }>();
    expect(jefes?.n).toBe(1);

    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const propio = await registrarOk(jefe.token, cuerpoConsumo(orden, material));
    const body = { id: uuidv7(), version: 1, client_created_at: new Date().toISOString() };
    await esperarError(
      await api(`/consumptions/${propio.id}/approve`, { token: jefe.token, body }),
      403,
      'AUTOAPROBACION',
    );
    await esperarError(
      await api(`/consumptions/${propio.id}/approve`, { token: admin.token, body }),
      403,
      'PERMISO_DENEGADO',
    );
    const cola = await (
      await api(`/validations/queue?orden=${orden}`, { token: jefe.token })
    ).json<ColaValidacion>();
    expect(cola.pendientes).toBe(1);
    expect(cola.elementos[0]).toMatchObject({ id: propio.id, propio: true, estado: 'pendiente' });
  });
});

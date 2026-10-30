// F6-05: los ids interpolados en las rutas de la API van codificados con `encodeURIComponent`. Un id
// manipulado (`../`, `?`, `#`) nunca cambia el recurso ni la query que se pide.

import { uuidv7 } from '@catmetal/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ClienteApi } from '../../auth';
import { aprobarEnServidor, rechazarEnServidor } from '../validacion/api';
import {
  finalizarOrden,
  iniciarOrden,
  obtenerDetalleOrden,
  obtenerLineaTiempo,
  obtenerResumenOrden,
} from './api';

function clienteQueAnota() {
  const rutas: string[] = [];
  const api: ClienteApi = {
    peticion: vi.fn((ruta: string) => {
      rutas.push(ruta);
      return Promise.resolve(undefined as never);
    }),
  };
  return { api, rutas };
}

const MALICIOSO = '../users/x?estado=finalizada#y';
const CODIFICADO = '..%2Fusers%2Fx%3Festado%3Dfinalizada%23y';

describe('rutas de la API con ids codificados (F6-05)', () => {
  it('órdenes, reportes y auditoría', async () => {
    const { api, rutas } = clienteQueAnota();
    await obtenerDetalleOrden(MALICIOSO, undefined, api);
    await iniciarOrden(MALICIOSO, api);
    await finalizarOrden(MALICIOSO, false, api);
    await obtenerResumenOrden(MALICIOSO, undefined, api);
    await obtenerLineaTiempo(MALICIOSO, null, undefined, api);
    expect(rutas).toEqual([
      `/orders/${CODIFICADO}`,
      `/orders/${CODIFICADO}/start`,
      `/orders/${CODIFICADO}/finish`,
      `/reports/orders/${CODIFICADO}/summary`,
      `/orders/${CODIFICADO}/audit?limite=50`,
    ]);
  });

  it('aprobar y rechazar consumos', async () => {
    const { api, rutas } = clienteQueAnota();
    const base = { id: uuidv7(), version: 1, client_created_at: '2026-10-29T13:00:00.000Z' };
    await aprobarEnServidor(MALICIOSO, base, api);
    await rechazarEnServidor(MALICIOSO, { ...base, motivo: 'Cantidad errada' }, api);
    expect(rutas).toEqual([
      `/consumptions/${CODIFICADO}/approve`,
      `/consumptions/${CODIFICADO}/reject`,
    ]);
  });

  it('un UUID v7 queda igual', async () => {
    const { api, rutas } = clienteQueAnota();
    const id = uuidv7();
    await obtenerDetalleOrden(id, undefined, api);
    expect(rutas).toEqual([`/orders/${id}`]);
  });
});

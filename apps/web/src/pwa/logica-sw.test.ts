import { describe, expect, it, vi } from 'vitest';
import { MENSAJE_SYNC as MENSAJE_APP, TAG_BACKGROUND_SYNC } from '../sync';
import {
  esMensajeSaltarEspera,
  esNavegacionDelShell,
  MENSAJE_SYNC,
  reenviarSyncAClientes,
  TAG_SYNC,
} from './sw/logica';

describe('lógica del Service Worker', () => {
  it('usa la misma etiqueta y el mismo mensaje que el motor de sync de la app', () => {
    expect(TAG_SYNC).toBe(TAG_BACKGROUND_SYNC);
    expect(MENSAJE_SYNC).toBe(MENSAJE_APP);
  });

  it('nunca responde con el shell una navegación a /api', () => {
    expect(esNavegacionDelShell('/')).toBe(true);
    expect(esNavegacionDelShell('/supervisor')).toBe(true);
    expect(esNavegacionDelShell('/login')).toBe(true);
    expect(esNavegacionDelShell('/apiario')).toBe(true);
    expect(esNavegacionDelShell('/api')).toBe(false);
    expect(esNavegacionDelShell('/api/v1/auth/me')).toBe(false);
    expect(esNavegacionDelShell('/api/v1/evidences/123')).toBe(false);
  });

  it('reconoce solo el mensaje SKIP_WAITING de workbox-window', () => {
    expect(esMensajeSaltarEspera({ type: 'SKIP_WAITING' })).toBe(true);
    expect(esMensajeSaltarEspera({ type: 'OTRO' })).toBe(false);
    expect(esMensajeSaltarEspera('SKIP_WAITING')).toBe(false);
    expect(esMensajeSaltarEspera(null)).toBe(false);
  });

  it('reenvía el evento sync a todas las pestañas, también las no controladas', async () => {
    const pestanas = [{ postMessage: vi.fn() }, { postMessage: vi.fn() }];
    const matchAll = vi.fn(() => Promise.resolve(pestanas));

    await expect(reenviarSyncAClientes({ matchAll })).resolves.toBe(2);

    expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    for (const pestana of pestanas) {
      expect(pestana.postMessage).toHaveBeenCalledWith({ tipo: 'catmetal-sync' });
    }
  });

  it('sin pestañas abiertas no hace nada', async () => {
    await expect(reenviarSyncAClientes({ matchAll: () => Promise.resolve([]) })).resolves.toBe(0);
  });
});

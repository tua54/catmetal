import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConsultaLocal } from './useConsultaLocal';

describe('useConsultaLocal', () => {
  it('expone el error y "reintentar" vuelve a consultar hasta obtener datos', async () => {
    const consulta = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('IndexedDB no disponible'))
      .mockResolvedValue('datos');
    const { result } = renderHook(() => useConsultaLocal(consulta));

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.datos).toBeUndefined();
    expect(result.current.cargando).toBe(false);

    act(() => result.current.reintentar());
    // Mientras llega la respuesta nueva, el error anterior ya no se muestra.
    expect(result.current.error).toBeUndefined();
    expect(result.current.cargando).toBe(true);

    await waitFor(() => expect(result.current.datos).toBe('datos'));
    expect(result.current.error).toBeUndefined();
    expect(result.current.cargando).toBe(false);
    expect(consulta).toHaveBeenCalledTimes(2);
  });

  it('con la consulta en null no consulta ni queda cargando', () => {
    const { result } = renderHook(() => useConsultaLocal<string>(null));
    expect(result.current).toMatchObject({ datos: undefined, error: undefined, cargando: false });
  });
});

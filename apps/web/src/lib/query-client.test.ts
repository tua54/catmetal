// F6-04: la caché de TanStack Query no sobrevive a un cambio de usuario en la misma pestaña.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sesion } from '../auth';
import { entrarSinConexion, reiniciarApp } from '../test/app';
import { createQueryClient, vaciarCacheAlCambiarDeUsuario } from './query-client';

const CLAVE_USUARIOS = ['admin', 'usuarios'] as const;

beforeEach(reiniciarApp);
afterEach(reiniciarApp);

describe('vaciarCacheAlCambiarDeUsuario (F6-04)', () => {
  it('tras cambiar de usuario, la consulta cacheada del anterior no se devuelve', async () => {
    const cliente = createQueryClient();
    const dejar = vaciarCacheAlCambiarDeUsuario(cliente, sesion);
    try {
      const ana = await entrarSinConexion('supervisor', 'Ana Gómez');
      const deAna = await cliente.fetchQuery({
        queryKey: CLAVE_USUARIOS,
        queryFn: () => Promise.resolve([`correos visibles para ${ana.id}`]),
      });
      expect(cliente.getQueryData(CLAVE_USUARIOS)).toEqual(deAna);

      // Ana se va y entra Beto en la misma pestaña.
      await sesion.cerrarSesion();
      expect(cliente.getQueryData(CLAVE_USUARIOS)).toBeUndefined();
      const beto = await entrarSinConexion('supervisor', 'Beto Ruiz');

      const consultaDeBeto = vi.fn(() => Promise.resolve([`correos visibles para ${beto.id}`]));
      // `staleTime` de 30 s: si la caché de Ana siguiera ahí, `fetchQuery` la devolvería sin pedir.
      const deBeto = await cliente.fetchQuery({
        queryKey: CLAVE_USUARIOS,
        queryFn: consultaDeBeto,
      });
      expect(consultaDeBeto).toHaveBeenCalledTimes(1);
      expect(deBeto).toEqual([`correos visibles para ${beto.id}`]);
    } finally {
      dejar();
    }
  });

  it('también vacía en un cambio directo de usuario y no vacía si el usuario es el mismo', () => {
    let usuario: { id: string } | null = { id: 'a' };
    const oyentes = new Set<(estado: { usuario: { id: string } | null }) => void>();
    const publicar = (nuevo: { id: string } | null) => {
      usuario = nuevo;
      for (const oyente of oyentes) {
        oyente({ usuario });
      }
    };
    const clear = vi.fn();
    const dejar = vaciarCacheAlCambiarDeUsuario(
      { clear },
      {
        usuarioDeLaSesion: () => usuario,
        suscribir: (oyente) => {
          oyentes.add(oyente);
          return () => oyentes.delete(oyente);
        },
      },
    );

    publicar({ id: 'a' }); // bloqueo, refresh, cambio de modo: mismo usuario
    expect(clear).not.toHaveBeenCalled();
    publicar({ id: 'b' });
    expect(clear).toHaveBeenCalledTimes(1);
    publicar(null);
    expect(clear).toHaveBeenCalledTimes(2);
    publicar(null);
    expect(clear).toHaveBeenCalledTimes(2);

    dejar();
    publicar({ id: 'c' });
    expect(clear).toHaveBeenCalledTimes(2);
  });
});

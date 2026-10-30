import { permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { crearClienteApi } from '../auth/cliente-api';
import type { EstadoSesion } from '../auth/sesion';
import { contarPendientes, registrarConsumoLocal } from '../datos/outbox';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { crearStoreEstadoSync, iniciarSincronizacion, MotorSync, useEstadoSync } from './index';
import { crearServidorSync } from './pruebas/servidor-sync';

const usuario: Perfil = {
  id: uuidv7(),
  nombre: 'Ana',
  email: 'ana@catmetal.co',
  rol: 'supervisor',
  permisos: permisosDeRol('supervisor'),
};

async function hasta(condicion: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await condicion()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('La condición no se cumplió a tiempo');
}

beforeEach(async () => {
  await limpiarDb();
});

describe('iniciarSincronizacion', () => {
  it('conecta motor, disparadores, contadores, persistencia y cambios de sesión', async () => {
    const servidor = crearServidorSync();
    const oyentes = new Set<(e: EstadoSesion) => void>();
    let modo: EstadoSesion['modo'] = 'offline';
    const estadoSesion = (): EstadoSesion => ({
      modo,
      usuario,
      permisos: usuario.permisos,
      device_id: null,
      requiere_contrasena: false,
      bloqueada: false,
    });
    const sesion = {
      estado: estadoSesion,
      usuarioDeLaSesion: () => usuario,
      obtenerAccessToken: () => Promise.resolve(modo === 'online' ? `tok-${usuario.id}` : null),
      marcarRequiereContrasena: () => undefined,
      suscribir: (oyente: (e: EstadoSesion) => void) => {
        oyentes.add(oyente);
        return () => oyentes.delete(oyente);
      },
      api: crearClienteApi({
        fetch: (e, i) => servidor.fetch(e, i),
        proveedor: {
          obtenerAccessToken: () => Promise.resolve(`tok-${usuario.id}`),
          refrescar: () => Promise.resolve(null),
        },
      }),
    };
    const estado = crearStoreEstadoSync();
    const sync = iniciarSincronizacion({
      sesion,
      estado,
      disparadores: { esperaMs: 5, intervaloMs: 20, serviceWorker: null },
    });
    expect(sync.motor).toBeInstanceOf(MotorSync);
    await hasta(() => estado.getState().persistencia === 'no_disponible');

    // Offline: el cambio local actualiza el indicador pero no envía.
    estado.setState({ conexion: 'sin_conexion' });
    await registrarConsumoLocal(usuario.id, {
      order_id: uuidv7(),
      material_id: uuidv7(),
      cantidad: 1,
      unidad: 'kg',
      lote: 'L',
    });
    sync.cambioLocal();
    await hasta(() => estado.getState().pendientes === 1);
    expect(servidor.pushes()).toHaveLength(0);

    // La sesión pasa a online: se programa la sync y se envía.
    modo = 'online';
    for (const oyente of oyentes) {
      oyente(estadoSesion());
    }
    await hasta(async () => (await contarPendientes(usuario.id)) === 0);
    expect(servidor.pushes()).toHaveLength(1);
    await hasta(() => !estado.getState().sincronizando);
    expect(estado.getState()).toMatchObject({ pendientes: 0, conexion: 'en_linea' });

    sync.detener();
    expect(oyentes.size).toBe(0);
  });

  it('por defecto usa la sesión de la app y el store global', () => {
    const sync = iniciarSincronizacion({ disparadores: { serviceWorker: null } });
    expect(sync.motor.estado).toBe(useEstadoSync);
    sync.detener();
  });
});

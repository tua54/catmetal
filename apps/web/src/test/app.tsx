// Ayudas para montar la app completa en las pruebas (router en memoria + sesión y sync reales de
// la PWA sobre fake-indexeddb). No se usan en producción.

import { permisosDeRol, uuidv7, type Perfil, type Rol } from '@catmetal/shared';
import { render } from '@testing-library/react';
import { createMemoryRouter, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import { App } from '../App';
import { useArranque } from '../app/estado-arranque';
import { crearVerificador, sesion } from '../auth';
import { db } from '../datos/db';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { createQueryClient } from '../lib/query-client';
import { useEstadoPwa } from '../pwa/registro';
import { routes } from '../routes';
import { estadoSyncInicial, useEstadoSync, type ResumenSync } from '../sync';

export const CLAVE = 'clave-de-prueba';

export const RESUMEN_VACIO: ResumenSync = {
  motivo: 'manual',
  ejecutada: true,
  omitida: null,
  user_id: null,
  lotes: 0,
  enviadas: 0,
  aplicadas: 0,
  rechazadas: 0,
  conflictos: 0,
  sin_resultado: 0,
  cambios: 0,
  paginas_snapshot: 0,
  epoca_cambiada: false,
  fotos_subidas: 0,
  fotos_con_error: 0,
  siguiente_intento_at: null,
  error: null,
};

export function sincronizacionFalsa(resumen: Partial<ResumenSync> = {}) {
  return {
    sincronizarAhora: vi.fn(() => Promise.resolve({ ...RESUMEN_VACIO, ...resumen })),
    cambioLocal: vi.fn(),
  };
}

export function renderizarApp(
  ruta: string,
  opciones: { rutas?: RouteObject[]; sincronizacion?: ReturnType<typeof sincronizacionFalsa> } = {},
) {
  const router = createMemoryRouter(opciones.rutas ?? routes, { initialEntries: [ruta] });
  const sincronizacion = opciones.sincronizacion ?? sincronizacionFalsa();
  const resultado = render(
    <App router={router} queryClient={createQueryClient()} sincronizacion={sincronizacion} />,
  );
  return { ...resultado, router, sincronizacion };
}

/** Simula la red del navegador (`navigator.onLine`) y el indicador de conexión. */
export function fijarConexion(enLinea: boolean): void {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => enLinea });
  useEstadoSync.setState({ conexion: enLinea ? 'en_linea' : 'sin_conexion' });
}

const NOMBRES: Readonly<Record<Rol, string>> = {
  supervisor: 'Ana Gómez',
  jefe: 'Beto Ruiz',
  admin: 'Carla Díaz',
};

export function perfilDe(rol: Rol, nombre = NOMBRES[rol]): Perfil {
  const id = uuidv7();
  return {
    id,
    nombre,
    email: `${rol}.${id.slice(-6)}@catmetal.test`,
    rol,
    permisos: permisosDeRol(rol),
  };
}

/**
 * Deja el perfil en la tablet como si hubiera iniciado sesión con conexión antes (verificador con
 * pocas iteraciones para que la prueba sea rápida; el verificador guarda sus iteraciones).
 */
export async function guardarPerfilEnTablet(perfil: Perfil, clave = CLAVE): Promise<void> {
  await db.perfiles.put({
    user_id: perfil.id,
    perfil,
    device_id: uuidv7(),
    verificador: await crearVerificador(clave, 1_000),
    actualizado_at: '2026-10-29T15:00:00.000Z',
    ultimo_acceso_at: '2026-10-29T15:00:00.000Z',
    cierre_pendiente: false,
  });
}

/** Inicia sesión SIN conexión con la sesión real de la PWA (modo `offline`). */
export async function entrarSinConexion(rol: Rol, nombre?: string): Promise<Perfil> {
  const perfil = perfilDe(rol, nombre);
  await guardarPerfilEnTablet(perfil);
  fijarConexion(false);
  await sesion.iniciarSesion(perfil.email, CLAVE);
  return perfil;
}

/** Estado limpio entre pruebas: sin sesión, sin datos locales, arranque listo, sin red simulada. */
export async function reiniciarApp(): Promise<void> {
  // Sin red: cerrar sesión no intenta avisar al servidor.
  fijarConexion(false);
  await sesion.cerrarSesion();
  await limpiarDb();
  vi.unstubAllGlobals();
  useEstadoSync.setState(estadoSyncInicial());
  fijarConexion(true);
  useArranque.setState({ listo: true });
  useEstadoPwa.setState({
    actualizacionDisponible: false,
    listaSinConexion: false,
    actualizar: null,
  });
}

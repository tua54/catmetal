// S-09 (docs/auditoria/seguridad-correcciones.md): tras una revocación del servidor
// (`SESION_REVOCADA` en una petición autenticada: cambio de rol, desactivación…), la sesión ya no
// sigue "offline con el perfil viejo" mostrando los datos: queda BLOQUEADA y solo se desbloquea con
// la contraseña CONTRA EL SERVIDOR (perfil fresco), nunca con el verificador local. Las demás
// pestañas se bloquean también y el perfil local queda marcado: tampoco se entra sin conexión
// hasta un login con conexión.

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../datos/db';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { crearCanalSesion } from './canal-sesion';
import { ErrorApi } from './cliente-api';
import { busDifusion } from './pruebas/canal-falso';
import { crearServidorFalso, type ServidorFalso } from './pruebas/servidor-falso';
import { ErrorSesion, GestorSesion } from './sesion';
import { crearStoreSesion } from './store';

const CLAVE = 'clave-segura-ana';
let servidor: ServidorFalso;
let ana: ReturnType<ServidorFalso['agregarUsuario']>;
let enLinea: boolean;

function pestana(bus: ReturnType<typeof busDifusion>): GestorSesion {
  return new GestorSesion({
    fetch: servidor.fetch,
    locks: null,
    iteraciones: 1_000,
    iteracionesMinimas: 1_000,
    enLinea: () => enLinea,
    candado: { intervaloMs: 5 },
    canal: crearCanalSesion({ crearCanal: bus.crearCanal }),
  });
}

/** Espera a que la marca persistida y el aviso a las demás pestañas terminen. */
async function asentar(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(async () => {
  await limpiarDb();
  enLinea = true;
  servidor = crearServidorFalso();
  ana = servidor.agregarUsuario('Ana Gómez', 'ana@catmetal.co', CLAVE);
});

describe('S-09: revocación del servidor en una petición autenticada', () => {
  it('bloquea la sesión (y las demás pestañas), marca el perfil y no desbloquea sin conexión', async () => {
    const bus = busDifusion();
    const a = pestana(bus);
    const b = pestana(bus);
    await a.iniciarSesion('ana@catmetal.co', CLAVE);
    await b.restaurar();
    expect(b.estado()).toMatchObject({ modo: 'online', bloqueada: false });
    const storeA = crearStoreSesion(a);

    servidor.revocarUsuario(ana.id);
    await expect(a.api.peticion('/prueba')).rejects.toSatisfy(
      (e) => e instanceof ErrorApi && e.code === 'SESION_REVOCADA',
    );
    // Esta pestaña: bloqueada en el acto, sin token, con la revocación indicada a la UI.
    expect(a.estado()).toMatchObject({
      usuario: { id: ana.id },
      bloqueada: true,
      revocada: true,
      requiere_contrasena: true,
    });
    expect(storeA.getState()).toMatchObject({ bloqueada: true, revocada: true });
    expect(await a.obtenerAccessToken()).toBeNull();

    await asentar();
    expect(await db.perfiles.get(ana.id)).toMatchObject({ requiere_login_online: true });
    // La otra pestaña del mismo usuario también queda bloqueada.
    expect(b.estado()).toMatchObject({ bloqueada: true, revocada: true });

    // Sin conexión, la contraseña correcta NO desbloquea (el verificador local no vale aquí).
    enLinea = false;
    await expect(a.confirmarIdentidad(CLAVE)).rejects.toSatisfy(
      (e) => e instanceof ErrorSesion && e.code === 'SIN_CONEXION',
    );
    await expect(b.confirmarIdentidad(CLAVE)).rejects.toSatisfy(
      (e) => e instanceof ErrorSesion && e.code === 'SIN_CONEXION',
    );
    expect(a.estado()).toMatchObject({ bloqueada: true });
    expect(b.estado()).toMatchObject({ bloqueada: true });

    // Con conexión: login contra el servidor, perfil fresco y desbloqueo.
    enLinea = true;
    const logins = servidor.peticionesA('/api/v1/auth/login').length;
    await a.confirmarIdentidad(CLAVE);
    expect(servidor.peticionesA('/api/v1/auth/login')).toHaveLength(logins + 1);
    expect(a.estado()).toMatchObject({
      modo: 'online',
      bloqueada: false,
      revocada: false,
      requiere_contrasena: false,
    });
    expect(await db.perfiles.get(ana.id)).toMatchObject({ requiere_login_online: false });
  });

  it('tras la revocación, el login sin conexión queda negado hasta un login con conexión', async () => {
    const s = pestana(busDifusion());
    await s.iniciarSesion('ana@catmetal.co', CLAVE);
    servidor.revocarUsuario(ana.id);
    await expect(s.api.peticion('/prueba')).rejects.toBeInstanceOf(ErrorApi);
    await asentar();
    enLinea = false;
    await s.cerrarSesion();

    expect((await s.perfilesDelDispositivo())[0]).toMatchObject({ offline_disponible: false });
    await expect(s.iniciarSesion('ana@catmetal.co', CLAVE)).rejects.toSatisfy(
      (e) => e instanceof ErrorSesion && e.code === 'SIN_LOGIN_PREVIO',
    );
    enLinea = true;
    expect((await s.iniciarSesion('ana@catmetal.co', CLAVE)).modo).toBe('online');
    enLinea = false;
    await s.cerrarSesion();
    expect((await s.iniciarSesion('ana@catmetal.co', CLAVE)).modo).toBe('offline');
  });

  it('el motor (bearer propio) también bloquea: marcarSesionRevocada', async () => {
    const s = pestana(busDifusion());
    await s.iniciarSesion('ana@catmetal.co', CLAVE);
    s.marcarSesionRevocada();
    expect(s.estado()).toMatchObject({ bloqueada: true, revocada: true });
    await asentar();
    expect(await db.perfiles.get(ana.id)).toMatchObject({ requiere_login_online: true });
  });

  it('una sesión perdida por otra causa (AUTOR_NO_COINCIDE) NO bloquea: sigue offline', async () => {
    const s = pestana(busDifusion());
    await s.iniciarSesion('ana@catmetal.co', CLAVE);
    s.marcarRequiereContrasena();
    expect(s.estado()).toMatchObject({
      modo: 'offline',
      requiere_contrasena: true,
      bloqueada: false,
      revocada: false,
    });
  });
});

// Pruebas de la tarea 4.7 (revisión de seguridad de la Fase 4, ADR 0017) sobre `GestorSesion`:
// límites del login offline (F4-02/F4-07), invalidación del verificador (F4-03), bloqueo por
// inactividad (F4-01), token ligado al usuario y cierre con el candado de sync (F4-05), vuelta a
// online tras un login offline (F4-12) y correo enmascarado (F4-04). La red es simulada; IndexedDB
// es la real de fake-indexeddb.

import { MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../datos/db';
import { registrarConsumoLocal } from '../datos/outbox';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { NOMBRE_CANDADO_SYNC } from './candado';
import {
  crearServidorFalso,
  locksFalsos,
  urlDe,
  type ServidorFalso,
} from './pruebas/servidor-falso';
import {
  enmascararCorreo,
  esperaTrasFallos,
  GestorSesion,
  LIMITE_INACTIVIDAD_MS,
  type ErrorSesion,
  type OpcionesSesion,
} from './sesion';
import { crearVerificador } from './verificador';

const CLAVE_ANA = 'clave-segura-ana';
const CLAVE_BETO = 'clave-segura-beto';

let servidor: ServidorFalso;
let enLinea: boolean;
let reloj: number;
let ana: ReturnType<ServidorFalso['agregarUsuario']>;
let beto: ReturnType<ServidorFalso['agregarUsuario']>;

function gestor(opciones: OpcionesSesion = {}): GestorSesion {
  return new GestorSesion({
    fetch: (entrada, init) => servidor.fetch(entrada, init),
    locks: null,
    iteraciones: 1_000,
    // Verificadores baratos para que las pruebas sean rápidas; el mínimo real (100.000) se prueba
    // en 'F4-07' y en verificador.test.
    iteracionesMinimas: 1_000,
    enLinea: () => enLinea,
    ahora: () => reloj,
    candado: { intervaloMs: 5 },
    ...opciones,
  });
}

const consumo = {
  order_id: uuidv7(),
  material_id: uuidv7(),
  cantidad: 1,
  unidad: 'kg' as const,
  lote: 'L',
};

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorFalso();
  ana = servidor.agregarUsuario('Ana Gómez', 'ana@catmetal.co', CLAVE_ANA);
  beto = servidor.agregarUsuario('Beto Ruiz', 'beto@catmetal.co', CLAVE_BETO, 'jefe');
  enLinea = true;
  reloj = Date.parse('2026-10-29T15:00:00.000Z');
});

/** Entra con conexión y cierra sesión: queda el perfil con su verificador en la tablet. */
async function dejarPerfilDeAna(opciones: OpcionesSesion = {}): Promise<GestorSesion> {
  const s = gestor(opciones);
  await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
  await s.cerrarSesion();
  return s;
}

async function fallarOffline(s: GestorSesion, veces: number): Promise<unknown[]> {
  const errores: unknown[] = [];
  for (let i = 0; i < veces; i += 1) {
    errores.push(
      await s.iniciarSesion('ana@catmetal.co', `mala-${i}-123`).catch((e: unknown) => e),
    );
  }
  return errores;
}

const perfilDeAna = async () => (await db.perfiles.get(ana.id))!;

describe('límites del login offline (F4-02, ADR 0017 §2–3)', () => {
  it('espera creciente: 30 s × 2^(n−5) desde el 5.º fallo, con tope de 15 min', () => {
    expect([1, 4].map(esperaTrasFallos)).toEqual([0, 0]);
    expect([5, 6, 7, 8, 9].map(esperaTrasFallos)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
    expect(esperaTrasFallos(10)).toBe(900_000);
    expect(esperaTrasFallos(40)).toBe(900_000);
  });

  it('4 fallos sin espera; desde el 5.º espera aunque la contraseña sea correcta; luego entra y reinicia', async () => {
    const s = await dejarPerfilDeAna();
    enLinea = false;
    const errores = await fallarOffline(s, 4);
    expect(errores.map((e) => (e as ErrorSesion).code)).toEqual(
      Array(4).fill('CREDENCIALES_INVALIDAS'),
    );
    expect(await perfilDeAna()).toMatchObject({ intentos_offline: 4, espera_hasta: null });

    // 5.º fallo: el mismo mensaje genérico y una espera de 30 s persistida en el perfil.
    const [quinto] = await fallarOffline(s, 1);
    expect(quinto).toMatchObject({
      code: 'CREDENCIALES_INVALIDAS',
      message: MENSAJES_ERROR.CREDENCIALES_INVALIDAS,
    });
    expect(await perfilDeAna()).toMatchObject({
      intentos_offline: 5,
      espera_hasta: new Date(reloj + 30_000).toISOString(),
    });

    // Durante la espera, ni la contraseña correcta entra. Otra pestaña (otro gestor) ve el mismo
    // contador: está en IndexedDB.
    for (const pestana of [s, gestor()]) {
      await expect(pestana.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
        code: 'ESPERA_INTENTOS',
        message: 'Demasiados intentos en esta tablet. Intente más tarde o con conexión.',
      });
    }
    expect((await perfilDeAna()).intentos_offline).toBe(5);

    reloj += 30_001;
    expect((await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).modo).toBe('offline');
    expect(await perfilDeAna()).toMatchObject({ intentos_offline: 0, espera_hasta: null });
  });

  it('al 10.º fallo consecutivo borra el verificador: solo se puede entrar con conexión', async () => {
    const s = await dejarPerfilDeAna();
    enLinea = false;
    for (let fallo = 1; fallo <= 10; fallo += 1) {
      const [error] = await fallarOffline(s, 1);
      expect(error).toMatchObject({ code: 'CREDENCIALES_INVALIDAS' });
      reloj += esperaTrasFallos(fallo) + 1;
    }
    expect(await perfilDeAna()).toMatchObject({
      verificador: null,
      intentos_offline: 0,
      espera_hasta: null,
    });
    await expect(s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'SIN_LOGIN_PREVIO',
    });

    // Con conexión vuelve a entrar y se crea un verificador nuevo.
    enLinea = true;
    expect((await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).modo).toBe('online');
    expect((await perfilDeAna()).verificador).not.toBeNull();
  });

  it('un login online correcto reinicia el contador', async () => {
    const s = await dejarPerfilDeAna();
    enLinea = false;
    await fallarOffline(s, 5);
    enLinea = true;
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(await perfilDeAna()).toMatchObject({ intentos_offline: 0, espera_hasta: null });
  });

  it('el admin nunca tiene verificador (y se borra uno anterior)', async () => {
    const carla = servidor.agregarUsuario(
      'Carla Díaz',
      'carla@catmetal.co',
      'clave-segura-carla',
      'admin',
    );
    const s = gestor();
    await s.iniciarSesion('carla@catmetal.co', 'clave-segura-carla');
    expect((await db.perfiles.get(carla.id))!.verificador).toBeNull();

    // Un verificador de una versión anterior desaparece en el siguiente refresh.
    await db.perfiles.update(carla.id, {
      verificador: await crearVerificador('clave-segura-carla', 1_000),
    });
    await s.refrescar();
    expect((await db.perfiles.get(carla.id))!.verificador).toBeNull();
    await s.cerrarSesion();
    enLinea = false;
    await expect(s.iniciarSesion('carla@catmetal.co', 'clave-segura-carla')).rejects.toMatchObject({
      code: 'SIN_LOGIN_PREVIO',
    });
    expect((await s.perfilesDelDispositivo())[0]).toMatchObject({ offline_disponible: false });
  });

  it('F4-07: con el mínimo real, un verificador de menos de 100.000 iteraciones no abre la sesión', async () => {
    const s = await dejarPerfilDeAna({ iteracionesMinimas: undefined });
    enLinea = false;
    await expect(s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'CREDENCIALES_INVALIDAS',
    });
  });
});

describe('verificador invalidado por el servidor (F4-03)', () => {
  it('401 CREDENCIALES_INVALIDAS con una contraseña que el verificador acepta → se borra', async () => {
    await dejarPerfilDeAna();
    // El servidor ya no acepta esa contraseña (cambio, desactivación o bloqueo).
    servidor.forzarErrorLogin = 'CREDENCIALES_INVALIDAS';
    await expect(gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'CREDENCIALES_INVALIDAS',
    });
    expect((await perfilDeAna()).verificador).toBeNull();
    enLinea = false;
    await expect(gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'SIN_LOGIN_PREVIO',
    });
  });

  it('una contraseña equivocada u otro rechazo del servidor no tocan el verificador', async () => {
    await dejarPerfilDeAna();
    await expect(gestor().iniciarSesion('ana@catmetal.co', 'otra-clave-123')).rejects.toMatchObject(
      { code: 'CREDENCIALES_INVALIDAS' },
    );
    expect((await perfilDeAna()).verificador).not.toBeNull();
    servidor.forzarErrorLogin = 'DEMASIADOS_INTENTOS';
    await expect(gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'DEMASIADOS_INTENTOS',
    });
    expect((await perfilDeAna()).verificador).not.toBeNull();
  });
});

describe('bloqueo por inactividad (F4-01, ADR 0017 §1)', () => {
  it('bloqueada, la sync conserva su token; se desbloquea al confirmar contra el verificador', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    s.bloquear();
    expect(s.estado()).toMatchObject({ modo: 'online', bloqueada: true, usuario: { id: ana.id } });
    expect(await s.obtenerAccessToken({ esperado: ana.id })).toMatch(/^jwt\./);

    // Sin red: contra el verificador local. Una contraseña mala cuenta en el contador.
    enLinea = false;
    await expect(s.confirmarIdentidad('mala-clave-123')).rejects.toMatchObject({
      code: 'CREDENCIALES_INVALIDAS',
    });
    expect(s.estado().bloqueada).toBe(true);
    expect((await perfilDeAna()).intentos_offline).toBe(1);
    await expect(s.confirmarIdentidad('')).rejects.toMatchObject({ code: 'VALIDACION' });

    reloj += 60_000;
    await s.confirmarIdentidad(CLAVE_ANA);
    expect(s.estado()).toMatchObject({ modo: 'online', bloqueada: false });
    expect(await perfilDeAna()).toMatchObject({
      intentos_offline: 0,
      ultimo_acceso_at: new Date(reloj).toISOString(),
    });
    expect(servidor.peticionesA('/api/v1/auth/login')).toHaveLength(1);
    // Sin bloqueo, confirmar no hace nada.
    expect(await s.confirmarIdentidad('lo-que-sea')).toBe(s.estado());
  });

  it('si el verificador no coincide pero hay red, el login online también confirma', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    // El verificador local quedó con otra contraseña (por ejemplo, la cambió en otro equipo).
    await db.perfiles.update(ana.id, {
      verificador: await crearVerificador('vieja-clave-1', 1_000),
    });
    s.bloquear();
    await s.confirmarIdentidad(CLAVE_ANA);
    expect(s.estado()).toMatchObject({ modo: 'online', bloqueada: false });
    expect(servidor.peticionesA('/api/v1/auth/login')).toHaveLength(2);
  });

  it('sin verificador: con red confirma contra el servidor; sin red lo explica', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await db.perfiles.update(ana.id, { verificador: null });
    s.bloquear();
    enLinea = false;
    await expect(s.confirmarIdentidad(CLAVE_ANA)).rejects.toMatchObject({
      code: 'SIN_CONEXION',
      message:
        'No hay conexión con el servidor para confirmar su contraseña. Intente cuando vuelva la señal.',
    });
    enLinea = true;
    servidor.modo = 'caido';
    await expect(s.confirmarIdentidad(CLAVE_ANA)).rejects.toMatchObject({ code: 'SIN_CONEXION' });
    servidor.modo = 'normal';
    await expect(s.confirmarIdentidad('mala-clave-123')).rejects.toMatchObject({
      name: 'ErrorApi',
      code: 'CREDENCIALES_INVALIDAS',
    });
    expect(s.estado().bloqueada).toBe(true);
    await s.confirmarIdentidad(CLAVE_ANA);
    expect(s.estado().bloqueada).toBe(false);
  });

  it('en espera por intentos: sin red no deja confirmar; con red decide el servidor', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await db.perfiles.update(ana.id, {
      intentos_offline: 5,
      espera_hasta: new Date(reloj + 30_000).toISOString(),
    });
    s.bloquear();
    enLinea = false;
    await expect(s.confirmarIdentidad(CLAVE_ANA)).rejects.toMatchObject({
      code: 'ESPERA_INTENTOS',
    });
    enLinea = true;
    await s.confirmarIdentidad(CLAVE_ANA);
    expect(s.estado().bloqueada).toBe(false);
  });

  it('"No soy <nombre>" es cerrar sesión: queda sin sesión y ya no hay nada que confirmar', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    s.bloquear();
    await s.cerrarSesion();
    expect(s.estado()).toMatchObject({ modo: 'sin_sesion', bloqueada: false, usuario: null });
    expect(await s.confirmarIdentidad(CLAVE_ANA)).toMatchObject({ modo: 'sin_sesion' });
  });

  it('restaurar: con el último acceso de hace más de 10 min, la sesión de la cookie queda bloqueada', async () => {
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);

    reloj += LIMITE_INACTIVIDAD_MS - 1_000;
    expect((await gestor().restaurar()).estado).toMatchObject({ modo: 'online', bloqueada: false });

    reloj += LIMITE_INACTIVIDAD_MS + 1_000;
    const recargada = gestor();
    const { estado } = await recargada.restaurar();
    expect(estado).toMatchObject({ modo: 'online', bloqueada: true, usuario: { id: ana.id } });
    // La sync puede seguir con la sesión legítima; el acceso NO se registra hasta confirmar.
    expect(await recargada.obtenerAccessToken({ esperado: ana.id })).toMatch(/^jwt\./);
    expect((await perfilDeAna()).ultimo_acceso_at).not.toBe(new Date(reloj).toISOString());

    enLinea = false;
    await recargada.confirmarIdentidad(CLAVE_ANA);
    expect(recargada.estado()).toMatchObject({ modo: 'online', bloqueada: false });
    expect((await perfilDeAna()).ultimo_acceso_at).toBe(new Date(reloj).toISOString());
  });

  it('restaurar sin perfil en la tablet (último acceso desconocido) también queda bloqueada', async () => {
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await db.perfiles.delete(ana.id);
    const { estado } = await gestor().restaurar();
    expect(estado).toMatchObject({ modo: 'online', bloqueada: true });
    // El perfil se recrea sin acceso registrado y sin verificador: se confirma contra el servidor.
    expect(await perfilDeAna()).toMatchObject({ ultimo_acceso_at: null, verificador: null });
  });

  it('un refresh de la misma sesión conserva el bloqueo y no cuenta como acceso', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const acceso = (await perfilDeAna()).ultimo_acceso_at;
    s.bloquear();
    reloj += 5 * 60_000;
    await s.refrescar();
    expect(s.estado()).toMatchObject({ modo: 'online', bloqueada: true });
    expect((await perfilDeAna()).ultimo_acceso_at).toBe(acceso);
  });

  it('registrarActividad escribe el último acceso como mucho una vez por minuto y nunca bloqueada', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const leer = async () => (await perfilDeAna()).ultimo_acceso_at;
    reloj += 1_000;
    await s.registrarActividad();
    const primera = await leer();
    expect(primera).toBe(new Date(reloj).toISOString());
    reloj += 30_000;
    await s.registrarActividad();
    expect(await leer()).toBe(primera);
    reloj += 30_000;
    await s.registrarActividad();
    expect(await leer()).toBe(new Date(reloj).toISOString());

    s.bloquear();
    reloj += 120_000;
    await s.registrarActividad();
    expect(await leer()).not.toBe(new Date(reloj).toISOString());
    await expect(gestor().registrarActividad()).resolves.toBeUndefined(); // sin sesión: nada
  });
});

describe('token ligado al usuario (F4-05)', () => {
  it('obtenerAccessToken y refrescar con `esperado` nunca devuelven el token de otra persona', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(await s.obtenerAccessToken({ esperado: beto.id })).toBeNull();
    expect(await s.refrescar({ esperado: beto.id })).toBeNull();
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(0);
    expect(await s.refrescar({ esperado: ana.id })).toMatch(/^jwt\./);

    // Sin sesión local, un refresh ligado no adopta la cookie de nadie.
    const otra = gestor();
    expect(await otra.refrescar({ esperado: ana.id })).toBeNull();
    expect(otra.estado().modo).toBe('sin_sesion');
  });

  it('un refresh compartido entrega el mismo token a quien espera a su dueño', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.latenciaMs = 10;
    const [libre, deAna] = await Promise.all([s.refrescar(), s.refrescar({ esperado: ana.id })]);
    expect(libre).toMatch(/^jwt\./);
    expect(deAna).toBe(libre);
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('el reintento tras un 401 nunca usa la sesión de quien entró mientras tanto', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const original = servidor.fetch;
    servidor.fetch = async (entrada, init) => {
      if (urlDe(entrada).endsWith('/prueba')) {
        // Beto inicia sesión en la tablet mientras viaja la petición de Ana.
        servidor.fetch = original;
        await s.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
        return new Response(JSON.stringify({ code: 'NO_AUTENTICADO', message: 'x' }), {
          status: 401,
        });
      }
      return original(entrada, init);
    };
    await expect(s.api.peticion('/prueba')).rejects.toMatchObject({ code: 'NO_AUTENTICADO' });
    // Ni refresh ni reintento: el de Ana no se repite con la sesión de Beto.
    expect(servidor.peticionesA('/api/v1/prueba')).toHaveLength(0);
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(0);
    expect(s.estado().usuario?.id).toBe(beto.id);
  });

  it('cerrarSesion corta la sync en vuelo (señal) y espera al candado de sync antes de borrar', async () => {
    const locks = locksFalsos();
    const s = gestor({ locks });
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await registrarConsumoLocal(ana.id, consumo);
    const senal = s.senalDeSesion();

    // Una "sync" tiene el candado hasta que se la suelte.
    let soltar: () => void = () => undefined;
    const ocupado = locks.request(
      NOMBRE_CANDADO_SYNC,
      () => new Promise<void>((resolver) => (soltar = resolver)),
    );
    let terminado = false;
    const cierre = s.cerrarSesion().then((r) => {
      terminado = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(senal.aborted).toBe(true);
    expect(terminado).toBe(false);
    expect(s.estado().usuario?.id).toBe(ana.id);
    expect(await db.consumos.count()).toBe(1);
    // Mientras se cierra, ninguna sync nueva obtiene token.
    expect(await s.obtenerAccessToken()).toBeNull();

    soltar();
    await ocupado;
    expect(await cierre).toMatchObject({ datos_borrados: false, pendientes: { mutaciones: 1 } });
    expect(s.estado().modo).toBe('sin_sesion');
    expect(locks.solicitudes).toContain(NOMBRE_CANDADO_SYNC);
    expect(s.senalDeSesion().aborted).toBe(false);
  });

  it('cambiar de usuario aborta la señal de la sesión anterior', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const deAna = s.senalDeSesion();
    await s.refrescar();
    expect(deAna.aborted).toBe(false); // misma persona: la señal sigue
    await s.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    expect(deAna.aborted).toBe(true);
    expect(s.senalDeSesion().aborted).toBe(false);
  });
});

describe('vuelta a online tras un login offline (F4-12)', () => {
  it('con la cookie del mismo usuario pasa a online; si es de otra persona, pide la contraseña', async () => {
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.modo = 'caido';
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(s.estado().modo).toBe('offline');

    servidor.modo = 'normal';
    expect(await s.obtenerAccessToken({ esperado: ana.id })).toMatch(/^jwt\./);
    expect(s.estado()).toMatchObject({ modo: 'online', requiere_contrasena: false });

    servidor.modo = 'caido';
    const otra = gestor();
    await otra.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.modo = 'normal';
    await gestor().iniciarSesion('beto@catmetal.co', CLAVE_BETO); // la cookie ahora es de Beto
    expect(await otra.obtenerAccessToken({ esperado: ana.id })).toBeNull();
    expect(otra.estado()).toMatchObject({
      modo: 'offline',
      requiere_contrasena: true,
      usuario: { id: ana.id },
    });
  });
});

describe('perfiles del dispositivo (F4-04)', () => {
  it('el login recibe el correo enmascarado (y el completo solo para entrar)', async () => {
    await dejarPerfilDeAna();
    const [perfil] = await gestor().perfilesDelDispositivo();
    expect(perfil).toMatchObject({
      email: 'ana@catmetal.co',
      email_enmascarado: 'a***@catmetal.co',
    });
    expect(enmascararCorreo('juan@catmetal.test')).toBe('j***@catmetal.test');
    expect(enmascararCorreo('sin-arroba')).toBe('***');
    expect(enmascararCorreo('@dominio.co')).toBe('***');
  });
});

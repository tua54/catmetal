import { esUuidV7, MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, obtenerInstalacionId } from '../datos/db';
import { registrarConsumoLocal } from '../datos/outbox';
import { limpiarDb } from '../datos/pruebas/fabricas';
import { ErrorApi } from './cliente-api';
import {
  crearServidorFalso,
  locksFalsos,
  urlDe,
  type ServidorFalso,
} from './pruebas/servidor-falso';
import { ErrorSesion, GestorSesion, nombreDispositivo, type OpcionesSesion } from './sesion';
import { crearStoreSesion } from './store';

const CLAVE_ANA = 'clave-segura-ana';
const CLAVE_BETO = 'clave-segura-beto';
const CHROME =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

let servidor: ServidorFalso;
let enLinea: boolean;
let reloj: number;

function gestor(opciones: OpcionesSesion = {}): GestorSesion {
  return new GestorSesion({
    fetch: servidor.fetch,
    locks: null,
    iteraciones: 1_000,
    // Verificadores baratos para que las pruebas sean rápidas; el mínimo real (100.000) se prueba
    // en verificador.test y en 'límites del login offline'.
    iteracionesMinimas: 1_000,
    enLinea: () => enLinea,
    ahora: () => reloj,
    agenteUsuario: CHROME,
    candado: { intervaloMs: 5 },
    ...opciones,
  });
}

/** Todo el contenido de IndexedDB como texto, para buscar secretos. */
async function volcadoIndexedDb(): Promise<string> {
  const tablas = await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()]));
  return JSON.stringify(tablas);
}

function cuerposEnviados(): string {
  return servidor.peticiones.map((p) => p.cuerpo ?? '').join('\n');
}

const consumo = {
  order_id: uuidv7(),
  material_id: uuidv7(),
  cantidad: 1,
  unidad: 'kg' as const,
  lote: 'L',
};

let ana: ReturnType<ServidorFalso['agregarUsuario']>;
let beto: ReturnType<ServidorFalso['agregarUsuario']>;

beforeEach(async () => {
  await limpiarDb();
  localStorage.clear();
  sessionStorage.clear();
  servidor = crearServidorFalso();
  ana = servidor.agregarUsuario('Ana Gómez', 'ana@catmetal.co', CLAVE_ANA);
  beto = servidor.agregarUsuario('Beto Ruiz', 'beto@catmetal.co', CLAVE_BETO, 'jefe');
  enLinea = true;
  reloj = Date.parse('2026-10-29T15:00:00.000Z');
});

describe('login online', () => {
  it('guarda perfil, permisos, device_id y verificador; el token queda solo en memoria', async () => {
    const s = gestor();
    const estado = await s.iniciarSesion('  ANA@catmetal.co ', CLAVE_ANA);
    expect(estado).toMatchObject({
      modo: 'online',
      usuario: { id: ana.id, nombre: 'Ana Gómez' },
      permisos: ana.permisos,
      requiere_contrasena: false,
    });

    const [login] = servidor.peticionesA('/api/v1/auth/login');
    const cuerpo = JSON.parse(login!.cuerpo!) as Record<string, string>;
    expect(cuerpo.email).toBe('ana@catmetal.co');
    expect(esUuidV7(cuerpo.device_id)).toBe(true);
    expect(cuerpo.instalacion_id).toBe(await obtenerInstalacionId());
    expect(cuerpo.device_nombre).toBe('Tablet · Chrome');
    expect(login!.credenciales).toBe('same-origin');
    expect(login!.autorizacion).toBeNull();

    const perfil = await db.perfiles.get(ana.id);
    expect(perfil).toMatchObject({
      perfil: ana,
      device_id: cuerpo.device_id,
      cierre_pendiente: false,
      verificador: { algoritmo: 'pbkdf2-sha256', iteraciones: 1_000 },
    });

    const token = await s.obtenerAccessToken();
    expect(token).toMatch(/^jwt\./);
    expect(await volcadoIndexedDb()).not.toContain(token);
    expect(JSON.stringify(s.estado())).not.toContain(token);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('nunca envía el verificador ni su sal', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await s.refrescar();
    await s.api.peticion('/prueba');
    await s.cerrarSesion();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const { verificador } = (await db.perfiles.get(ana.id))!;
    const enviados = cuerposEnviados();
    expect(enviados).not.toContain(verificador!.hash);
    expect(enviados).not.toContain(verificador!.sal);
    for (const p of servidor.peticiones) {
      expect(p.cuerpo ?? '').not.toMatch(/verificador|pbkdf2/i);
    }
  });

  it('reutiliza el device_id de ese usuario en este navegador y usa el que devuelve el servidor', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const primero = (await db.perfiles.get(ana.id))!.device_id;
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const segundo = JSON.parse(servidor.peticionesA('/api/v1/auth/login')[1]!.cuerpo!) as {
      device_id: string;
    };
    expect(segundo.device_id).toBe(primero);
    await s.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    expect((await db.perfiles.get(beto.id))!.device_id).not.toBe(primero);
  });

  it('un rechazo del servidor nunca cae al login offline', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await s.cerrarSesion();

    // Contraseña cambiada en el servidor: la anterior sigue en el verificador, pero no entra.
    await expect(s.iniciarSesion('ana@catmetal.co', 'otra-clave-123')).rejects.toMatchObject({
      name: 'ErrorApi',
      code: 'CREDENCIALES_INVALIDAS',
      status: 401,
    });
    servidor.forzarErrorLogin = 'DEMASIADOS_INTENTOS';
    await expect(s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'DEMASIADOS_INTENTOS',
      status: 429,
    });
    servidor.forzarErrorLogin = 'ORIGEN_INVALIDO';
    await expect(s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toBeInstanceOf(ErrorApi);
    expect(s.estado().modo).toBe('sin_sesion');
  });

  it('valida el formato antes de llamar al servidor', async () => {
    const s = gestor();
    await expect(s.iniciarSesion('no-es-correo', 'x')).rejects.toMatchObject({
      code: 'VALIDACION',
    });
    await expect(s.iniciarSesion('ana@catmetal.co', '')).rejects.toBeInstanceOf(ErrorSesion);
    expect(servidor.peticiones).toHaveLength(0);
  });
});

describe('login offline', () => {
  it('entra con el verificador local, sin access token', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await s.cerrarSesion();

    enLinea = false;
    servidor.modo = 'caido';
    const estado = await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(estado).toMatchObject({
      modo: 'offline',
      usuario: { id: ana.id },
      permisos: ana.permisos,
    });
    expect(servidor.peticionesA('/api/v1/auth/login')).toHaveLength(1);
    expect(await s.obtenerAccessToken()).toBeNull();
  });

  it('contraseña incorrecta: el mismo mensaje genérico del servidor', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    enLinea = false;
    const error = await s
      .iniciarSesion('ana@catmetal.co', 'incorrecta-123')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorSesion);
    expect(error).toMatchObject({
      code: 'CREDENCIALES_INVALIDAS',
      message: MENSAJES_ERROR.CREDENCIALES_INVALIDAS,
    });
  });

  it('imposible sin un login online previo en este dispositivo', async () => {
    const s = gestor();
    enLinea = false;
    await expect(s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'SIN_LOGIN_PREVIO',
    });
    // Un perfil sin verificador (por ejemplo, recuperado solo por refresh) tampoco sirve.
    enLinea = true;
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await db.perfiles.update(ana.id, { verificador: null });
    enLinea = false;
    await expect(gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA)).rejects.toMatchObject({
      code: 'SIN_LOGIN_PREVIO',
    });
    expect(servidor.peticionesA('/api/v1/auth/login')).toHaveLength(1);
  });

  it('si el servidor no responde o responde 5xx, cae al login offline', async () => {
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.modo = 'caido';
    expect((await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA)).modo).toBe('offline');
    servidor.modo = 'error500';
    expect((await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA)).modo).toBe('offline');
  });

  it('al volver la conexión adopta la sesión del servidor del MISMO usuario', async () => {
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.modo = 'caido';
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(await s.obtenerAccessToken()).toBeNull();
    servidor.modo = 'normal';
    expect(await s.obtenerAccessToken()).toMatch(/^jwt\./);
    expect(s.estado().modo).toBe('online');
  });
});

describe('refresh', () => {
  it('5 llamadas simultáneas hacen una sola petición (alternativa sin Web Locks)', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.latenciaMs = 20;
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => s.refrescar()));
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(1);
    expect(new Set(tokens).size).toBe(1);
    expect(await db.candados.count()).toBe(0);
  });

  it('5 llamadas simultáneas hacen una sola petición (Web Locks)', async () => {
    const locks = locksFalsos();
    const s = gestor({ locks });
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await Promise.all([1, 2, 3, 4, 5].map(() => s.refrescar()));
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(1);
    expect(locks.solicitudes).toEqual(['catmetal-refresh']);
  });

  it('dos gestores sin Web Locks nunca refrescan a la vez (el candado entre pestañas se prueba en candado.test)', async () => {
    const pestanaA = gestor();
    await pestanaA.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const pestanaB = gestor();
    await pestanaB.restaurar();
    servidor.latenciaMs = 15;
    servidor.maxRefrescosSimultaneos = 0;
    await Promise.all([pestanaA.refrescar(), pestanaB.refrescar(), pestanaA.refrescar()]);
    expect(servidor.peticionesA('/api/v1/auth/refresh').length).toBeGreaterThanOrEqual(3);
    expect(servidor.maxRefrescosSimultaneos).toBe(1);
  });

  it('obtenerAccessToken refresca cuando el token está por vencer', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const primero = await s.obtenerAccessToken();
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(0);
    reloj += 871_000; // quedan 29 s de los 900
    const segundo = await s.obtenerAccessToken();
    expect(segundo).not.toBe(primero);
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('si la cookie es de otra persona, NO adopta su sesión y pide contraseña', async () => {
    const tabletAna = gestor();
    await tabletAna.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    // Beto inicia sesión en otra pestaña del mismo navegador: la cookie ahora es suya.
    await gestor().iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    expect(servidor.duenoCookie()).toBe(beto.id);

    expect(await tabletAna.refrescar()).toBeNull();
    expect(tabletAna.estado()).toMatchObject({
      usuario: { id: ana.id },
      modo: 'offline',
      requiere_contrasena: true,
    });
    expect(await tabletAna.obtenerAccessToken()).toBeNull();
    // No vuelve a intentarlo solo: hace falta la contraseña.
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('TOKEN_INVALIDO o SESION_REVOCADA: sigue offline y pide contraseña', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.revocarUsuario(ana.id);
    expect(await s.refrescar()).toBeNull();
    expect(s.estado()).toMatchObject({ modo: 'offline', requiere_contrasena: true });
    // Iniciar sesión de nuevo con conexión lo resuelve.
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(s.estado()).toMatchObject({ modo: 'online', requiere_contrasena: false });
  });

  it('sin red o con 5xx devuelve null y conserva el estado', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.modo = 'caido';
    expect(await s.refrescar()).toBeNull();
    servidor.modo = 'error500';
    expect(await s.refrescar()).toBeNull();
    expect(s.estado()).toMatchObject({ modo: 'online', requiere_contrasena: false });
  });
});

describe('cliente con sesión', () => {
  it('401 NO_AUTENTICADO → un refresh → reintenta una sola vez', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.invalidarToken((await s.obtenerAccessToken())!);
    await expect(s.api.peticion('/prueba')).resolves.toEqual({ ok: true, user_id: ana.id });
    expect(servidor.peticionesA('/api/v1/prueba')).toHaveLength(2);
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(1);
    const [primera, segunda] = servidor.peticionesA('/api/v1/prueba');
    expect(primera!.autorizacion).not.toBe(segunda!.autorizacion);
  });

  it('si el reintento vuelve a fallar con 401, no hay un segundo refresh', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const original = servidor.fetch;
    servidor.fetch = async (entrada, init) => {
      const respuesta = await original(entrada, init);
      return urlDe(entrada).endsWith('/prueba')
        ? new Response(JSON.stringify({ code: 'NO_AUTENTICADO', message: 'x' }), { status: 401 })
        : respuesta;
    };
    const s2 = gestor({ fetch: (e, i) => servidor.fetch(e, i) });
    await s2.restaurar();
    await expect(s2.api.peticion('/prueba')).rejects.toMatchObject({ code: 'NO_AUTENTICADO' });
    expect(servidor.peticionesA('/api/v1/prueba')).toHaveLength(2);
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(2);
    expect(s.estado().modo).toBe('online');
  });

  it('SESION_REVOCADA en una petición: pasa a offline y pide contraseña', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    servidor.revocarUsuario(ana.id);
    await expect(s.api.peticion('/prueba')).rejects.toMatchObject({ code: 'SESION_REVOCADA' });
    expect(s.estado()).toMatchObject({ modo: 'offline', requiere_contrasena: true });
  });

  it('sin sesión no llama al servidor', async () => {
    const s = gestor();
    await expect(s.api.peticion('/prueba')).rejects.toMatchObject({ code: 'NO_AUTENTICADO' });
    expect(servidor.peticiones).toHaveLength(0);
  });
});

describe('restaurar al cargar la app', () => {
  it('recupera la sesión con la cookie', async () => {
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const recargada = gestor();
    const { estado, perfiles } = await recargada.restaurar();
    expect(estado).toMatchObject({ modo: 'online', usuario: { id: ana.id } });
    expect(perfiles).toEqual([
      expect.objectContaining({ user_id: ana.id, nombre: 'Ana Gómez', offline_disponible: true }),
    ]);
    expect(JSON.stringify(perfiles)).not.toContain('hash');
  });

  it('sin red queda sin sesión y ofrece los perfiles del dispositivo, el último primero', async () => {
    await gestor().iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    reloj += 1;
    await new Promise((r) => setTimeout(r, 5));
    await gestor().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    enLinea = false;
    const { estado, perfiles } = await gestor().restaurar();
    expect(estado.modo).toBe('sin_sesion');
    expect(perfiles.map((p) => p.user_id)).toEqual([ana.id, beto.id]);
  });

  it('sin cookie válida queda sin sesión', async () => {
    const { estado } = await gestor().restaurar();
    expect(estado).toMatchObject({ modo: 'sin_sesion', requiere_contrasena: false });
  });
});

describe('cerrarSesion', () => {
  it('sin pendientes: revoca en el servidor por Bearer, borra los datos y conserva el perfil', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const r = await s.cerrarSesion();
    expect(r).toEqual({
      servidor_notificado: true,
      datos_borrados: true,
      pendientes: { mutaciones: 0, evidencias: 0 },
    });
    const [logout] = servidor.peticionesA('/api/v1/auth/logout');
    expect(logout!.credenciales).toBe('omit');
    expect(logout!.autorizacion).toMatch(/^Bearer jwt\./);
    expect(s.estado().modo).toBe('sin_sesion');
    expect(await s.obtenerAccessToken()).toBeNull();
    expect(await db.perfiles.get(ana.id)).toMatchObject({
      cierre_pendiente: false,
      verificador: expect.objectContaining({ algoritmo: 'pbkdf2-sha256' }) as unknown,
    });
    // Puede volver a entrar sin conexión.
    enLinea = false;
    expect((await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA)).modo).toBe('offline');
  });

  it('con pendientes: no borra nada y devuelve el aviso', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    const { id } = await registrarConsumoLocal(ana.id, consumo);
    const r = await s.cerrarSesion();
    expect(r).toMatchObject({
      datos_borrados: false,
      pendientes: { mutaciones: 1, evidencias: 0 },
    });
    expect(await db.consumos.get([ana.id, id])).toBeDefined();
    expect(s.estado().usuario).toBeNull();
  });

  it('sin conexión: marca el cierre pendiente; luego la cookie de esa persona no se adopta y se revoca', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    enLinea = false;
    const r = await s.cerrarSesion();
    expect(r.servidor_notificado).toBe(false);
    expect((await db.perfiles.get(ana.id))!.cierre_pendiente).toBe(true);

    // Otra persona abre la app con conexión: la cookie aún es de Ana, pero no entra como Ana.
    enLinea = true;
    const otra = gestor();
    const { estado } = await otra.restaurar();
    expect(estado.modo).toBe('sin_sesion');
    expect(servidor.peticionesA('/api/v1/auth/logout')).toHaveLength(1);
    expect((await db.perfiles.get(ana.id))!.cierre_pendiente).toBe(false);
    expect(await otra.refrescar()).toBeNull();
  });

  it('sin usuario no hace nada', async () => {
    expect(await gestor().cerrarSesion()).toEqual({
      servidor_notificado: false,
      datos_borrados: false,
      pendientes: { mutaciones: 0, evidencias: 0 },
    });
  });
});

describe('tablet compartida', () => {
  it('avisa los pendientes de otros usuarios con su nombre', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    await registrarConsumoLocal(ana.id, consumo);
    await registrarConsumoLocal(ana.id, consumo);
    await s.cerrarSesion();
    await s.iniciarSesion('beto@catmetal.co', CLAVE_BETO);
    await registrarConsumoLocal(beto.id, consumo);

    const avisos = await s.pendientesDeOtrosUsuarios(beto.id);
    expect(avisos).toEqual([
      expect.objectContaining({
        user_id: ana.id,
        total: 2,
        mensaje: 'Hay 2 registros pendientes de Ana Gómez',
      }),
    ]);
    const deBeto = await s.pendientesDeOtrosUsuarios(ana.id);
    expect(deBeto[0]?.mensaje).toBe('Hay 1 registro pendiente de Beto Ruiz');
    await db.perfiles.delete(beto.id);
    expect((await s.pendientesDeOtrosUsuarios(null)).map((a) => a.mensaje)).toContain(
      'Hay 1 registro pendiente de otro usuario',
    );
  });
});

describe('eventos y store de React', () => {
  it('notifica los cambios y el store los refleja sin el token', async () => {
    const s = gestor();
    const vistos: string[] = [];
    const desuscribir = s.suscribir((e) => vistos.push(e.modo));
    const store = crearStoreSesion(s);
    expect(store.getState().modo).toBe('sin_sesion');

    await store.getState().iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(store.getState()).toMatchObject({ modo: 'online', usuario: { id: ana.id } });
    const token = await s.obtenerAccessToken();
    expect(JSON.stringify(store.getState())).not.toContain(token);
    expect(s.usuarioDeLaSesion()?.id).toBe(ana.id);

    await store.getState().cerrarSesion();
    expect(store.getState().usuario).toBeNull();
    await store.getState().restaurar();
    desuscribir();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    expect(vistos).toEqual(['online', 'sin_sesion']);
    expect(Object.isFrozen(s.estado())).toBe(true);
  });
});

describe('nombreDispositivo', () => {
  it('reconoce el navegador', () => {
    expect(nombreDispositivo(CHROME)).toBe('Tablet · Chrome');
    expect(nombreDispositivo('Mozilla/5.0 (iPad) Version/17.0 Mobile/15E148 Safari/604.1')).toBe(
      'Tablet · Safari',
    );
    expect(nombreDispositivo('... Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Tablet · Edge');
    expect(nombreDispositivo('Mozilla/5.0 Firefox/130.0')).toBe('Tablet · Firefox');
    expect(nombreDispositivo('SamsungBrowser/25.0 Chrome/121 Safari/537.36')).toBe(
      'Tablet · Samsung Internet',
    );
    expect(nombreDispositivo('')).toBe('Tablet · Navegador');
  });
});

describe('marcarRequiereContrasena (AUTOR_NO_COINCIDE en la sync)', () => {
  it('descarta el token, pasa a offline y pide la contraseña', async () => {
    const s = gestor();
    await s.iniciarSesion('ana@catmetal.co', CLAVE_ANA);
    s.marcarRequiereContrasena();
    expect(s.estado()).toMatchObject({ modo: 'offline', requiere_contrasena: true });
    expect(await s.obtenerAccessToken()).toBeNull();
    expect(servidor.peticionesA('/api/v1/auth/refresh')).toHaveLength(0);
  });
});

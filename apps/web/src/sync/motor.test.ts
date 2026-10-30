import { MENSAJES_ERROR, permisosDeRol, uuidv7, type Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { crearClienteApi } from '../auth/cliente-api';
import type { EstadoSesion } from '../auth/sesion';
import { leerMetaSync } from '../datos/aplicar-cambios';
import { db } from '../datos/db';
import {
  contarPendientes,
  editarConsumoLocal,
  registrarConsumoConNovedadLocal,
  registrarConsumoLocal,
} from '../datos/outbox';
import { fotoDe, guardarPerfil, limpiarDb } from '../datos/pruebas/fabricas';
import { crearStoreEstadoSync, textoIndicador, type StoreEstadoSync } from './estado';
import { MotorSync, type SesionParaSync } from './motor';
import { crearServidorSync, type ServidorSync } from './pruebas/servidor-sync';

const ORDEN = uuidv7();

function perfil(nombre: string): Perfil {
  const id = uuidv7();
  return {
    id,
    nombre,
    email: `${id}@catmetal.co`,
    rol: 'supervisor',
    permisos: permisosDeRol('supervisor'),
  };
}

interface SesionFalsa extends SesionParaSync {
  usuario: Perfil | null;
  modo: EstadoSesion['modo'];
  requiere: boolean;
  /** Token distinto del de la sesión (para simular sesiones que no coinciden). */
  token: string | null;
}

function sesionFalsa(servidor: ServidorSync, usuario: Perfil | null): SesionFalsa {
  const s: SesionFalsa = {
    usuario,
    modo: 'online',
    requiere: false,
    token: null,
    estado: () => ({
      modo: s.usuario === null ? 'sin_sesion' : s.modo,
      usuario: s.usuario,
      permisos: s.usuario?.permisos ?? [],
      device_id: null,
      requiere_contrasena: s.requiere,
      bloqueada: false,
    }),
    usuarioDeLaSesion: () => s.usuario,
    obtenerAccessToken: () =>
      Promise.resolve(
        s.usuario === null || s.modo !== 'online' || s.requiere
          ? null
          : (s.token ?? `tok-${s.usuario.id}`),
      ),
    marcarRequiereContrasena: () => {
      s.requiere = true;
      s.modo = 'offline';
    },
    api: crearClienteApi({
      fetch: (entrada, init) => servidor.fetch(entrada, init),
      proveedor: {
        obtenerAccessToken: () => s.obtenerAccessToken(),
        refrescar: () => Promise.resolve(null),
      },
    }),
  };
  return s;
}

let servidor: ServidorSync;
let reloj: number;
let estado: StoreEstadoSync;
let ana: Perfil;
let beto: Perfil;

function motor(sesion: SesionParaSync, opciones: { locks?: null } = {}): MotorSync {
  return new MotorSync({
    sesion,
    estado,
    locks: opciones.locks ?? null,
    ahora: () => reloj,
    aleatorio: () => 0,
    candado: { intervaloMs: 2 },
  });
}

function consumo(base: Record<string, unknown> = {}) {
  return {
    order_id: ORDEN,
    material_id: uuidv7(),
    cantidad: 5,
    unidad: 'kg' as const,
    lote: 'L-1',
    ...base,
  };
}

function rutas(): string[] {
  return servidor.peticiones.map((p) => `${p.metodo} ${p.ruta}`);
}

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorSync();
  reloj = Date.now();
  estado = crearStoreEstadoSync();
  ana = perfil('Ana Gómez');
  beto = perfil('Beto Ruiz');
  await guardarPerfil(ana.id, ana.nombre);
});

describe('push, pull y fotos', () => {
  it('3 consumos offline (uno con foto): se aplican y la foto se sube después de su novedad', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const conFoto = await registrarConsumoConNovedadLocal(
      ana.id,
      consumo(),
      { tipo: 'merma', descripcion: 'Arena húmeda' },
      [fotoDe('abc')],
    );
    await registrarConsumoLocal(ana.id, consumo());

    const resumen = await motor(sesionFalsa(servidor, ana)).sincronizar('online');
    expect(resumen).toMatchObject({
      ejecutada: true,
      lotes: 1,
      enviadas: 4,
      aplicadas: 4,
      rechazadas: 0,
      fotos_subidas: 1,
      error: null,
    });
    expect(servidor.entidades('consumptions')).toHaveLength(3);
    expect(servidor.entidades('incidents')).toHaveLength(1);
    const [foto] = await db.evidencias.toArray();
    expect(servidor.fotosSubidas()).toEqual([foto!.id]);
    expect(foto).toMatchObject({ estado_subida: 'subida' });
    // Orden: push (con la novedad) → snapshot/pull → PUT de la foto.
    const orden = rutas();
    expect(orden.indexOf('POST /api/v1/sync/push')).toBeLessThan(
      orden.indexOf(`PUT /api/v1/evidences/${foto!.id}`),
    );
    expect(await db.consumos.get([ana.id, conFoto.consumo_id])).toMatchObject({
      estado_local: 'sincronizado',
    });
    expect(await contarPendientes(ana.id)).toBe(0);
    expect(textoIndicador(estado.getState())).toBe('En línea · Todo sincronizado');
    expect(estado.getState().ultimoSync).toBe(new Date(reloj).toISOString());
    const eventos = await db.trazabilidad.toArray();
    expect(eventos.map((e) => e.descripcion)).toContain(
      'sincronizó 4 registros y 1 foto (auto-sync)',
    );
  });

  it('60 mutaciones salen en 3 lotes (25, 25, 10) y en orden', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      ids.push((await registrarConsumoLocal(ana.id, consumo({ lote: `L-${i}` }))).mutation_id);
    }
    const resumen = await motor(sesionFalsa(servidor, ana)).sincronizar('manual');
    const lotes = servidor.mutacionesPorPush();
    expect(lotes.map((l) => l.length)).toEqual([25, 25, 10]);
    expect(lotes.flat()).toEqual(ids);
    expect(resumen).toMatchObject({ lotes: 3, aplicadas: 60 });
    expect(
      servidor.pushes().every((p) => (p.cuerpo as { user_id: string }).user_id === ana.id),
    ).toBe(true);
    expect((await db.trazabilidad.toArray()).at(-1)?.descripcion).toBe(
      'sincronizó 60 registros (manual)',
    );
  });

  it('el primer arranque usa el snapshot inicial y guarda su cursor y época', async () => {
    servidor.upsert('materials', 'm1', {
      id: 'm1',
      codigo: 'MP-1',
      nombre: 'Arena',
      unidad: 'kg',
      costo_unitario_cop: 1,
      activo: true,
    });
    servidor.tamSnapshot = 1;
    servidor.upsert('materials', 'm2', {
      id: 'm2',
      codigo: 'MP-2',
      nombre: 'Coque',
      unidad: 'kg',
      costo_unitario_cop: 1,
      activo: true,
    });
    const resumen = await motor(sesionFalsa(servidor, ana)).sincronizar('apertura');
    expect(resumen.paginas_snapshot).toBe(2);
    expect(await db.materiales.count()).toBe(2);
    expect(await leerMetaSync(ana.id)).toMatchObject({ cursor: 2, epoca: 'epoca-1' });
    // Tras el snapshot, un pull desde su cursor (no se recorre el audit_log desde 0).
    const pulls = servidor.peticiones.filter((p) => p.ruta === '/api/v1/sync/pull');
    expect(pulls.map((p) => p.query.get('cursor'))).toEqual(['2']);
  });

  it('pull con hay_mas en varias rondas', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('apertura');
    servidor.tamPull = 2;
    for (let i = 0; i < 5; i += 1) {
      servidor.upsert('users', `u${i}`, { id: `u${i}`, nombre: `Usuario ${i}` });
    }
    const resumen = await m.sincronizar('intervalo');
    const pulls = servidor.peticiones.filter((p) => p.ruta === '/api/v1/sync/pull');
    expect(pulls.slice(1).map((p) => p.query.get('cursor'))).toEqual(['0', '2', '4']);
    expect(resumen.cambios).toBe(5);
    expect(await db.usuarios.count()).toBe(5);
    expect((await leerMetaSync(ana.id)).cursor).toBe(5);
  });

  it('hidratar pide el snapshot de la orden', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('apertura');
    const otraOrden = uuidv7();
    const ajeno = {
      id: uuidv7(),
      order_id: otraOrden,
      material_id: uuidv7(),
      cantidad: 3,
      unidad: 'kg',
      lote: 'X',
      registrado_por: beto.id,
      client_created_at: '2026-10-29T15:00:00.000Z',
      estado: 'pendiente',
      version: 1,
    };
    servidor.upsert('consumptions', ajeno.id, ajeno, false);
    servidor.agregarCambio('hidratar', 'production_orders', otraOrden);
    await m.sincronizar('intervalo');
    const snapshot = servidor.peticiones.find(
      (p) => p.ruta === '/api/v1/sync/snapshot' && p.query.get('alcance') === 'orden',
    );
    expect(snapshot?.query.get('order_id')).toBe(otraOrden);
    expect(await db.consumos.get([ana.id, ajeno.id])).toBeDefined();
    expect((await leerMetaSync(ana.id)).acciones).toEqual([]);
  });

  it('cambio de época: snapshot completo y reenvío de las aplicadas conservadas', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id, mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    expect(servidor.entidades('consumptions')).toHaveLength(1);

    servidor.restaurar('epoca-2');
    expect(servidor.entidades('consumptions')).toHaveLength(0);
    const resumen = await m.sincronizar('intervalo');
    expect(resumen).toMatchObject({ epoca_cambiada: true, aplicadas: 1, error: null });
    expect(servidor.entidades('consumptions').map((c) => c.id)).toEqual([id]);
    expect(servidor.mutacionesPorPush().at(-1)).toEqual([mutation_id]);
    const inicial = servidor.peticiones.filter(
      (p) => p.ruta === '/api/v1/sync/snapshot' && p.query.get('alcance') === 'inicial',
    );
    expect(inicial).toHaveLength(2);
    expect(await leerMetaSync(ana.id)).toMatchObject({ epoca: 'epoca-2', acciones: [] });
    expect(await db.outbox.get(mutation_id)).toMatchObject({ estado: 'aplicada' });
  });
});

describe('hora del dispositivo al enviar (ADR 0019, M2)', () => {
  it('cada push lleva enviado_at calculado justo antes de su fetch (también al reenviar) y no se guarda', async () => {
    for (let i = 0; i < 30; i += 1) {
      await registrarConsumoLocal(ana.id, consumo({ lote: `L-${i}` }));
    }
    reloj = Date.parse('2026-10-30T12:00:00.000Z');
    // Cada petición que llega al servidor adelanta el reloj del dispositivo 1 minuto.
    servidor.alRecibir = () => {
      reloj += 60_000;
    };
    servidor.perderRespuestaPush = 1;
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('online');
    await m.sincronizar('intervalo');
    const pushes = servidor.pushes();
    expect(pushes.length).toBeGreaterThanOrEqual(3);
    const horas = pushes.map((p) => (p.cuerpo as { enviado_at?: unknown }).enviado_at);
    // La hora de cada envío es la del reloj en ese momento (antes de que el servidor lo adelante).
    for (const hora of horas) {
      expect(typeof hora).toBe('string');
      expect(hora).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(new Set(horas).size).toBe(horas.length);
    expect(horas[0]).toBe('2026-10-30T12:00:00.000Z');
    // El reenvío del lote cuya respuesta se perdió (mismas mutaciones) lleva una hora nueva.
    const lotes = servidor.mutacionesPorPush().map((ids) => ids.join(','));
    const reenvio = lotes.findIndex((ids, i) => i > 0 && ids === lotes[0]);
    expect(reenvio).toBeGreaterThan(0);
    expect(horas[reenvio]).not.toBe(horas[0]);
    // Nunca se guarda en el outbox.
    expect(JSON.stringify(await db.outbox.toArray())).not.toContain('enviado_at');
  });
});

describe('robustez', () => {
  it('un rechazo no bloquea a las siguientes; la dependiente queda DEPENDENCIA_RECHAZADA', async () => {
    const malo = await registrarConsumoConNovedadLocal(ana.id, consumo({ lote: 'MALO' }), {
      tipo: 'otro',
      descripcion: 'x',
    });
    const bueno = await registrarConsumoLocal(ana.id, consumo());
    servidor.reglaRechazo = (m) =>
      m.tipo === 'consumo.crear' && m.payload.lote === 'MALO' ? 'UNIDAD_INCOMPATIBLE' : null;

    const resumen = await motor(sesionFalsa(servidor, ana)).sincronizar('online');
    expect(resumen).toMatchObject({ aplicadas: 1, rechazadas: 2 });
    expect(await db.outbox.get(malo.mutation_ids[1])).toMatchObject({
      estado: 'rechazada',
      error: { code: 'DEPENDENCIA_RECHAZADA' },
    });
    expect(await db.outbox.get(bueno.mutation_id)).toMatchObject({ estado: 'aplicada' });
    expect(await db.consumos.get([ana.id, malo.consumo_id])).toMatchObject({
      estado_local: 'rechazado_sync',
      error_sync: { code: 'UNIDAD_INCOMPATIBLE' },
    });
    expect(estado.getState()).toMatchObject({ rechazados: 2, pendientes: 0 });
  });

  it('respuesta perdida: el reenvío no duplica y queda aplicada', async () => {
    const { mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    servidor.perderRespuestaPush = 1;
    const m = motor(sesionFalsa(servidor, ana));
    const primero = await m.sincronizar('online');
    expect(primero).toMatchObject({ sin_resultado: 1, error: { code: null } });
    expect(estado.getState().conexion).toBe('sin_conexion');
    expect(textoIndicador(estado.getState())).toBe('Sin conexión · 1 por sincronizar');
    expect(servidor.entidades('consumptions')).toHaveLength(1);

    reloj += 5_000;
    const segundo = await m.sincronizar('intervalo');
    expect(segundo).toMatchObject({ aplicadas: 1, error: null });
    expect(servidor.entidades('consumptions')).toHaveLength(1);
    expect(await db.outbox.get(mutation_id)).toMatchObject({ estado: 'aplicada', intentos: 2 });
  });

  it('503: backoff; no reintenta antes de tiempo y luego sí', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    servidor.push503 = 1;
    const m = motor(sesionFalsa(servidor, ana));
    const primero = await m.sincronizar('online');
    expect(primero.error).toMatchObject({ code: 'ERROR_INTERNO' });
    expect(primero.siguiente_intento_at).toBe(new Date(reloj + 1_000).toISOString());

    await m.sincronizar('intervalo');
    expect(servidor.pushes()).toHaveLength(1);
    reloj += 1_000;
    const tercero = await m.sincronizar('intervalo');
    expect(tercero.aplicadas).toBe(1);
    expect(servidor.pushes()).toHaveLength(2);
  });

  it('una respuesta de push malformada se trata como sin resultado', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionFalsa(servidor, ana);
    const original = servidor.fetch;
    servidor.fetch = async (entrada, init) =>
      String(init?.method) === 'POST'
        ? new Response('{"resultados":"no"}', { status: 200 })
        : original(entrada, init);
    const resumen = await motor(s).sincronizar('online');
    expect(resumen).toMatchObject({ sin_resultado: 1, error: { code: 'ERROR_INTERNO' } });
    expect(await contarPendientes(ana.id)).toBe(1);
  });

  it('AUTOR_NO_COINCIDE detiene la sync y pide contraseña', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionFalsa(servidor, ana);
    s.token = `tok-${beto.id}`; // la sesión del servidor es de otra persona
    const m = motor(s);
    const resumen = await m.sincronizar('online');
    expect(resumen.error).toMatchObject({ code: 'AUTOR_NO_COINCIDE' });
    expect(s.requiere).toBe(true);
    expect(await contarPendientes(ana.id)).toBe(1);
    expect(await m.sincronizar('intervalo')).toMatchObject({
      ejecutada: false,
      omitida: 'requiere_contrasena',
    });
    expect(servidor.pushes()).toHaveLength(1);
  });

  it('401 persistente (refresh sin éxito) detiene la sync', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionFalsa(servidor, ana);
    s.token = 'tok-invalido';
    const resumen = await motor(s).sincronizar('online');
    expect(resumen.error).toMatchObject({ code: 'NO_AUTENTICADO' });
    expect(servidor.peticiones.filter((p) => p.ruta !== '/api/v1/sync/push')).toHaveLength(0);
  });

  it('una edición en conflicto se cuenta y no detiene la sync', async () => {
    const { id } = await registrarConsumoLocal(ana.id, consumo());
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('online');
    const actual = servidor.entidades('consumptions')[0]!;
    servidor.upsert('consumptions', id, { ...actual, version: 5 }, false);
    await editarConsumoLocal(ana.id, { id, cantidad: 9 });
    const resumen = await m.sincronizar('manual');
    expect(resumen).toMatchObject({ conflictos: 1, error: null });
    expect(estado.getState().conflictos).toBe(1);
  });
});

describe('partición y candado', () => {
  it('con la sesión de B no se envía nada de A', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const deBeto = await registrarConsumoLocal(beto.id, consumo());
    await motor(sesionFalsa(servidor, beto)).sincronizar('online');
    expect(servidor.mutacionesPorPush()).toEqual([[deBeto.mutation_id]]);
    expect(await contarPendientes(ana.id)).toBe(1);
  });

  it('si la sesión cambia a mitad de la sync, se detiene sin enviar más', async () => {
    for (let i = 0; i < 30; i += 1) {
      await registrarConsumoLocal(ana.id, consumo());
    }
    const s = sesionFalsa(servidor, ana);
    servidor.alRecibir = (p) => {
      if (p.ruta === '/api/v1/sync/push') {
        s.usuario = beto; // otra persona inicia sesión en la tablet
      }
    };
    const resumen = await motor(s).sincronizar('online');
    expect(servidor.pushes()).toHaveLength(1);
    expect(resumen.error).toMatchObject({ code: 'AUTOR_NO_COINCIDE' });
    // F4-05: la respuesta llegó cuando la sesión ya era de Beto, así que no se escribe nada en la
    // partición de Ana (antes se aplicaban los 25 resultados y quedaban 5): el lote sigue
    // `enviando` y nada de lo que llegue con otra sesión toca sus datos.
    expect(await contarPendientes(ana.id)).toBe(30);
    expect(await db.outbox.where('estado').equals('enviando').count()).toBe(25);

    // Cuando Ana vuelve, el lote sale de nuevo y el servidor (idempotente) no duplica nada.
    servidor.alRecibir = null;
    s.usuario = ana;
    const otra = await motor(s).sincronizar('manual');
    expect(otra.error).toBeNull();
    expect(await contarPendientes(ana.id)).toBe(0);
    expect(servidor.entidades('consumptions')).toHaveLength(30);
  });

  it('dos sincronizar() simultáneos en la pestaña hacen un solo push', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const m = motor(sesionFalsa(servidor, ana));
    const [uno, dos] = await Promise.all([m.sincronizar('online'), m.sincronizar('manual')]);
    expect(uno).toBe(dos);
    expect(servidor.pushes()).toHaveLength(1);
  });

  it('dos pestañas (dos motores) nunca sincronizan a la vez', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    let activas = 0;
    let maximo = 0;
    const original = servidor.fetch;
    servidor.fetch = async (entrada, init) => {
      activas += 1;
      maximo = Math.max(maximo, activas);
      try {
        await new Promise((r) => setTimeout(r, 3));
        return await original(entrada, init);
      } finally {
        activas -= 1;
      }
    };
    await Promise.all([
      motor(sesionFalsa(servidor, ana)).sincronizar('online'),
      motor(sesionFalsa(servidor, ana)).sincronizar('online'),
    ]);
    expect(servidor.pushes()).toHaveLength(1);
    expect(maximo).toBe(1);
  });

  it('repite una vez si se registró algo mientras sincronizaba', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const m = motor(sesionFalsa(servidor, ana));
    let registrado = false;
    servidor.alRecibir = (p) => {
      if (p.ruta === '/api/v1/sync/pull' && !registrado) {
        registrado = true;
        void registrarConsumoLocal(ana.id, consumo());
        void m.sincronizar('local');
      }
    };
    await m.sincronizar('online');
    expect(servidor.pushes()).toHaveLength(2);
    expect(await contarPendientes(ana.id)).toBe(0);
  });

  it('precondiciones: sin sesión, offline, contraseña requerida o sin token no tocan la red', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionFalsa(servidor, null);
    const m = motor(s);
    expect((await m.sincronizar('online')).omitida).toBe('sin_sesion');
    s.usuario = ana;
    s.modo = 'offline';
    expect((await m.sincronizar('online')).omitida).toBe('offline');
    s.modo = 'online';
    s.requiere = true;
    expect((await m.sincronizar('online')).omitida).toBe('requiere_contrasena');
    s.requiere = false;
    s.obtenerAccessToken = () => Promise.resolve(null);
    expect((await m.sincronizar('online')).omitida).toBe('sin_token');
    expect(servidor.peticiones).toHaveLength(0);
    expect(estado.getState().pendientes).toBe(1);
  });
});

describe('fotos', () => {
  async function conFoto(): Promise<string> {
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('abc'),
    ]);
    return (await db.evidencias.toArray())[0]!.id;
  }

  it('EVIDENCIA_DESCONOCIDA → reintento más tarde, sin bloquear los registros', async () => {
    const id = await conFoto();
    servidor.evidenciaDesconocida = 1;
    const m = motor(sesionFalsa(servidor, ana));
    const primero = await m.sincronizar('online');
    expect(primero).toMatchObject({ aplicadas: 2, fotos_subidas: 0, fotos_con_error: 1 });
    expect(await db.evidencias.get([ana.id, id])).toMatchObject({
      estado_subida: 'pendiente',
      error_subida: { code: 'EVIDENCIA_DESCONOCIDA' },
    });
    expect(textoIndicador(estado.getState())).toBe('En línea · 1 por sincronizar');

    await m.sincronizar('intervalo');
    const puts = () => servidor.peticiones.filter((p) => p.metodo === 'PUT');
    expect(puts()).toHaveLength(1);
    reloj += 2_000;
    expect((await m.sincronizar('intervalo')).fotos_subidas).toBe(1);
    expect(puts()).toHaveLength(2);
    expect(servidor.fotosSubidas()).toEqual([id]);
  });

  it('error permanente (415) o EVIDENCIA_YA_SUBIDA: se bloquea sin reintentar y conserva los bytes', async () => {
    const id = await conFoto();
    servidor.errorEvidencia = 'EVIDENCIA_TIPO_INVALIDO';
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('online');
    const foto = await db.evidencias.get([ana.id, id]);
    expect(foto).toMatchObject({
      estado_subida: 'bloqueada',
      error_subida: {
        code: 'EVIDENCIA_TIPO_INVALIDO',
        message: MENSAJES_ERROR.EVIDENCIA_TIPO_INVALIDO,
      },
    });
    expect(foto?.datos).not.toBeNull();
    reloj += 600_000;
    await m.sincronizar('intervalo');
    expect(servidor.peticiones.filter((p) => p.metodo === 'PUT')).toHaveLength(1);

    await db.evidencias.update([ana.id, id], { estado_subida: 'pendiente' });
    servidor.errorEvidencia = 'EVIDENCIA_YA_SUBIDA';
    await m.sincronizar('manual');
    expect((await db.evidencias.get([ana.id, id]))?.estado_subida).toBe('bloqueada');
  });

  it('sin red al subir: reprograma y no intenta las demás fotos', async () => {
    await registrarConsumoConNovedadLocal(ana.id, consumo(), { tipo: 'merma', descripcion: 'x' }, [
      fotoDe('uno'),
      fotoDe('dos'),
    ]);
    let intentosPut = 0;
    const original = servidor.fetch;
    servidor.fetch = async (entrada, init) => {
      if (init?.method === 'PUT') {
        intentosPut += 1;
        throw new TypeError('Failed to fetch');
      }
      return original(entrada, init);
    };
    const resumen = await motor(sesionFalsa(servidor, ana)).sincronizar('online');
    expect(resumen).toMatchObject({ fotos_con_error: 1, fotos_subidas: 0 });
    expect(intentosPut).toBe(1);
  });
});

describe('casos límite', () => {
  it('el servidor se detiene a mitad del lote: lo aplicado queda y el resto espera su backoff', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await registrarConsumoLocal(ana.id, consumo())).mutation_id);
    }
    servidor.transitorioEnIndice = 1;
    const m = motor(sesionFalsa(servidor, ana));
    const resumen = await m.sincronizar('online');
    expect(resumen).toMatchObject({ aplicadas: 1, sin_resultado: 2, lotes: 1, error: null });
    expect(resumen.siguiente_intento_at).not.toBeNull();
    expect(await db.outbox.get(ids[0]!)).toMatchObject({ estado: 'aplicada' });
    expect(await db.outbox.get(ids[1]!)).toMatchObject({ estado: 'pendiente' });
    reloj += 1_000;
    expect((await m.sincronizar('intervalo')).aplicadas).toBe(2);
    expect(servidor.mutacionesPorPush()[1]).toEqual(ids.slice(1));
  });

  it('la época cambia durante un snapshot: reinicia otra vez y termina con la época nueva', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    servidor.agregarCambio('reiniciar', 'users', ana.id);
    servidor.alRecibir = (p) => {
      if (p.ruta === '/api/v1/sync/snapshot' && servidor.epoca === 'epoca-1') {
        servidor.restaurar('epoca-2');
      }
    };
    const resumen = await m.sincronizar('intervalo');
    expect(resumen).toMatchObject({ epoca_cambiada: true, error: null, aplicadas: 1 });
    expect(await leerMetaSync(ana.id)).toMatchObject({ epoca: 'epoca-2', acciones: [] });
    expect(servidor.entidades('consumptions')).toHaveLength(1);
  });

  it('un defecto inesperado se propaga (no se oculta como error de red)', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    const s = sesionFalsa(servidor, ana);
    const m = motor(s);
    let llamadas = 0;
    const usuarioOriginal = s.usuario;
    s.usuarioDeLaSesion = () => {
      llamadas += 1;
      if (llamadas > 3) {
        throw new RangeError('defecto');
      }
      return usuarioOriginal;
    };
    await expect(m.sincronizar('online')).rejects.toThrow('defecto');
    expect(estado.getState().sincronizando).toBe(false);
  });
});

describe('indicador global durante la sync', () => {
  it('pasa por "Sincronizando…" y termina con el conteo real', async () => {
    await registrarConsumoLocal(ana.id, consumo());
    await registrarConsumoLocal(ana.id, consumo());
    const textos: string[] = [];
    const desuscribir = estado.subscribe((e) => textos.push(textoIndicador(e)));
    await motor(sesionFalsa(servidor, ana)).sincronizar('manual');
    desuscribir();
    expect(textos).toContain('Sincronizando…');
    expect(textos.at(-1)).toBe('En línea · Todo sincronizado');
    expect(textos).not.toContain('En línea · 2 por sincronizar');
  });
});

describe('snapshot en un área temporal (M5) y autoridad del servidor (M6)', () => {
  const M1 = uuidv7();
  const M2 = uuidv7();

  function material(id: string, nombre: string): Record<string, unknown> {
    return {
      id,
      codigo: `MP-${nombre}`,
      nombre,
      unidad: 'kg',
      costo_unitario_cop: 1,
      activo: true,
    };
  }

  function orden(id: string, codigo: string): Record<string, unknown> {
    return {
      id,
      codigo,
      linea: 'Fundición',
      estado: 'en_proceso',
      fecha_inicio: null,
      fecha_fin: null,
      creada_por: uuidv7(),
      created_at: '2026-10-29T12:00:00.000Z',
      updated_at: '2026-10-29T12:00:00.000Z',
    };
  }

  function catalogoInicial(): void {
    servidor.upsert('production_orders', ORDEN, orden(ORDEN, 'OP-1'));
    servidor.upsert('materials', M1, material(M1, 'Arena'));
    servidor.upsert('materials', M2, material(M2, 'Coque'));
    servidor.upsert('order_supervisors', `${ORDEN}:${ana.id}`, {
      order_id: ORDEN,
      user_id: ana.id,
      activo: true,
    });
  }

  function snapshotsInicial(): URLSearchParams[] {
    return servidor.peticiones
      .filter((p) => p.ruta === '/api/v1/sync/snapshot' && p.query.get('alcance') === 'inicial')
      .map((p) => p.query);
  }

  it('M5: la red se cae a mitad del snapshot tras una restauración; se conserva todo, se registra offline y luego se reanuda', async () => {
    catalogoInicial();
    const sesion = sesionFalsa(servidor, ana);
    const m = motor(sesion);
    await m.sincronizar('apertura');
    expect(await db.ordenes.count()).toBe(1);
    expect(await db.materiales.count()).toBe(2);
    expect(await db.asignaciones.count()).toBe(1);
    const antes = await leerMetaSync(ana.id);

    servidor.restaurar('epoca-2');
    servidor.upsert('materials', M2, material(M2, 'Coque fino'));
    servidor.tamSnapshot = 1;
    servidor.fallarSnapshotEnPagina = 2;
    const resumen = await m.sincronizar('intervalo');
    expect(resumen.error).toMatchObject({ code: null });
    expect(resumen.paginas_snapshot).toBe(1);

    // Nada del estado anterior se perdió: órdenes, materiales y asignaciones siguen disponibles.
    expect(await db.ordenes.get([ana.id, ORDEN])).toMatchObject({ codigo: 'OP-1' });
    expect(await db.materiales.count()).toBe(2);
    expect(await db.materiales.get([ana.id, M2])).toMatchObject({ nombre: 'Coque' });
    expect(await db.asignaciones.count()).toBe(1);
    // El cursor y la época solo cambian con el reemplazo completo.
    expect(await leerMetaSync(ana.id)).toMatchObject({
      cursor: antes.cursor,
      epoca: 'epoca-1',
      requiere_snapshot: true,
    });

    // Sin conexión, el supervisor sigue registrando contra los catálogos que tiene.
    sesion.modo = 'offline';
    const registro = await registrarConsumoLocal(ana.id, consumo({ material_id: M1 }));
    expect(await db.outbox.get(registro.mutation_id)).toMatchObject({ estado: 'pendiente' });
    expect(await m.sincronizar('local')).toMatchObject({ ejecutada: false, omitida: 'offline' });

    // Al volver la red se reanuda desde la página guardada (no desde cero) y se reemplaza todo.
    sesion.modo = 'online';
    const desde = snapshotsInicial().length;
    const segunda = await m.sincronizar('online');
    expect(segunda).toMatchObject({ error: null, epoca_cambiada: true, aplicadas: 1 });
    const reanudadas = snapshotsInicial().slice(desde);
    expect(reanudadas[0]?.get('pagina')).not.toBeNull();
    expect(reanudadas).toHaveLength(3);
    expect(await db.materiales.get([ana.id, M2])).toMatchObject({ nombre: 'Coque fino' });
    expect(await db.ordenes.count()).toBe(1);
    expect(await leerMetaSync(ana.id)).toMatchObject({
      epoca: 'epoca-2',
      requiere_snapshot: false,
      acciones: [],
    });
    expect(servidor.entidades('consumptions').map((c) => c.id)).toEqual([registro.id]);
    expect(await db.outbox.get(registro.mutation_id)).toMatchObject({ estado: 'aplicada' });
  });

  it('M5: un token de página rechazado al reanudar vuelve a empezar desde la primera página', async () => {
    catalogoInicial();
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('apertura');
    servidor.restaurar('epoca-2');
    servidor.tamSnapshot = 1;
    servidor.fallarSnapshotEnPagina = 3;
    expect((await m.sincronizar('intervalo')).error).toMatchObject({ code: null });

    servidor.rechazarPaginaSnapshot = 1;
    const desde = snapshotsInicial().length;
    expect((await m.sincronizar('intervalo')).error).toBeNull();
    const pedidas = snapshotsInicial().slice(desde);
    expect(pedidas[0]?.get('pagina')).not.toBeNull();
    expect(pedidas[1]?.get('pagina')).toBeNull();
    expect(await db.materiales.count()).toBe(2);
    expect(await leerMetaSync(ana.id)).toMatchObject({ epoca: 'epoca-2', acciones: [] });
  });

  it('M5: con el tope de páginas agotado, la siguiente sync reanuda en lugar de empezar de cero', async () => {
    catalogoInicial();
    const m = new MotorSync({
      sesion: sesionFalsa(servidor, ana),
      estado,
      locks: null,
      ahora: () => reloj,
      aleatorio: () => 0,
      maxPaginasSnapshot: 2,
    });
    servidor.tamSnapshot = 1;
    const primera = await m.sincronizar('apertura');
    expect(primera.error).toMatchObject({ code: 'ERROR_INTERNO' });
    expect(await db.materiales.count()).toBe(0);
    const segunda = await m.sincronizar('intervalo');
    expect(segunda.error).toBeNull();
    expect(snapshotsInicial().map((q) => q.get('pagina') === null)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(await db.materiales.count()).toBe(2);
    expect(await db.ordenes.count()).toBe(1);
  });

  it('M6: tras una restauración, el consumo propio aprobado vuelve a pendiente y la validación que el servidor ya no tiene desaparece', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id, mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    const creado = { ...servidor.entidades('consumptions')[0]! };
    // El jefe aprueba en línea: el servidor escribe la validación y el consumo v2.
    const validacionId = uuidv7();
    servidor.upsert('validations', validacionId, {
      id: validacionId,
      consumption_id: id,
      decision: 'aprobado',
      motivo: null,
      validado_por: uuidv7(),
      client_created_at: '2026-10-29T16:00:00.000Z',
      server_received_at: '2026-10-29T16:00:01.000Z',
      created_at: '2026-10-29T16:00:01.000Z',
      updated_at: '2026-10-29T16:00:01.000Z',
    });
    servidor.upsert('consumptions', id, { ...creado, estado: 'aprobado', version: 2 });
    await m.sincronizar('intervalo');
    expect(await db.consumos.get([ana.id, id])).toMatchObject({
      estado_local: 'aprobado',
      version: 2,
    });

    // La creación ya salió de la retención: nada propio pendiente sobre este consumo.
    await db.outbox.delete(mutation_id);
    // Restauración a un punto anterior a la aprobación.
    servidor.restaurar('epoca-2');
    servidor.upsert('consumptions', id, { ...creado }, false);
    const resumen = await m.sincronizar('intervalo');
    expect(resumen).toMatchObject({ error: null, epoca_cambiada: true });
    expect(await db.consumos.get([ana.id, id])).toMatchObject({
      estado_local: 'sincronizado',
      version: 1,
      servidor: { estado: 'pendiente', version: 1 },
      perdido_en_restauracion: false,
    });
    expect(await db.validaciones.get([ana.id, validacionId])).toBeUndefined();
  });

  it('M6: con la creación aún en retención, se reenvía y termina con el estado del servidor', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id, mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    const creado = { ...servidor.entidades('consumptions')[0]! };
    servidor.upsert('consumptions', id, { ...creado, estado: 'aprobado', version: 2 });
    await m.sincronizar('intervalo');
    expect(await db.consumos.get([ana.id, id])).toMatchObject({ estado_local: 'aprobado' });

    servidor.restaurar('epoca-2');
    const resumen = await m.sincronizar('intervalo');
    expect(resumen).toMatchObject({ error: null, epoca_cambiada: true, aplicadas: 1 });
    expect(await db.outbox.get(mutation_id)).toMatchObject({ estado: 'aplicada' });
    expect(await db.consumos.get([ana.id, id])).toMatchObject({
      estado_local: 'sincronizado',
      version: 1,
      servidor: { estado: 'pendiente', version: 1 },
    });
  });
});

// Correcciones del cliente por la revisión del protocolo de la Fase 3 (A1, A2, M1, M4, B4) y la
// ADR 0016, contra el servidor de sync falso alineado con el real.

import { MENSAJES_ERROR, uuidv7, type Perfil } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { leerMetaSync } from '../datos/aplicar-cambios';
import { db } from '../datos/db';
import {
  borrarDatosDeUsuario,
  contarPendientes,
  editarConsumoLocal,
  mutacionesAtascadas,
  purgarAplicadasAntiguas,
  registrarConsumoLocal,
  registrarNovedadLocal,
  reenviarPerdido,
} from '../datos/outbox';
import { guardarPerfil, limpiarDb } from '../datos/pruebas/fabricas';
import { crearStoreEstadoSync, type StoreEstadoSync } from './estado';
import { MotorSync, type SesionParaSync } from './motor';
import { urlDe } from '../auth/pruebas/servidor-falso';
import { perfilFalso, sesionFalsa } from './pruebas/sesion-falsa';
import { crearServidorSync, type ServidorSync } from './pruebas/servidor-sync';

const ORDEN = uuidv7();
const DIA = 86_400_000;

let servidor: ServidorSync;
let reloj: number;
let estado: StoreEstadoSync;
let ana: Perfil;

function motor(sesion: SesionParaSync, extra: { maxPaginasSnapshot?: number } = {}): MotorSync {
  return new MotorSync({
    sesion,
    estado,
    locks: null,
    ahora: () => reloj,
    aleatorio: () => 0,
    candado: { intervaloMs: 2 },
    ...extra,
  });
}

function consumo() {
  return {
    order_id: ORDEN,
    material_id: uuidv7(),
    cantidad: 5,
    unidad: 'kg' as const,
    lote: 'L-1',
  };
}

function pushes(): number {
  return servidor.pushes().length;
}

beforeEach(async () => {
  await limpiarDb();
  servidor = crearServidorSync();
  reloj = Date.now();
  estado = crearStoreEstadoSync();
  ana = perfilFalso('Ana Gómez');
  await guardarPerfil(ana.id, ana.nombre);
});

describe('A1: época en el sobre del push', () => {
  it('envía la época conocida (y la omite antes del primer pull)', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('local');
    expect(servidor.epocasRecibidas).toEqual([null, 'epoca-1']);
  });

  it('tras una restauración, la novedad pendiente sobre un consumo aplicado termina aplicada', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id, mutation_id: creacion } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    expect(await db.outbox.get(creacion)).toMatchObject({ estado: 'aplicada' });

    // El servidor se restaura (pierde el consumo) y, sin conexión, Ana registra una novedad.
    servidor.restaurar('epoca-2');
    const novedad = await registrarNovedadLocal(ana.id, {
      consumption_id: id,
      tipo: 'merma',
      descripcion: 'Arena húmeda',
    });

    const resumen = await m.sincronizar('online');
    expect(resumen).toMatchObject({ error: null, epoca_cambiada: true, rechazadas: 0 });
    // Primer push con la época vieja → 409, sin procesar; luego pull + snapshot; luego el push
    // reenvía la creación (reencolada) ANTES que la novedad, en orden de seq_local.
    expect(servidor.epocasRecibidas.slice(1)).toEqual(['epoca-1', 'epoca-2']);
    expect(servidor.mutacionesPorPush().at(-1)).toEqual([creacion, novedad.mutation_id]);
    expect(await db.outbox.get(creacion)).toMatchObject({ estado: 'aplicada' });
    expect(await db.outbox.get(novedad.mutation_id)).toMatchObject({
      estado: 'aplicada',
      intentos: 1,
    });
    expect(servidor.entidades('consumptions').map((c) => c.id)).toEqual([id]);
    expect(servidor.entidades('incidents')).toHaveLength(1);
  });

  it('un push con época vieja nunca recibe "rechazada" por ese motivo', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('apertura');
    servidor.restaurar('epoca-2');
    const { mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('online');
    // Dos push: el primero (época vieja) respondió 409 sin procesar; el segundo aplicó.
    expect(pushes()).toBe(2);
    expect(servidor.epocasRecibidas).toEqual(['epoca-1', 'epoca-2']);
    expect(await db.outbox.get(mutation_id)).toMatchObject({ estado: 'aplicada', error: null });
  });

  it('si la época vuelve a cambiar justo antes del segundo push, termina con EPOCA_CAMBIADA y nada se rechaza', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('apertura');
    const { mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    servidor.restaurar('epoca-2');
    let pulls = 0;
    servidor.alRecibir = (p) => {
      if (p.ruta === '/api/v1/sync/pull') {
        pulls += 1;
      }
      // Después del snapshot de la época 2, otra restauración antes del segundo push.
      if (p.ruta === '/api/v1/sync/push' && pulls > 1 && servidor.epoca === 'epoca-2') {
        servidor.restaurar('epoca-3');
      }
    };
    const resumen = await m.sincronizar('online');
    expect(resumen.error).toEqual({
      code: 'EPOCA_CAMBIADA',
      message: MENSAJES_ERROR.EPOCA_CAMBIADA,
    });
    expect(await db.outbox.get(mutation_id)).toMatchObject({
      estado: 'pendiente',
      siguiente_intento_at: null,
    });
    reloj += 1;
    servidor.alRecibir = null;
    expect((await m.sincronizar('intervalo')).error).toBeNull();
    expect(await db.outbox.get(mutation_id)).toMatchObject({ estado: 'aplicada' });
  });
});

describe('A2: hidratación de una orden ya desasignada', () => {
  it('el snapshot 404 cierra la hidratación; el pull avanza y llega el revocar', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('apertura');
    const orden = uuidv7();
    servidor.upsert('production_orders', orden, {
      id: orden,
      codigo: 'OP-2026-0001',
      linea: 'L1',
      estado: 'en_proceso',
      creada_por: uuidv7(),
      created_at: '2026-10-29T12:00:00.000Z',
      updated_at: '2026-10-29T12:00:00.000Z',
    });
    await m.sincronizar('intervalo');
    expect(await db.ordenes.get([ana.id, orden])).toBeDefined();

    // Hidratación persistida (la app se cerró antes de atenderla) y la orden se desasigna.
    const meta = (await db.meta.get(ana.id))!;
    await db.meta.put({ ...meta, hidrataciones: [orden] });
    servidor.ordenesNoVisibles.add(orden);
    servidor.agregarCambio('revocar', 'production_orders', orden);

    const resumen = await m.sincronizar('intervalo');
    expect(resumen.error).toBeNull();
    expect(await leerMetaSync(ana.id)).toMatchObject({ cursor: servidor.seq(), acciones: [] });
    expect(await db.ordenes.get([ana.id, orden])).toBeUndefined();
    // Las siguientes sincronizaciones ya no tropiezan con esa hidratación.
    expect((await m.sincronizar('intervalo')).error).toBeNull();
  });

  it('otros errores del snapshot de la orden siguen deteniendo la sync (se reintenta)', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    await m.sincronizar('apertura');
    const orden = uuidv7();
    const meta = (await db.meta.get(ana.id))!;
    await db.meta.put({ ...meta, hidrataciones: [orden] });
    const original = servidor.fetch;
    servidor.fetch = async (entrada, init) =>
      urlDe(entrada).includes('alcance=orden')
        ? new Response(JSON.stringify({ code: 'ERROR_INTERNO', message: 'x' }), { status: 500 })
        : original(entrada, init);
    expect((await m.sincronizar('intervalo')).error).toMatchObject({ code: 'ERROR_INTERNO' });
    expect((await leerMetaSync(ana.id)).hidrataciones).toEqual([orden]);
  });
});

describe('M4: snapshot que agota el tope de páginas', () => {
  function materiales(n: number): void {
    for (let i = 0; i < n; i += 1) {
      servidor.upsert('materials', `m${i}`, {
        id: `m${i}`,
        codigo: `MP-${i}`,
        nombre: `Material ${i}`,
        unidad: 'kg',
        costo_unitario_cop: 1,
        activo: true,
      });
    }
  }

  it('no completa el snapshot inicial: error reintentable y luego termina', async () => {
    materiales(3);
    servidor.tamSnapshot = 1;
    const resumen = await motor(sesionFalsa(servidor, ana), { maxPaginasSnapshot: 2 }).sincronizar(
      'apertura',
    );
    expect(resumen.error).toMatchObject({ code: 'ERROR_INTERNO' });
    expect(resumen.error?.message).toMatch(/no terminó/);
    expect(await leerMetaSync(ana.id)).toMatchObject({ epoca: null, cursor: 0 });
    expect(servidor.peticiones.some((p) => p.ruta === '/api/v1/sync/pull')).toBe(false);

    const otra = await motor(sesionFalsa(servidor, ana), { maxPaginasSnapshot: 5 }).sincronizar(
      'intervalo',
    );
    expect(otra.error).toBeNull();
    expect(await leerMetaSync(ana.id)).toMatchObject({ epoca: 'epoca-1', cursor: 3 });
    expect(await db.materiales.count()).toBe(3);
  });

  it('no completa una hidratación incompleta', async () => {
    const m = motor(sesionFalsa(servidor, ana), { maxPaginasSnapshot: 1 });
    await m.sincronizar('apertura');
    const orden = uuidv7();
    for (let i = 0; i < 2; i += 1) {
      servidor.upsert(
        'order_supervisors',
        `${orden}:${i}`,
        { order_id: orden, user_id: `u${i}`, nombre: `Sup ${i}`, activo: true },
        false,
      );
    }
    servidor.tamSnapshot = 1;
    servidor.agregarCambio('hidratar', 'production_orders', orden);
    const resumen = await m.sincronizar('intervalo');
    expect(resumen.error).toMatchObject({ code: 'ERROR_INTERNO' });
    expect((await leerMetaSync(ana.id)).hidrataciones).toEqual([orden]);
    // Se guardó el nombre que trae order_supervisors.
    expect(await db.asignaciones.get([ana.id, `${orden}:0`])).toMatchObject({ nombre: 'Sup 0' });
  });
});

describe('M1: retención de 30 días y consumos perdidos en una restauración', () => {
  it('un consumo propio que el servidor perdió (aplicada ya purgada) se marca y se puede reenviar', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const viejo = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    // Pasan más de 30 días: la aplicada se purga (el consumo local sigue).
    reloj += 31 * DIA;
    await purgarAplicadasAntiguas(ana.id, new Date(reloj));
    expect(await db.outbox.get(viejo.mutation_id)).toBeUndefined();
    const reciente = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('intervalo');

    // Restauración más atrás que la retención: el servidor pierde ambos consumos.
    servidor.restaurar('epoca-2');
    const resumen = await m.sincronizar('intervalo');
    expect(resumen.error).toBeNull();
    // El reciente se reenvió (su aplicada se conservaba); el viejo no se borró: quedó perdido.
    expect(servidor.entidades('consumptions').map((c) => c.id)).toEqual([reciente.id]);
    expect(await db.consumos.get([ana.id, reciente.id])).toMatchObject({
      perdido_en_restauracion: false,
    });
    expect(await db.consumos.get([ana.id, viejo.id])).toMatchObject({
      perdido_en_restauracion: true,
      verificar_en_snapshot: false,
      cantidad: 5,
    });

    const reenvio = await reenviarPerdido(ana.id, viejo.id);
    expect(reenvio.id).toBe(viejo.id);
    expect(reenvio.mutation_id).not.toBe(viejo.mutation_id);
    expect(await db.consumos.get([ana.id, viejo.id])).toMatchObject({
      perdido_en_restauracion: false,
      estado_local: 'pendiente_sync',
    });
    await m.sincronizar('manual');
    expect(
      servidor
        .entidades('consumptions')
        .map((c) => c.id)
        .sort(),
    ).toEqual([reciente.id, viejo.id].sort());
    expect(await db.consumos.get([ana.id, viejo.id])).toMatchObject({
      estado_local: 'sincronizado',
    });
    expect((await db.trazabilidad.toArray()).map((e) => e.descripcion)).toContain(
      'reenvió un consumo perdido en el servidor',
    );
  });

  it('reiniciar sin restauración no marca nada como perdido', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    servidor.agregarCambio('reiniciar', 'users', ana.id);
    expect((await m.sincronizar('intervalo')).error).toBeNull();
    expect(await db.consumos.get([ana.id, id])).toMatchObject({
      perdido_en_restauracion: false,
      verificar_en_snapshot: false,
    });
  });

  it('reenviarPerdido rechaza consumos que no están perdidos, ajenos o inexistentes', async () => {
    const { id } = await registrarConsumoLocal(ana.id, consumo());
    await expect(reenviarPerdido(ana.id, id)).rejects.toMatchObject({ code: 'CONFLICTO' });
    await expect(reenviarPerdido(ana.id, uuidv7())).rejects.toMatchObject({
      code: 'NO_ENCONTRADO',
    });
    const c = (await db.consumos.get([ana.id, id]))!;
    await db.consumos.put({ ...c, registrado_por: uuidv7(), perdido_en_restauracion: true });
    await expect(reenviarPerdido(ana.id, id)).rejects.toMatchObject({ code: 'PERMISO_DENEGADO' });
  });

  it('cerrar sesión conserva la época: al volver se detecta la restauración y se reenvía', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id, mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    await borrarDatosDeUsuario(ana.id, { conservarPerfil: true, ahora: new Date(reloj) });
    expect(await leerMetaSync(ana.id)).toMatchObject({
      epoca: 'epoca-1',
      cursor: 0,
      requiere_snapshot: true,
    });
    expect(await db.outbox.get(mutation_id)).toMatchObject({ estado: 'aplicada' });

    servidor.restaurar('epoca-2');
    const resumen = await m.sincronizar('apertura');
    expect(resumen).toMatchObject({ error: null, epoca_cambiada: true });
    expect(servidor.entidades('consumptions').map((c) => c.id)).toEqual([id]);
  });
});

describe('B4: mutaciones atascadas', () => {
  it('con 10 o más intentos se exponen como atascadas, sin rechazarlas', async () => {
    const { mutation_id } = await registrarConsumoLocal(ana.id, consumo());
    const otra = await registrarConsumoLocal(ana.id, consumo());
    const m9 = (await db.outbox.get(otra.mutation_id))!;
    await db.outbox.put({ ...m9, intentos: 9 });
    const fila = (await db.outbox.get(mutation_id))!;
    await db.outbox.put({ ...fila, intentos: 10 });

    expect((await mutacionesAtascadas(ana.id)).map((x) => x.mutation_id)).toEqual([mutation_id]);
    expect(await mutacionesAtascadas(uuidv7())).toEqual([]);

    const s = sesionFalsa(servidor, ana);
    s.modo = 'offline';
    await motor(s).sincronizar('intervalo');
    expect(estado.getState()).toMatchObject({ atascadas: 1, pendientes: 2 });

    // Se sigue reintentando: cuando el servidor responde, deja de estar atascada.
    s.modo = 'online';
    await motor(s).sincronizar('manual');
    expect(estado.getState()).toMatchObject({ atascadas: 0, pendientes: 0 });
    expect(await contarPendientes(ana.id)).toBe(0);
  });
});

describe('formatos del servidor real', () => {
  it('CONSUMO_NO_PENDIENTE trae el consumo actual: la vista local lo refleja', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    const actual = servidor.entidades('consumptions')[0]!;
    servidor.upsert('consumptions', id, { ...actual, estado: 'aprobado', version: 2 }, false);
    await editarConsumoLocal(ana.id, { id, cantidad: 9 });
    const resumen = await m.sincronizar('manual');
    expect(resumen.rechazadas).toBe(1);
    expect(await db.consumos.get([ana.id, id])).toMatchObject({
      cantidad: 5,
      version: 2,
      estado_local: 'rechazado_sync',
      error_sync: { code: 'CONSUMO_NO_PENDIENTE' },
      servidor: expect.objectContaining({ estado: 'aprobado' }) as unknown,
    });
    expect(pushes()).toBe(2);
  });

  it('CONFLICTO trae el consumo actual (sin envoltura) y se guarda como versión del servidor', async () => {
    const m = motor(sesionFalsa(servidor, ana));
    const { id } = await registrarConsumoLocal(ana.id, consumo());
    await m.sincronizar('apertura');
    const actual = servidor.entidades('consumptions')[0]!;
    servidor.upsert('consumptions', id, { ...actual, cantidad: 7, version: 4 }, false);
    await editarConsumoLocal(ana.id, { id, cantidad: 9 });
    expect((await m.sincronizar('manual')).conflictos).toBe(1);
    expect(await db.consumos.get([ana.id, id])).toMatchObject({
      estado_local: 'conflicto',
      version: 4,
      cantidad: 7,
      conflicto_servidor: expect.objectContaining({ version: 4, cantidad: 7 }) as unknown,
    });
  });
});

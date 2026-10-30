import Dexie from 'dexie';
import { esUuidV7, uuidv7 } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CatmetalDb,
  claveEntidad,
  db,
  ESQUEMA_V1,
  ESQUEMA_V2,
  NOMBRE_DB,
  obtenerInstalacionId,
} from './db';
import { ErrorDatosLocales } from './errores';
import {
  limpiarDb,
  consumoServidor,
  evidenciaServidor,
  novedadServidor,
  validacionServidor,
} from './pruebas/fabricas';
import { extraerEntidades, masReciente } from './servidor';

beforeEach(async () => {
  await limpiarDb();
});

describe('esquema Dexie', () => {
  it('abre catmetal-mp v3: las tablas de la ADR 0012, los candados (tarea 3.4) y el área temporal del snapshot (ADR 0022)', async () => {
    await db.open();
    expect(db.name).toBe(NOMBRE_DB);
    expect(db.verno).toBe(3);
    expect(db.tables.map((t) => t.name).sort()).toEqual(
      [
        'asignaciones',
        'candados',
        'consumos',
        'evidencias',
        'instalacion',
        'materiales',
        'meta',
        'novedades',
        'ordenes',
        'outbox',
        'perfiles',
        'planeados',
        'settings',
        'snapshot_entidades',
        'snapshot_progreso',
        'trazabilidad',
        'usuarios',
        'validaciones',
      ].sort(),
    );
    // Las entidades usan la clave compuesta [user_id+id] (partición).
    expect(db.consumos.schema.primKey.keyPath).toEqual(['user_id', 'id']);
    expect(db.outbox.schema.idxByName['[user_id+estado+seq_local]']).toBeDefined();
    expect(db.outbox.schema.idxByName.seq_local?.unique).toBe(true);
    expect(db.outbox.schema.idxByName.claves?.multi).toBe(true);
    expect(db.snapshot_entidades.schema.primKey.keyPath).toEqual(['user_id', 'entidad', 'id']);
  });

  it('permite instancias con otro nombre (pruebas aisladas)', async () => {
    const otra = new CatmetalDb(`prueba-${uuidv7()}`);
    await otra.open();
    expect(otra.verno).toBe(3);
    await otra.delete();
  });

  it('la actualización de v2 a v3 no pierde datos (outbox, fotos ni particiones de otros usuarios)', async () => {
    const nombre = `migracion-${uuidv7()}`;
    const A = uuidv7();
    const B = uuidv7();
    // Una base v2 como la de los navegadores en producción.
    const v2 = new Dexie(nombre);
    v2.version(1).stores(ESQUEMA_V1);
    v2.version(2).stores(ESQUEMA_V2);
    await v2.open();
    const foto = new Uint8Array([1, 2, 3]).buffer;
    await v2.table('outbox').add({
      mutation_id: 'm1',
      seq_local: 1,
      estado: 'pendiente',
      user_id: A,
      consumo_id: 'c1',
      claves: [`${A}|consumos|c1`],
    });
    await v2.table('consumos').bulkAdd([
      { user_id: A, id: 'c1', order_id: 'o1', dia_bogota: 'd', estado_local: 'pendiente_sync' },
      { user_id: B, id: 'c2', order_id: 'o1', dia_bogota: 'd', estado_local: 'sincronizado' },
    ]);
    await v2.table('evidencias').add({
      user_id: A,
      id: 'e1',
      incident_id: 'n1',
      estado_subida: 'pendiente',
      datos: foto,
    });
    await v2.table('ordenes').add({ user_id: B, id: 'o1', estado: 'en_proceso' });
    await v2.table('meta').add({ user_id: B, cursor: 7, epoca: 'epoca-1' });
    v2.close();

    const v3 = new CatmetalDb(nombre);
    await v3.open();
    expect(v3.verno).toBe(3);
    expect(await v3.outbox.get('m1')).toMatchObject({ user_id: A, estado: 'pendiente' });
    expect(await v3.consumos.count()).toBe(2);
    expect(await v3.consumos.get([B, 'c2'])).toMatchObject({ estado_local: 'sincronizado' });
    const e = await v3.evidencias.get([A, 'e1']);
    expect(new Uint8Array(e!.datos!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await v3.ordenes.get([B, 'o1'])).toBeDefined();
    expect(await v3.meta.get(B)).toMatchObject({ cursor: 7, epoca: 'epoca-1' });
    expect(await v3.snapshot_entidades.count()).toBe(0);
    expect(await v3.snapshot_progreso.count()).toBe(0);
    await v3.delete();
  });

  it('claveEntidad incluye el usuario', () => {
    expect(claveEntidad('u', 'consumos', 'c')).toBe('u|consumos|c');
  });
});

describe('obtenerInstalacionId', () => {
  it('genera un UUID v7 una sola vez y lo reutiliza', async () => {
    const [uno, dos] = await Promise.all([obtenerInstalacionId(), obtenerInstalacionId()]);
    expect(esUuidV7(uno)).toBe(true);
    expect(dos).toBe(uno);
    expect(await obtenerInstalacionId()).toBe(uno);
    expect(await db.instalacion.count()).toBe(1);
  });
});

describe('ErrorDatosLocales', () => {
  it('usa los mensajes de la API y el propio de pendientes locales', () => {
    expect(new ErrorDatosLocales('AUTOAPROBACION').message).toMatch(/registrado por usted/);
    expect(new ErrorDatosLocales('PENDIENTES_LOCALES').message).toMatch(/sin sincronizar/);
    expect(new ErrorDatosLocales('CONFLICTO', 'otro').message).toBe('otro');
    expect(new ErrorDatosLocales('CONFLICTO').name).toBe('ErrorDatosLocales');
  });
});

describe('lectura de respuestas del servidor', () => {
  it('reconoce cada entidad por su forma e ignora lo demás', () => {
    const consumo = consumoServidor();
    const novedad = novedadServidor();
    const evidencia = evidenciaServidor();
    const validacion = validacionServidor();
    expect(extraerEntidades({ ...novedad, evidencias: [evidencia, { id: 'x' }] })).toEqual({
      consumos: [],
      novedades: [novedad],
      evidencias: [evidencia],
      validaciones: [],
    });
    expect(extraerEntidades({ consumo, validacion, version_servidor: 2 })).toMatchObject({
      consumos: [consumo],
      validaciones: [validacion],
    });
    expect(extraerEntidades(undefined).consumos).toEqual([]);
    expect(extraerEntidades([consumo]).consumos).toEqual([]);
    expect(extraerEntidades({ x: 1 })).toEqual({
      consumos: [],
      novedades: [],
      evidencias: [],
      validaciones: [],
    });
  });

  it('masReciente: mayor versión y, a igual versión, el updated_at más nuevo', () => {
    const v1 = { version: 1, updated_at: '2026-10-29T10:00:00.000Z' };
    const v2 = { version: 2, updated_at: '2026-10-29T09:00:00.000Z' };
    const v1b = { version: 1, updated_at: '2026-10-29T11:00:00.000Z' };
    expect(masReciente(v1, v2)).toBe(v2);
    expect(masReciente(v2, v1)).toBe(v2);
    expect(masReciente(v1, v1b)).toBe(v1b);
    expect(masReciente(v1b, v1)).toBe(v1b);
    expect(masReciente(null, v1)).toBe(v1);
    expect(masReciente(v1, null)).toBe(v1);
    expect(masReciente({}, {})).toEqual({});
  });
});

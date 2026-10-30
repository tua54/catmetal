import { esUuidV7, uuidv7 } from '@catmetal/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { CatmetalDb, claveEntidad, db, NOMBRE_DB, obtenerInstalacionId } from './db';
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
  it('abre catmetal-mp v2: las tablas de la ADR 0012 más los candados (tarea 3.4)', async () => {
    await db.open();
    expect(db.name).toBe(NOMBRE_DB);
    expect(db.verno).toBe(2);
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
  });

  it('permite instancias con otro nombre (pruebas aisladas)', async () => {
    const otra = new CatmetalDb(`prueba-${uuidv7()}`);
    await otra.open();
    expect(otra.verno).toBe(2);
    await otra.delete();
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

// Base local IndexedDB de la PWA (Dexie), ADR 0012.
//
// Partición por usuario: UNA base con `user_id` en todas las tablas de datos y claves compuestas
// `[user_id+…]`. Las tablas de entidades usan la clave primaria `[user_id+id]` (no `id` solo):
// - Aislamiento: la misma entidad vista por dos usuarios de la tablet son DOS filas, cada una con su
//   estado de sync y su `servidor`; revocar, reiniciar o borrar los datos de A nunca toca los de B.
// - Una consulta por rango `[user_id, minKey]..[user_id, maxKey]` recorre solo la partición.
// - El costo (duplicar filas que dos usuarios ven) es aceptable para el volumen de una planta.
//
// El outbox usa `mutation_id` como clave (es global e idempotente en el servidor) y `user_id` en
// todos sus índices, así ninguna consulta del motor puede mezclar autores.

import Dexie, { type Table } from 'dexie';
import { ahoraIso, uuidv7 } from '@catmetal/shared';
import type {
  AsignacionLocal,
  CandadoLocal,
  ConsumoLocal,
  EventoTrazabilidad,
  EvidenciaLocal,
  Instalacion,
  MaterialLocal,
  MetaSync,
  MutacionOutbox,
  NovedadLocal,
  OrdenLocal,
  PerfilLocal,
  PlaneadoLocal,
  SettingLocal,
  TablaMutable,
  UsuarioLocal,
  ValidacionLocal,
} from './tipos';

export const NOMBRE_DB = 'catmetal-mp';

type ClaveUsuario = [string, string];

/**
 * Esquema v1. Para cambiarlo, agregue `this.version(N + 1).stores(...)` (con `upgrade()` si hay que
 * transformar datos); nunca edite
 * una versión ya publicada (los navegadores con datos de planta la tienen).
 */
export const ESQUEMA_V1 = {
  // `&seq_local`: único, garantiza un orden total de envío. `[user_id+estado+seq_local]`: cola de un
  // usuario en orden. `*claves`: entidades afectadas (¿tiene la entidad mutaciones en cola?).
  outbox:
    'mutation_id, &seq_local, estado, [user_id+seq_local], [user_id+estado+seq_local], [user_id+consumo_id], *claves',
  consumos: '[user_id+id], [user_id+order_id], [user_id+dia_bogota], [user_id+estado_local]',
  novedades: '[user_id+id], [user_id+consumption_id]',
  evidencias: '[user_id+id], [user_id+incident_id], [user_id+estado_subida], estado_subida',
  validaciones: '[user_id+id], [user_id+consumption_id]',
  ordenes: '[user_id+id], [user_id+estado]',
  planeados: '[user_id+id], [user_id+order_id]',
  asignaciones: '[user_id+id], [user_id+order_id]',
  materiales: '[user_id+id]',
  settings: '[user_id+clave]',
  usuarios: '[user_id+id]',
  meta: 'user_id',
  perfiles: 'user_id',
  trazabilidad: 'id, [user_id+ts]',
  instalacion: 'clave',
} as const;

/**
 * v2 (tarea 3.4): candados entre pestañas en IndexedDB, alternativa a Web Locks para serializar el
 * refresh del token. Solo agrega una tabla: no requiere `upgrade()`.
 */
export const ESQUEMA_V2 = {
  candados: 'nombre',
} as const;

export class CatmetalDb extends Dexie {
  declare outbox: Table<MutacionOutbox, string>;
  declare consumos: Table<ConsumoLocal, ClaveUsuario>;
  declare novedades: Table<NovedadLocal, ClaveUsuario>;
  declare evidencias: Table<EvidenciaLocal, ClaveUsuario>;
  declare validaciones: Table<ValidacionLocal, ClaveUsuario>;
  declare ordenes: Table<OrdenLocal, ClaveUsuario>;
  declare planeados: Table<PlaneadoLocal, ClaveUsuario>;
  declare asignaciones: Table<AsignacionLocal, ClaveUsuario>;
  declare materiales: Table<MaterialLocal, ClaveUsuario>;
  declare settings: Table<SettingLocal, ClaveUsuario>;
  declare usuarios: Table<UsuarioLocal, ClaveUsuario>;
  declare meta: Table<MetaSync, string>;
  declare perfiles: Table<PerfilLocal, string>;
  declare trazabilidad: Table<EventoTrazabilidad, string>;
  declare instalacion: Table<Instalacion, string>;
  declare candados: Table<CandadoLocal, string>;

  constructor(nombre: string = NOMBRE_DB) {
    super(nombre);
    this.version(1).stores(ESQUEMA_V1);
    this.version(2).stores(ESQUEMA_V2);
  }
}

/** Instancia única de la PWA. */
export const db = new CatmetalDb();

/** Tablas de datos de negocio y de sync (todas las que escriben las operaciones de la cola). */
export function tablasDeDatos(): Table[] {
  return [
    db.outbox,
    db.consumos,
    db.novedades,
    db.evidencias,
    db.validaciones,
    db.ordenes,
    db.planeados,
    db.asignaciones,
    db.materiales,
    db.settings,
    db.usuarios,
    db.meta,
    db.perfiles,
    db.trazabilidad,
  ];
}

/** Rango de una clave compuesta que empieza por `prefijo` (toda la partición de un usuario). */
export function rangoDe(...prefijo: string[]): [unknown[], unknown[]] {
  return [
    [...prefijo, Dexie.minKey],
    [...prefijo, Dexie.maxKey],
  ];
}

/** Clave de una entidad en `outbox.claves`: `user_id|tabla|id`. */
export function claveEntidad(userId: string, tabla: TablaMutable, id: string): string {
  return `${userId}|${tabla}|${id}`;
}

/**
 * Id de este navegador (UUID v7), generado una sola vez y compartido por todos los usuarios de la
 * tablet (ADR 0008 punto 7). Se crea en una transacción para que dos pestañas no generen dos.
 */
export function obtenerInstalacionId(): Promise<string> {
  return db.transaction('rw', db.instalacion, async () => {
    const actual = await db.instalacion.get('instalacion');
    if (actual !== undefined) {
      return actual.instalacion_id;
    }
    const nueva: Instalacion = {
      clave: 'instalacion',
      instalacion_id: uuidv7(),
      created_at: ahoraIso(),
    };
    await db.instalacion.add(nueva);
    return nueva.instalacion_id;
  });
}

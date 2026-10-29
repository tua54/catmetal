// El esquema Drizzle (src/db/schema.ts) y la base que dejan las migraciones deben coincidir.
// Si alguien cambia schema.ts y olvida `pnpm db:generate` (o edita a mano la migración generada),
// esta prueba falla: columnas, NOT NULL, PK, FK, índices y nombres de CHECK.
import { env } from 'cloudflare:workers';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/schema';

const tablas = Object.values(schema);

async function todas<T>(sql: string, ...parametros: string[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql)
    .bind(...parametros)
    .all<T>();
  return results;
}

describe.each(tablas.map((tabla) => [getTableName(tabla), tabla] as const))(
  'tabla %s',
  (nombre, tabla) => {
    const config = getTableConfig(tabla);

    it('columnas, NOT NULL y clave primaria coinciden', async () => {
      const columnasDb = await todas<{ name: string; obligatorio: number; pk: number }>(
        'SELECT name, "notnull" AS obligatorio, pk FROM pragma_table_info(?) ORDER BY cid',
        nombre,
      );
      expect(columnasDb.map((c) => c.name).sort()).toEqual(
        config.columns.map((c) => c.name).sort(),
      );
      for (const columna of config.columns) {
        const enDb = columnasDb.find((c) => c.name === columna.name);
        expect(enDb?.obligatorio === 1, `${nombre}.${columna.name}`).toBe(columna.notNull);
      }

      const pkEsquema = [
        ...config.columns.filter((c) => c.primary).map((c) => c.name),
        ...config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
      ];
      const pkDb = columnasDb
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(pkDb).toEqual(pkEsquema);
    });

    it('foreign keys coinciden', async () => {
      const fkDb = await todas<{ from: string; table: string; to: string }>(
        'SELECT "from" AS "from", "table" AS "table", "to" AS "to" FROM pragma_foreign_key_list(?)',
        nombre,
      );
      const fkEsquema = config.foreignKeys.flatMap((fk) => {
        const referencia = fk.reference();
        return referencia.columns.map((columna, i) => ({
          from: columna.name,
          table: getTableName(referencia.foreignTable),
          to: referencia.foreignColumns[i]?.name ?? '',
        }));
      });
      const clave = (f: { from: string; table: string; to: string }) =>
        `${f.from}→${f.table}.${f.to}`;
      expect(fkDb.map(clave).sort()).toEqual(fkEsquema.map(clave).sort());
    });

    it('índices con nombre coinciden (nombre y unicidad)', async () => {
      const indicesDb = await todas<{ name: string; unique: number }>(
        `SELECT name, "unique" AS "unique" FROM pragma_index_list(?)
         WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
        nombre,
      );
      const indicesEsquema = config.indexes
        .map((i) => ({ name: i.config.name, unique: i.config.unique ? 1 : 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(indicesDb).toEqual(indicesEsquema);
    });

    it('los CHECK del esquema existen en la tabla, con el mismo nombre', async () => {
      const [definicion] = await todas<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
        nombre,
      );
      const checksDb = [...(definicion?.sql ?? '').matchAll(/CONSTRAINT "([^"]+)" CHECK/g)]
        .map((m) => m[1])
        .sort();
      expect(checksDb).toEqual(config.checks.map((c) => c.name).sort());
    });
  },
);

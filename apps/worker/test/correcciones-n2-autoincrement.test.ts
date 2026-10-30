// N2 (docs/correcciones-v1.1.md): en SQLite/D1, un INSERT que se omite por `ON CONFLICT DO NOTHING`
// o `OR IGNORE` igual hace avanzar `sqlite_sequence` en una tabla AUTOINCREMENT. En `audit_log`, eso
// abre un hueco en `seq` y el trigger `audit_log_seq_sin_saltos` rechaza TODA auditoría posterior
// (y con ella toda escritura de negocio). Ninguna inserción en `audit_log` puede usar esas formas;
// para ser idempotente se usa `INSERT … SELECT … WHERE NOT EXISTS`.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('N2: inserciones idempotentes en tablas AUTOINCREMENT', () => {
  it('en D1, un conflicto ignorado avanza la secuencia y el trigger sin saltos bloquea lo siguiente', async () => {
    // Tabla propia con la misma forma que audit_log (seq AUTOINCREMENT + trigger sin saltos), para no
    // alterar audit_log de la base de pruebas.
    await env.DB.batch([
      env.DB.prepare(
        'CREATE TABLE n2_prueba (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE)',
      ),
      env.DB.prepare(
        `CREATE TRIGGER n2_prueba_sin_saltos AFTER INSERT ON n2_prueba
         WHEN NEW.seq > 1 + COALESCE((SELECT max(a.seq) FROM n2_prueba AS a WHERE a.seq < NEW.seq), 0)
         BEGIN SELECT RAISE(ABORT, 'n2_prueba.seq no admite saltos'); END`,
      ),
    ]);
    await env.DB.prepare("INSERT INTO n2_prueba (id) VALUES ('a')").run();

    // Forma segura: no inserta nada y no mueve la secuencia.
    await env.DB.prepare(
      "INSERT INTO n2_prueba (id) SELECT 'a' WHERE NOT EXISTS (SELECT 1 FROM n2_prueba WHERE id = 'a')",
    ).run();
    await env.DB.prepare("INSERT INTO n2_prueba (id) VALUES ('b')").run();

    // Forma insegura: no inserta nada pero la secuencia avanza.
    await env.DB.prepare("INSERT INTO n2_prueba (id) VALUES ('a') ON CONFLICT DO NOTHING").run();
    await expect(env.DB.prepare("INSERT INTO n2_prueba (id) VALUES ('c')").run()).rejects.toThrow(
      /no admite saltos/,
    );
  });

  /** Quita comentarios para no marcar la documentación que explica la prohibición. */
  function sinComentarios(ruta: string, contenido: string): string {
    if (ruta.endsWith('.sql')) {
      return contenido.replace(/--.*$/gm, '');
    }
    return contenido.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('ninguna inserción en audit_log de src/, migrations/ ni scripts/ usa ON CONFLICT u OR IGNORE', () => {
    const infractores: string[] = [];
    for (const archivo of env.TEST_ARCHIVOS_FUENTE) {
      const texto = sinComentarios(archivo.ruta, archivo.contenido);
      const patron = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+audit_log\b/gi;
      for (const m of texto.matchAll(patron)) {
        // La sentencia termina en el primer `;` (de SQL o de JS) después del INSERT.
        const fin = texto.indexOf(';', m.index);
        const sentencia = texto.slice(m.index, fin === -1 ? undefined : fin + 1);
        if (/\bOR\s+IGNORE\b|\bON\s+CONFLICT\b/i.test(sentencia)) {
          infractores.push(archivo.ruta);
        }
      }
    }
    expect(infractores).toEqual([]);
  });
});

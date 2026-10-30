// B7 (docs/correcciones-v1.1.md): el trigger de `settings` solo protegía los UPDATE. Un INSERT (o el
// INSERT de un upsert, como el que usa la restauración de la ADR 0021) aceptaba claves desconocidas o
// una tolerancia fuera de 0-100. La migración 0008 agrega el BEFORE INSERT equivalente y acota
// también el UPDATE a 0-100.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const T = '2026-10-30T12:00:00.000Z';

function insertar(clave: string, valor: string) {
  return env.DB.prepare(
    `INSERT INTO settings (clave, valor, actualizado_por, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)`,
  )
    .bind(clave, valor, T, T)
    .run();
}

/** Upsert: el BEFORE INSERT se ejecuta aunque la fila ya exista y termine en UPDATE. */
function upsert(clave: string, valor: string) {
  return env.DB.prepare(
    `INSERT INTO settings (clave, valor, actualizado_por, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at`,
  )
    .bind(clave, valor, T, T)
    .run();
}

async function valor(clave: string): Promise<string | undefined> {
  const fila = await env.DB.prepare('SELECT valor FROM settings WHERE clave = ?')
    .bind(clave)
    .first<{ valor: string }>();
  return fila?.valor;
}

describe('B7: settings_insercion_valida', () => {
  it('rechaza el INSERT de una clave desconocida', async () => {
    await expect(insertar('clave_inventada', '1')).rejects.toThrow(
      /valor de configuración no válido/,
    );
    expect(await valor('clave_inventada')).toBeUndefined();
  });

  it('tolerancia_pct por INSERT solo admite números entre 0 y 100', async () => {
    const original = await valor('tolerancia_pct');
    try {
      for (const invalido of ['150', '100.5', '-1', '"abc"', 'null', 'true', '[5]']) {
        await expect(upsert('tolerancia_pct', invalido), invalido).rejects.toThrow(
          /valor de configuración no válido/,
        );
      }
      for (const valido of ['0', '7.5', '100']) {
        await upsert('tolerancia_pct', valido);
        expect(await valor('tolerancia_pct')).toBe(valido);
      }
    } finally {
      await upsert('tolerancia_pct', original ?? '5');
    }
  });

  it('sync_epoca por INSERT debe ser un texto JSON', async () => {
    const original = await valor('sync_epoca');
    try {
      await expect(upsert('sync_epoca', '5')).rejects.toThrow(/valor de configuración no válido/);
      await upsert('sync_epoca', JSON.stringify(crypto.randomUUID()));
    } finally {
      await upsert('sync_epoca', original ?? JSON.stringify(crypto.randomUUID()));
    }
  });

  it('el UPDATE también acota tolerancia_pct a 100', async () => {
    await expect(
      env.DB.prepare(`UPDATE settings SET valor = '150' WHERE clave = 'tolerancia_pct'`).run(),
    ).rejects.toThrow(/valor de configuración no válido/);
  });

  it('el trigger existe tras aplicar todas las migraciones', async () => {
    const fila = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'settings_insercion_valida'`,
    ).first<{ name: string }>();
    expect(fila?.name).toBe('settings_insercion_valida');
  });
});

// Prueba de humo de los bindings locales reales (Miniflare): D1, R2, KV y Rate Limiting.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('D1 (DB)', () => {
  it('responde a SELECT 1', async () => {
    const fila = await env.DB.prepare('SELECT 1 AS uno').first<{ uno: number }>();
    expect(fila).toEqual({ uno: 1 });
  });

  it('crea una tabla temporal, inserta y lee con parámetros enlazados', async () => {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS prueba_humo (id TEXT PRIMARY KEY, valor INTEGER NOT NULL)',
    ).run();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO prueba_humo (id, valor) VALUES (?, ?)').bind('a', 1),
      env.DB.prepare('INSERT INTO prueba_humo (id, valor) VALUES (?, ?)').bind('b', 2),
    ]);
    const { results } = await env.DB.prepare('SELECT id, valor FROM prueba_humo ORDER BY id').all<{
      id: string;
      valor: number;
    }>();
    expect(results).toEqual([
      { id: 'a', valor: 1 },
      { id: 'b', valor: 2 },
    ]);
  });

  it('tiene las foreign keys activas y rechaza una FK inválida', async () => {
    const pragma = await env.DB.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
    expect(pragma?.foreign_keys).toBe(1);

    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS padre_humo (id TEXT PRIMARY KEY)'),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS hijo_humo (id TEXT PRIMARY KEY, padre_id TEXT NOT NULL REFERENCES padre_humo(id))',
      ),
    ]);
    await expect(
      env.DB.prepare('INSERT INTO hijo_humo (id, padre_id) VALUES (?, ?)')
        .bind('h1', 'no-existe')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('un batch que falla a la mitad no deja cambios parciales', async () => {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS atomica_humo (id TEXT PRIMARY KEY)').run();
    await expect(
      env.DB.batch([
        env.DB.prepare('INSERT INTO atomica_humo (id) VALUES (?)').bind('x'),
        env.DB.prepare('INSERT INTO atomica_humo (id) VALUES (?)').bind('x'),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    const fila = await env.DB.prepare('SELECT COUNT(*) AS n FROM atomica_humo').first<{
      n: number;
    }>();
    expect(fila?.n).toBe(0);
  });
});

describe('R2 (EVIDENCE)', () => {
  it('guarda y lee un objeto con su tipo', async () => {
    const clave = 'evidencias/prueba/humo.txt';
    await env.EVIDENCE.put(clave, 'contenido de prueba', {
      httpMetadata: { contentType: 'text/plain' },
    });
    const objeto = await env.EVIDENCE.get(clave);
    expect(objeto).not.toBeNull();
    expect(await objeto?.text()).toBe('contenido de prueba');
    expect(objeto?.httpMetadata?.contentType).toBe('text/plain');
    expect(await env.EVIDENCE.get('evidencias/no-existe')).toBeNull();
  });
});

describe('KV (CONFIG)', () => {
  it('guarda y lee un valor', async () => {
    await env.CONFIG.put('cache:prueba', JSON.stringify({ ok: true }));
    expect(await env.CONFIG.get('cache:prueba', 'json')).toEqual({ ok: true });
    expect(await env.CONFIG.get('cache:no-existe')).toBeNull();
  });
});

describe('Rate Limiting (LOGIN_LIMITER)', () => {
  it('limit() responde { success } y bloquea al superar 5 por periodo', async () => {
    const clave = `humo:${crypto.randomUUID()}`;
    const resultados: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      const { success } = await env.LOGIN_LIMITER.limit({ key: clave });
      resultados.push(success);
    }
    expect(resultados.slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(resultados[5]).toBe(false);
  });
});

describe('secretos y variables', () => {
  it('expone ENTORNO local y los secretos de prueba', () => {
    expect(env.ENTORNO).toBe('local');
    expect(env.ORIGENES_DEV).toContain('http://localhost:5173');
    expect(env.JWT_SECRET.length).toBeGreaterThan(20);
    expect(env.REFRESH_SECRET.length).toBeGreaterThan(20);
    expect(env.JWT_SECRET).not.toBe(env.REFRESH_SECRET);
  });
});

// Tarea 6.1: backup diario paginado de D1 a R2 (ADR 0014). D1 y R2 locales reales.
// Cada prueba usa una fecha distinta: los archivos de R2 de un día no interfieren con otro. La base
// se comparte en el archivo y crece; cada verificación compara contra su contenido ACTUAL.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ejecutarBackup,
  fechaBackup,
  prefijoDelDia,
  sentenciaPagina,
  type ResultadoBackup,
} from '../src/cron/backup';
import { Presupuesto } from '../src/cron/presupuesto';
import { TABLAS_BACKUP } from '../src/cron/tablas';
import {
  filasDeTabla,
  leerManifest,
  leerProgreso,
  sembrarAuditoria,
  sembrarTodo,
  verificarBackupCompleto,
  type Fila,
} from './fase6-cron-helpers';

const dia = (fecha: string) => new Date(`${fecha}T08:00:00.000Z`);

beforeAll(async () => {
  await sembrarTodo();
  // Más de dos páginas de 500 en audit_log.
  await sembrarAuditoria(1203);
});

describe('tablas del backup', () => {
  it('cubre todas las tablas del esquema, una sola vez', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
         AND name <> 'd1_migrations'
       ORDER BY name`,
    ).all<{ name: string }>();
    const nombres = TABLAS_BACKUP.map((t) => t.nombre);
    expect(new Set(nombres).size).toBe(nombres.length);
    expect([...nombres].sort()).toEqual(results.map((r) => r.name));
  });

  it('pagina por la clave primaria exacta de cada tabla', async () => {
    for (const tabla of TABLAS_BACKUP) {
      const { results } = await env.DB.prepare(
        'SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk',
      )
        .bind(tabla.nombre)
        .all<{ name: string }>();
      expect(
        results.map((r) => r.name),
        tabla.nombre,
      ).toEqual(tabla.pk);
    }
  });

  it('exporta hijos antes que padres (orden de la ADR 0014)', () => {
    expect(TABLAS_BACKUP.map((t) => t.nombre)).toEqual([
      'audit_log',
      'sync_mutations',
      'validations',
      'evidences',
      'incidents',
      'consumptions',
      'order_planned_materials',
      'order_supervisors',
      'refresh_tokens',
      'devices',
      'settings',
      'production_orders',
      'materials',
      'users',
    ]);
  });

  it('la consulta de página usa comparación de filas en las PK compuestas', async () => {
    const tabla = TABLAS_BACKUP.find((t) => t.nombre === 'order_planned_materials');
    expect(tabla).toBeDefined();
    const todas = await filasDeTabla('order_planned_materials');
    expect(todas.length).toBeGreaterThanOrEqual(3);
    const primera = todas[0] as Fila;
    const { results } = await sentenciaPagina(
      env.DB,
      tabla as (typeof TABLAS_BACKUP)[number],
      [String(primera.order_id), String(primera.material_id)],
      500,
    ).all<Fila>();
    expect(results).toEqual(todas.slice(1));
  });
});

describe('backup completo en una invocación', () => {
  it('genera un archivo por tabla y el manifest con conteos, bytes y sha256 correctos', async () => {
    const fecha = '2026-11-01';
    const presupuesto = new Presupuesto();
    const resultado = await ejecutarBackup(env, dia(fecha), { presupuesto });

    const manifest = await verificarBackupCompleto(fecha);
    expect(resultado).toEqual({
      estado: 'completo',
      fecha,
      tablas: TABLAS_BACKUP.length,
      filas: manifest.tablas.reduce((n, t) => n + t.filas, 0),
      bytes: manifest.tablas.reduce((n, t) => n + t.bytes, 0),
      operaciones: presupuesto.usadas,
    });
    // Una sola invocación: un único miembro gzip por archivo.
    for (const entrada of manifest.tablas) {
      expect(entrada.segmentos_gzip, entrada.tabla).toEqual([0]);
      expect(entrada.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // Paginación de audit_log (> 1203 filas): ninguna fila repetida ni perdida, en orden de seq.
    const auditoria = manifest.tablas.find((t) => t.tabla === 'audit_log');
    expect(auditoria?.filas).toBeGreaterThan(1203);

    // Metadatos del manifest.
    const { results: maximo } = await env.DB.prepare('SELECT MAX(seq) AS seq FROM audit_log').all<{
      seq: number;
    }>();
    const { results: epoca } = await env.DB.prepare(
      "SELECT valor FROM settings WHERE clave = 'sync_epoca'",
    ).all<{ valor: string }>();
    const { results: migracion } = await env.DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    ).all<{ name: string }>();
    expect(manifest.formato).toBe(1);
    expect(manifest.seq_inicial).toBe(maximo[0]?.seq);
    expect(manifest.epoca).toBe(JSON.parse(String(epoca[0]?.valor)));
    expect(manifest.ultima_migracion).toBe(migracion[0]?.name);
    expect(manifest.ultima_migracion).toMatch(/^\d{4}_.+\.sql$/);
    expect(Number.isNaN(Date.parse(manifest.generado_at))).toBe(false);

    // Presupuesto: 3 páginas para audit_log y ~1 por tabla; muy lejos del límite de 1000.
    expect(presupuesto.usadas).toBeLessThan(100);
  });

  it('incluye todas las columnas, también los hashes (el backup debe poder restaurar)', async () => {
    const fecha = '2026-11-02';
    await ejecutarBackup(env, dia(fecha));
    const manifest = await verificarBackupCompleto(fecha);
    const usuarios = manifest.tablas.find((t) => t.tabla === 'users');
    const tokens = manifest.tablas.find((t) => t.tabla === 'refresh_tokens');
    expect(usuarios?.filas).toBeGreaterThan(0);
    expect(tokens?.filas).toBeGreaterThan(0);
    const { results } = await env.DB.prepare('SELECT * FROM users LIMIT 1').all<Fila>();
    expect(Object.keys(results[0] ?? {})).toContain('password_hash');
  });

  it('la fecha es el día UTC del momento de ejecución', () => {
    expect(fechaBackup(new Date('2026-11-03T23:59:59.999Z'))).toBe('2026-11-03');
    expect(fechaBackup(new Date('2026-11-04T00:00:00.000-05:00'))).toBe('2026-11-04');
    expect(prefijoDelDia('2026-11-03')).toBe('backups/2026-11-03/');
  });

  it('con páginas mínimas recorre bien todas las PK (simples, compuestas, seq y clave)', async () => {
    const fecha = '2026-11-05';
    // Una consulta por fila: se levanta el tope de consultas a D1 solo para esta prueba (desde la
    // ADR 0016 D1 y R2 tienen topes separados; antes se levantaba el tope único de operaciones).
    const resultado = await ejecutarBackup(env, dia(fecha), {
      tamanoPagina: 1,
      presupuesto: new Presupuesto({ maxConsultasD1: 100_000 }),
    });
    expect(resultado.estado).toBe('completo');
    await verificarBackupCompleto(fecha);
  });
});

describe('idempotencia por fecha', () => {
  it('una segunda ejecución del mismo día no reescribe nada', async () => {
    const fecha = '2026-11-06';
    await ejecutarBackup(env, dia(fecha));
    const base = prefijoDelDia(fecha);
    const antes = await env.EVIDENCE.list({ prefix: base });

    const presupuesto = new Presupuesto();
    const segunda = await ejecutarBackup(env, new Date(`${fecha}T09:30:00.000Z`), { presupuesto });
    expect(segunda).toEqual({ estado: 'ya_existia', fecha });
    expect(presupuesto.usadas).toBe(1);
    const despues = await env.EVIDENCE.list({ prefix: base });
    expect(despues.objects.map((o) => [o.key, o.etag, o.uploaded.getTime()])).toEqual(
      antes.objects.map((o) => [o.key, o.etag, o.uploaded.getTime()]),
    );
  });

  it('otro día genera un backup nuevo', async () => {
    await ejecutarBackup(env, dia('2026-11-07'));
    await ejecutarBackup(env, dia('2026-11-08'));
    expect(await leerManifest('2026-11-07')).not.toBeNull();
    expect(await leerManifest('2026-11-08')).not.toBeNull();
  });
});

describe('reanudación con presupuesto agotado', () => {
  it('la primera invocación deja progreso.json sin manifest y la segunda completa sin duplicar', async () => {
    const fecha = '2026-11-10';
    // 4 operaciones fijas + reserva de 26: caben 10 páginas de 100 filas de audit_log.
    const primera = await ejecutarBackup(env, dia(fecha), {
      tamanoPagina: 100,
      presupuesto: new Presupuesto({ maxOperaciones: 40 }),
    });
    expect(primera).toMatchObject({
      estado: 'pausado',
      fecha,
      tablas_terminadas: 0,
      tabla_en_curso: 'audit_log',
    });
    expect(await leerManifest(fecha)).toBeNull();
    const progreso = (await leerProgreso(fecha)) as {
      en_curso: { tabla: string; filas: number; cursor: number[]; parcial: string };
      en_curso_hasta: string | null;
      invocaciones: number;
    };
    expect(progreso.en_curso.tabla).toBe('audit_log');
    expect(progreso.en_curso.filas).toBe(1000);
    expect(progreso.en_curso.cursor).toHaveLength(1);
    expect(progreso.en_curso_hasta).toBeNull();
    expect(progreso.invocaciones).toBe(1);
    expect(await env.EVIDENCE.head(progreso.en_curso.parcial)).not.toBeNull();

    const segunda = await ejecutarBackup(env, new Date(`${fecha}T08:30:00.000Z`), {
      tamanoPagina: 100,
    });
    expect(segunda.estado).toBe('completo');
    const manifest = await verificarBackupCompleto(fecha);
    // audit_log quedó en dos miembros gzip: uno por invocación.
    const auditoria = manifest.tablas.find((t) => t.tabla === 'audit_log');
    expect(auditoria?.segmentos_gzip).toHaveLength(2);
    expect(await env.EVIDENCE.head(progreso.en_curso.parcial)).toBeNull();
  });

  it('con muchas pausas (también entre tablas) el resultado es idéntico', async () => {
    const fecha = '2026-11-11';
    const estados: ResultadoBackup['estado'][] = [];
    for (let i = 0; i < 300; i++) {
      const resultado = await ejecutarBackup(env, dia(fecha), {
        tamanoPagina: 50,
        presupuesto: new Presupuesto({ maxOperaciones: 36 }),
      });
      estados.push(resultado.estado);
      if (resultado.estado === 'completo') {
        break;
      }
    }
    expect(estados.at(-1)).toBe('completo');
    expect(estados.length).toBeGreaterThan(5);
    expect(estados.slice(0, -1).every((e) => e === 'pausado')).toBe(true);
    const manifest = await verificarBackupCompleto(fecha);
    const auditoria = manifest.tablas.find((t) => t.tabla === 'audit_log');
    expect(auditoria?.segmentos_gzip.length).toBeGreaterThan(2);
  });

  it('el presupuesto de tiempo también pausa', async () => {
    const fecha = '2026-11-12';
    let t = 0;
    const reloj = () => (t += 1000);
    const primera = await ejecutarBackup(env, dia(fecha), {
      presupuesto: new Presupuesto({ maxMs: 2500, reloj }),
    });
    expect(primera.estado).toBe('pausado');
    expect(await leerManifest(fecha)).toBeNull();
    expect((await ejecutarBackup(env, dia(fecha))).estado).toBe('completo');
    await verificarBackupCompleto(fecha);
  });

  it('respeta el arriendo de otra invocación en curso', async () => {
    const fecha = '2026-11-13';
    await ejecutarBackup(env, dia(fecha), {
      tamanoPagina: 100,
      presupuesto: new Presupuesto({ maxOperaciones: 40 }),
    });
    const clave = `${prefijoDelDia(fecha)}progreso.json`;
    const progreso = (await leerProgreso(fecha)) as Fila;
    const arrendado = { ...progreso, en_curso_hasta: `${fecha}T08:20:00.000Z` };
    await env.EVIDENCE.put(clave, JSON.stringify(arrendado));

    const durante = await ejecutarBackup(env, new Date(`${fecha}T08:10:00.000Z`));
    expect(durante).toEqual({ estado: 'en_curso_en_otra_invocacion', fecha });
    expect(await leerProgreso(fecha)).toEqual(arrendado);

    // Vencido el arriendo (la invocación anterior murió), se continúa.
    const despues = await ejecutarBackup(env, new Date(`${fecha}T08:21:00.000Z`), {
      tamanoPagina: 100,
    });
    expect(despues.estado).toBe('completo');
    await verificarBackupCompleto(fecha);
  });

  it('si la tabla en curso no se puede continuar, falla, la reinicia y la siguiente completa', async () => {
    const fecha = '2026-11-14';
    await ejecutarBackup(env, dia(fecha), {
      tamanoPagina: 100,
      presupuesto: new Presupuesto({ maxOperaciones: 40 }),
    });
    const progreso = (await leerProgreso(fecha)) as { en_curso: { parcial: string } };
    // Se pierde el parcial (por ejemplo, borrado a mano).
    await env.EVIDENCE.delete(progreso.en_curso.parcial);

    await expect(ejecutarBackup(env, dia(fecha))).rejects.toThrow(/Falta el parcial/);
    const reiniciado = (await leerProgreso(fecha)) as Fila;
    expect(reiniciado.en_curso).toBeNull();
    expect(reiniciado.en_curso_hasta).toBeNull();
    expect(await leerManifest(fecha)).toBeNull();

    expect((await ejecutarBackup(env, dia(fecha))).estado).toBe('completo');
    const manifest = await verificarBackupCompleto(fecha);
    expect(manifest.tablas.find((t) => t.tabla === 'audit_log')?.segmentos_gzip).toEqual([0]);
  });
});

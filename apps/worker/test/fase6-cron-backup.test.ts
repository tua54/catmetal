// Tarea 6.1: backup diario paginado de D1 a R2 (ADR 0014, enmendada por las ADR 0016, 0020 y
// 0021). D1 y R2 locales reales.
// Cada prueba usa una fecha distinta: los archivos de R2 de un día no interfieren con otro. La base
// se comparte en el archivo y crece; cada verificación compara contra su contenido ACTUAL.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ejecutarBackup,
  fechaBackup,
  prefijoDelDia,
  sentenciaPagina,
  sinColumnasAuxiliares,
  type ResultadoBackup,
} from '../src/cron/backup';
import { Presupuesto } from '../src/cron/presupuesto';
import { TABLAS_BACKUP } from '../src/cron/tablas';
import {
  completas,
  filasDeTabla,
  leerManifest,
  leerProgreso,
  sembrarAuditoria,
  sembrarTodo,
  verificarBackupCompleto,
  type Fila,
} from './fase6-cron-helpers';

// Pruebas pesadas (páginas de una fila, muchas invocaciones): convención del Worker para tiempos.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const dia = (fecha: string) => new Date(`${fecha}T08:00:00.000Z`);

interface ProgresoEnAuditoria {
  en_curso: { tabla: string; filas: number; cursor: number[]; parcial: string };
  en_curso_hasta: string | null;
  invocaciones: number;
}

/**
 * Invocaciones con presupuesto mínimo hasta quedar en pausa A MITAD de `audit_log` (la última tabla
 * desde la ADR 0021) con un parcial guardado. Devuelve el progreso de ese momento.
 */
async function pausarEnAuditoria(fecha: string): Promise<ProgresoEnAuditoria> {
  for (let i = 0; i < 100; i++) {
    const r = await ejecutarBackup(env, dia(fecha), {
      tamanoPagina: 100,
      presupuesto: new Presupuesto({ maxOperaciones: 40 }),
    });
    expect(r.estado).toBe('pausado');
    const progreso = (await leerProgreso(fecha)) as ProgresoEnAuditoria | null;
    if (progreso?.en_curso?.tabla === 'audit_log' && progreso.en_curso.parcial !== null) {
      return progreso;
    }
  }
  throw new Error('El backup nunca quedó en pausa dentro de audit_log');
}

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

  // ADR 0020: `columnas` estima el tamaño de cada fila en SQL; si falta una, la cota por bytes no
  // la contaría.
  it('declara exactamente las columnas de cada tabla', async () => {
    for (const tabla of TABLAS_BACKUP) {
      const { results } = await env.DB.prepare('SELECT name FROM pragma_table_info(?)')
        .bind(tabla.nombre)
        .all<{ name: string }>();
      expect([...tabla.columnas].sort(), tabla.nombre).toEqual(results.map((r) => r.name).sort());
      expect(tabla.columnas.some((c) => c.startsWith('__bk_'))).toBe(false);
    }
  });

  // ADR 0021: `audit_log` al final (lema de cobertura de la restauración); el resto, hijos antes que
  // padres (ADR 0014). Las lecturas del backup deben ir a la base primaria: si algún día se usa la
  // Sessions API o réplicas de lectura de D1, hay que revisar la ADR 0021 (P5).
  it('exporta hijos antes que padres y audit_log al final (ADR 0014 y 0021)', () => {
    expect(TABLAS_BACKUP.map((t) => t.nombre)).toEqual([
      'sync_mutations',
      'validations',
      'evidences',
      'incidents',
      'consumptions',
      'order_planned_materials',
      'order_supervisors',
      'refresh_tokens',
      'login_cupos',
      'devices',
      'settings',
      'production_orders',
      'materials',
      'users',
      'audit_log',
    ]);
    expect(TABLAS_BACKUP.filter((t) => t.acotadaPorSeqFinal === true).map((t) => t.nombre)).toEqual(
      ['audit_log'],
    );
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
    // ADR 0020: cada fila trae las columnas auxiliares de la cota por bytes, que no se exportan.
    expect(results.map(sinColumnasAuxiliares)).toEqual(todas.slice(1));
    expect(results[0]).toMatchObject({ __bk_total: todas.length - 1, __bk_n: todas.length - 1 });
  });
});

describe('backup completo en una invocación', () => {
  it('genera un archivo por tabla y el manifest con conteos, bytes y sha256 correctos', async () => {
    const fecha = '2026-11-01';
    const presupuesto = new Presupuesto();
    const resultado = await ejecutarBackup(env, dia(fecha), { presupuesto });

    const manifest = await verificarBackupCompleto(fecha);
    const archivos = completas(manifest);
    expect(archivos).toHaveLength(TABLAS_BACKUP.length);
    expect(resultado).toEqual({
      estado: 'completo',
      fecha,
      tablas: TABLAS_BACKUP.length,
      filas: archivos.reduce((n, t) => n + t.filas, 0),
      bytes: archivos.reduce((n, t) => n + t.bytes, 0),
      operaciones: presupuesto.usadas,
    });
    // Una sola invocación: un único miembro gzip por archivo.
    for (const entrada of archivos) {
      expect(entrada.segmentos_gzip, entrada.tabla).toEqual([0]);
      expect(entrada.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // Paginación de audit_log (> 1203 filas): ninguna fila repetida ni perdida, en orden de seq.
    const auditoria = archivos.find((t) => t.tabla === 'audit_log');
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
    // ADR 0020 y 0021: formato 2, estado global y por tabla, marca de corte y `seq_final`. Sin
    // escrituras durante el backup, el corte y `seq_final` coinciden con el MAX(seq) actual, y
    // `audit_log` tiene exactamente los seq 1..seq_final.
    expect(manifest.formato).toBe(2);
    expect(manifest.estado).toBe('completo');
    expect(manifest.tablas.every((t) => t.estado === 'completa')).toBe(true);
    expect(manifest.seq_inicial).toBe(maximo[0]?.seq);
    expect(manifest.corte.seq).toBe(maximo[0]?.seq);
    expect(Number.isNaN(Date.parse(manifest.corte.at))).toBe(false);
    expect(manifest.seq_final).toBe(maximo[0]?.seq);
    expect(auditoria?.filas).toBe(manifest.seq_final);
    expect(manifest.epoca).toBe(JSON.parse(String(epoca[0]?.valor)));
    expect(manifest.ultima_migracion).toBe(migracion[0]?.name);
    expect(manifest.ultima_migracion).toMatch(/^\d{4}_.+\.sql$/);
    expect(Number.isNaN(Date.parse(manifest.generado_at))).toBe(false);

    // Presupuesto: unas pocas páginas para audit_log (la ventana de medición crece desde 64 filas,
    // ADR 0020), ~1 por tabla y el guardado de cada intento: sigue muy lejos del límite de 1000.
    expect(presupuesto.usadas).toBeLessThan(100);
  });

  it('incluye todas las columnas, también los hashes (el backup debe poder restaurar)', async () => {
    const fecha = '2026-11-02';
    await ejecutarBackup(env, dia(fecha));
    const manifest = await verificarBackupCompleto(fecha);
    const usuarios = completas(manifest).find((t) => t.tabla === 'users');
    const tokens = completas(manifest).find((t) => t.tabla === 'refresh_tokens');
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
    const antes = await env.BACKUPS.list({ prefix: base });

    const presupuesto = new Presupuesto();
    const segunda = await ejecutarBackup(env, new Date(`${fecha}T09:30:00.000Z`), { presupuesto });
    expect(segunda).toEqual({ estado: 'ya_existia', fecha });
    expect(presupuesto.usadas).toBe(1);
    const despues = await env.BACKUPS.list({ prefix: base });
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
    // audit_log es la última tabla (ADR 0021): invocaciones con presupuesto mínimo hasta quedar en
    // pausa a mitad de ella, con un parcial guardado.
    const progreso = await pausarEnAuditoria(fecha);
    expect(await leerManifest(fecha)).toBeNull();
    expect(progreso.en_curso.tabla).toBe('audit_log');
    expect(progreso.en_curso.filas).toBeGreaterThan(0);
    expect(progreso.en_curso.filas).toBeLessThan(1203);
    expect(progreso.en_curso.cursor).toHaveLength(1);
    expect(progreso.en_curso_hasta).toBeNull();
    expect(progreso.invocaciones).toBeGreaterThanOrEqual(1);
    expect(await env.BACKUPS.head(progreso.en_curso.parcial)).not.toBeNull();

    const segunda = await ejecutarBackup(env, new Date(`${fecha}T08:30:00.000Z`), {
      tamanoPagina: 100,
    });
    expect(segunda.estado).toBe('completo');
    const manifest = await verificarBackupCompleto(fecha);
    // audit_log quedó en al menos dos miembros gzip: uno por invocación que la escribió.
    const auditoria = completas(manifest).find((t) => t.tabla === 'audit_log');
    expect(auditoria?.segmentos_gzip.length).toBeGreaterThanOrEqual(2);
    expect(await env.BACKUPS.head(progreso.en_curso.parcial)).toBeNull();
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
    const auditoria = completas(manifest).find((t) => t.tabla === 'audit_log');
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
    await env.BACKUPS.put(clave, JSON.stringify(arrendado));

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
    const progreso = await pausarEnAuditoria(fecha);
    // Se pierde el parcial (por ejemplo, borrado a mano).
    await env.BACKUPS.delete(progreso.en_curso.parcial);

    await expect(ejecutarBackup(env, dia(fecha))).rejects.toThrow(/Falta el parcial/);
    const reiniciado = (await leerProgreso(fecha)) as Fila;
    expect(reiniciado.en_curso).toBeNull();
    expect(reiniciado.en_curso_hasta).toBeNull();
    // ADR 0020: el intento fallido queda contado con su motivo (aún no llega al tope).
    expect(reiniciado.intentos).toEqual({ audit_log: 1 });
    expect(reiniciado.motivos).toEqual({
      audit_log: 'Error: Falta el parcial del backup de audit_log',
    });
    expect(await leerManifest(fecha)).toBeNull();

    expect((await ejecutarBackup(env, dia(fecha))).estado).toBe('completo');
    const manifest = await verificarBackupCompleto(fecha);
    const auditoria = completas(manifest).find((t) => t.tabla === 'audit_log');
    expect(auditoria?.segmentos_gzip).toEqual([0]);
  });
});

describe('bucket propio de los backups (F6-08)', () => {
  /** Todas las claves de un bucket (paginando el listado). */
  async function clavesDe(bucket: R2Bucket): Promise<string[]> {
    const claves: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const pagina = await bucket.list(cursor === undefined ? {} : { cursor });
      claves.push(...pagina.objects.map((o) => o.key));
      if (!pagina.truncated) {
        return claves;
      }
      cursor = pagina.cursor;
    }
  }

  // La subida multipart se verifica igual en fase6-cron-multipart.test.ts (partes reales de 5 MiB).
  it('tablas, manifest, progreso y parciales van a BACKUPS y nada a EVIDENCE', async () => {
    const fecha = '2026-11-15';
    const base = prefijoDelDia(fecha);
    const evidenciasAntes = await clavesDe(env.EVIDENCE);

    // Mismo corte que en «reanudación»: pausa a mitad de audit_log con un parcial guardado.
    const progreso = await pausarEnAuditoria(fecha);
    expect(await env.EVIDENCE.head(`${base}progreso.json`)).toBeNull();
    expect(progreso.en_curso.parcial.startsWith(`${base}_parciales/`)).toBe(true);
    expect(await env.BACKUPS.head(progreso.en_curso.parcial)).not.toBeNull();
    expect(await env.EVIDENCE.head(progreso.en_curso.parcial)).toBeNull();
    expect(await clavesDe(env.EVIDENCE)).toEqual(evidenciasAntes);

    const completa = await ejecutarBackup(env, new Date(`${fecha}T08:30:00.000Z`), {
      tamanoPagina: 100,
    });
    expect(completa.estado).toBe('completo');
    const manifest = await verificarBackupCompleto(fecha);
    for (const entrada of completas(manifest)) {
      expect(await env.BACKUPS.head(`${base}${entrada.archivo}`), entrada.tabla).not.toBeNull();
    }
    expect(await env.BACKUPS.head(`${base}manifest.json`)).not.toBeNull();
    // Ni un objeto del backup (ni de ningún otro día) en el bucket de evidencias.
    expect((await env.EVIDENCE.list({ prefix: 'backups/' })).objects).toEqual([]);
    expect(await clavesDe(env.EVIDENCE)).toEqual(evidenciasAntes);
  });
});

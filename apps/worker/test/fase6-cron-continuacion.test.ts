// ADR 0016 (revisión de la Fase 3, A3): crons de continuación del backup, presupuestos separados de
// D1 y R2, `seq_final` en el manifest y el error `backup_incompleto_del_dia`. D1 y R2 locales reales.
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ejecutarBackup, prefijoDelDia, TAMANO_PAGINA } from '../src/cron/backup';
import {
  CRON_CONTINUACION,
  CRON_INICIO,
  ejecutarCron,
  HORA_ULTIMA_CONTINUACION_UTC,
  modoDeCron,
} from '../src/cron/ejecutar';
import {
  MAX_CONSULTAS_D1_POR_INVOCACION,
  MAX_OPERACIONES_R2_POR_INVOCACION,
  Presupuesto,
} from '../src/cron/presupuesto';
import {
  leerManifest,
  leerProgreso,
  sembrarAuditoria,
  sembrarTodo,
  verificarBackupCompleto,
  type Fila,
} from './fase6-cron-helpers';

const a = (fecha: string, hora: number) =>
  new Date(`${fecha}T${String(hora).padStart(2, '0')}:00:00.000Z`);

beforeAll(async () => {
  await sembrarTodo();
  await sembrarAuditoria(1203);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function espiarLogs() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => log.mock.calls.map((c) => JSON.parse(String(c[0])) as Fila);
}

/** Inicio pausado a propósito (pocas operaciones y páginas de 100 filas). */
async function inicioPausado(fecha: string) {
  const r = await ejecutarBackup(env, a(fecha, 8), {
    tamanoPagina: 100,
    presupuesto: new Presupuesto({ maxOperaciones: 40 }),
  });
  expect(r.estado).toBe('pausado');
}

async function maxSeq(): Promise<number> {
  const fila = await env.DB.prepare('SELECT MAX(seq) AS seq FROM audit_log').first<{
    seq: number;
  }>();
  return fila?.seq ?? 0;
}

describe('configuración', () => {
  it('constantes de la ADR 0016: crons, página de 2000 y presupuestos separados', () => {
    expect(CRON_INICIO).toBe('0 8 * * *');
    expect(CRON_CONTINUACION).toBe('0 9-13 * * *');
    expect(HORA_ULTIMA_CONTINUACION_UTC).toBe(13);
    expect(TAMANO_PAGINA).toBe(2000);
    expect(MAX_CONSULTAS_D1_POR_INVOCACION).toBe(950);
    expect(MAX_OPERACIONES_R2_POR_INVOCACION).toBeLessThan(10_000);
    expect(modoDeCron('0 8 * * *')).toBe('inicio');
    expect(modoDeCron('0 9-13 * * *')).toBe('continuacion');
    // Un disparo manual (`wrangler dev --test-scheduled`) se trata como inicio.
    expect(modoDeCron('* * * * *')).toBe('inicio');
  });
});

describe('modo continuación', () => {
  it('sin progreso.json no hace nada (no inicia un backup nuevo)', async () => {
    const fecha = '2027-01-01';
    const r = await ejecutarBackup(env, a(fecha, 9), { modo: 'continuacion' });
    expect(r).toEqual({ estado: 'sin_iniciar', fecha });
    const objetos = await env.BACKUPS.list({ prefix: prefijoDelDia(fecha) });
    expect(objetos.objects).toEqual([]);
  });

  it('con el manifest del día ya escrito no hace nada', async () => {
    const fecha = '2027-01-02';
    expect((await ejecutarBackup(env, a(fecha, 8))).estado).toBe('completo');
    const presupuesto = new Presupuesto();
    const r = await ejecutarBackup(env, a(fecha, 10), { modo: 'continuacion', presupuesto });
    expect(r).toEqual({ estado: 'ya_existia', fecha });
    expect(presupuesto.usadas).toBe(1);
  });

  it('continúa un backup en pausa hasta completarlo; seq_final es MAX(seq) al terminar', async () => {
    const fecha = '2027-01-03';
    await inicioPausado(fecha);
    const progreso = (await leerProgreso(fecha)) as { seq_inicial: number };
    // Escrituras entre el inicio y la continuación (el backup no es una foto de un instante).
    await sembrarAuditoria(5);
    const r = await ejecutarBackup(env, a(fecha, 9), { modo: 'continuacion', tamanoPagina: 100 });
    expect(r.estado).toBe('completo');
    const manifest = await verificarBackupCompleto(fecha);
    expect(manifest.seq_inicial).toBe(progreso.seq_inicial);
    expect(manifest.seq_final).toBe(await maxSeq());
    expect(manifest.seq_final).toBeGreaterThanOrEqual(manifest.seq_inicial + 5);
  });

  it('seq_final también va en un backup completo en una sola invocación', async () => {
    const fecha = '2027-01-04';
    await ejecutarBackup(env, a(fecha, 8));
    const manifest = await leerManifest(fecha);
    expect(manifest?.seq_final).toBe(await maxSeq());
    expect(manifest?.seq_final).toBeGreaterThanOrEqual(manifest?.seq_inicial ?? Infinity);
  });
});

describe('presupuestos separados de D1 y R2', () => {
  it('cuenta por separado las consultas a D1 y las operaciones de R2', async () => {
    const presupuesto = new Presupuesto();
    expect((await ejecutarBackup(env, a('2027-01-05', 8), { presupuesto })).estado).toBe(
      'completo',
    );
    expect(presupuesto.usadasD1).toBeGreaterThan(14); // ≥ una página por tabla
    expect(presupuesto.usadasR2).toBeGreaterThan(14); // ≥ un put + una relectura por tabla
    expect(presupuesto.usadas).toBe(presupuesto.usadasD1 + presupuesto.usadasR2);
    expect(presupuesto.usadasD1).toBeLessThan(MAX_CONSULTAS_D1_POR_INVOCACION);
  });

  it('el tope de D1 pausa aunque R2 tenga margen', async () => {
    const fecha = '2027-01-06';
    const presupuesto = new Presupuesto({ maxConsultasD1: 25 });
    const r = await ejecutarBackup(env, a(fecha, 8), { tamanoPagina: 100, presupuesto });
    expect(r.estado).toBe('pausado');
    expect(presupuesto.usadasD1).toBeLessThanOrEqual(25);
    expect(presupuesto.usadasR2).toBeLessThan(presupuesto.maxOperacionesR2);
  });

  it('el tope de R2 también pausa', async () => {
    const fecha = '2027-01-07';
    const presupuesto = new Presupuesto({ maxOperacionesR2: 12 });
    const r = await ejecutarBackup(env, a(fecha, 8), { presupuesto });
    expect(r.estado).toBe('pausado');
    expect(presupuesto.usadasR2).toBeLessThanOrEqual(12);
    // Se completa en continuaciones.
    for (let hora = 9; hora <= 13; hora += 1) {
      const c = await ejecutarBackup(env, a(fecha, hora), {
        modo: 'continuacion',
        presupuesto: new Presupuesto({ maxOperacionesR2: 30 }),
      });
      if (c.estado === 'completo') {
        break;
      }
    }
    await verificarBackupCompleto(fecha);
  });
});

describe('ejecutarCron con continuaciones', () => {
  it('la continuación de las 13:00 UTC que termina en pausa registra backup_incompleto_del_dia', async () => {
    const fecha = '2027-01-08';
    await inicioPausado(fecha);
    const eventos = espiarLogs();
    const r = await ejecutarCron(
      env,
      { cron: CRON_CONTINUACION, scheduledTime: a(fecha, 13).getTime() },
      { ahora: a(fecha, 13), presupuesto: new Presupuesto({ maxOperaciones: 30 }) },
    );
    expect(r).toEqual({ backup: 'pausado', mantenimiento: 'omitido' });
    expect(eventos()).toContainEqual(
      expect.objectContaining({
        nivel: 'error',
        evento: 'backup_incompleto_del_dia',
        fecha,
        estado: 'pausado',
      }),
    );
  });

  it('una continuación anterior a las 13:00 en pausa solo avisa; no es un error del día', async () => {
    const fecha = '2027-01-09';
    await inicioPausado(fecha);
    const eventos = espiarLogs();
    const r = await ejecutarCron(
      env,
      { cron: CRON_CONTINUACION, scheduledTime: a(fecha, 12).getTime() },
      { ahora: a(fecha, 12), presupuesto: new Presupuesto({ maxOperaciones: 30 }) },
    );
    expect(r.backup).toBe('pausado');
    expect(eventos().map((e) => e.evento)).not.toContain('backup_incompleto_del_dia');
    expect(eventos()).toContainEqual(
      expect.objectContaining({ nivel: 'aviso', evento: 'backup_resumen', estado: 'pausado' }),
    );
  });

  it('a las 13:00 sin ningún backup iniciado hoy también es backup_incompleto_del_dia', async () => {
    const fecha = '2027-01-10';
    const eventos = espiarLogs();
    const r = await ejecutarCron(
      env,
      { cron: CRON_CONTINUACION, scheduledTime: a(fecha, 13).getTime() },
      { ahora: a(fecha, 13) },
    );
    expect(r).toEqual({ backup: 'sin_iniciar', mantenimiento: 'omitido' });
    expect(eventos()).toContainEqual(
      expect.objectContaining({ evento: 'backup_incompleto_del_dia', estado: 'sin_iniciar' }),
    );
  });

  it('la continuación completa el backup sin repetir el mantenimiento ni registrar error', async () => {
    const fecha = '2027-01-11';
    await inicioPausado(fecha);
    const eventos = espiarLogs();
    const r = await ejecutarCron(
      env,
      { cron: CRON_CONTINUACION, scheduledTime: a(fecha, 13).getTime() },
      { ahora: a(fecha, 13) },
    );
    expect(r).toEqual({ backup: 'completo', mantenimiento: 'omitido' });
    const nombres = eventos().map((e) => e.evento);
    expect(nombres).toEqual(['cron_ejecutado', 'backup_resumen', 'cron_fin']);
    expect(eventos().at(-1)).toMatchObject({
      nivel: 'info',
      consultas_d1: expect.any(Number) as number,
      operaciones_r2: expect.any(Number) as number,
    });
    await verificarBackupCompleto(fecha);
  });
});

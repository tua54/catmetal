// Tarea 6.1: mantenimiento del cron (ADR 0014, H14) y handler `scheduled` completo.
// D1 y R2 locales reales.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { fechaBackup, prefijoDelDia } from '../src/cron/backup';
import { describirError, ejecutarCron } from '../src/cron/ejecutar';
import {
  DIAS_RETENCION_REFRESH_TOKENS,
  ejecutarMantenimiento,
  LOTE_PURGA,
} from '../src/cron/mantenimiento';
import { Presupuesto } from '../src/cron/presupuesto';
import { TABLAS_BACKUP } from '../src/cron/tablas';
import { crearDispositivo, crearUsuario } from './fixtures-db';
import {
  insertarEnLotes,
  leerManifest,
  sembrarTodo,
  sentenciaRefresh,
  verificarBackupCompleto,
  type Fila,
} from './fase6-cron-helpers';

const DIA_MS = 86_400_000;
const AHORA = new Date('2026-12-15T08:00:00.000Z');
const haceDias = (dias: number, base = AHORA) =>
  new Date(base.getTime() - dias * DIA_MS).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

function espiarLogs() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    eventos: () => log.mock.calls.map((c) => JSON.parse(String(c[0])) as Fila),
    texto: () => log.mock.calls.map((c) => String(c[0])).join('\n'),
  };
}

async function existe(id: string): Promise<boolean> {
  const fila = await env.DB.prepare('SELECT 1 AS si FROM refresh_tokens WHERE id = ?')
    .bind(id)
    .first();
  return fila !== null;
}

async function usuarioConDispositivo() {
  const usuario = await crearUsuario('supervisor');
  const dispositivo = await crearDispositivo(usuario);
  return { usuario, dispositivo };
}

describe('purga de refresh_tokens', () => {
  // Revisión de la Fase 3 (B5): la purga es `expira_at < umbral` (con índice). Los casos usan
  // fechas coherentes con la vida de 30 días de un refresh token (nace 30 días antes de vencer, y
  // se revoca entre su creación y su vencimiento); antes había revocados de hace 100 días que
  // vencían en el futuro, imposibles con REFRESH_TOKEN_TTL_S. Un revocado se purga cuando lleva 90
  // días VENCIDO (a lo sumo 30 días más tarde que con la condición anterior por `revocado_at`).
  it('borra solo los vencidos hace más de 90 días (también los revocados)', async () => {
    const { usuario, dispositivo } = await usuarioConDispositivo();
    const casos = {
      revocadoHace100: { expira_at: haceDias(95), revocado_at: haceDias(100), purgar: true },
      vencidoHace100: { expira_at: haceDias(100), purgar: true },
      vencidoHace91: { expira_at: haceDias(91), purgar: true },
      // Revocado hace 91 días pero vencido hace solo 85: se conserva hasta cumplir 90 vencido.
      revocadoHace91VencidoHace85: {
        expira_at: haceDias(85),
        revocado_at: haceDias(91),
        purgar: false,
      },
      revocadoHace89: { expira_at: haceDias(80), revocado_at: haceDias(89), purgar: false },
      vencidoHace89: { expira_at: haceDias(89), purgar: false },
      revocadoAyer: { expira_at: haceDias(-20), revocado_at: haceDias(1), purgar: false },
      vigente: { expira_at: haceDias(-29), purgar: false },
    };
    const ids: Record<string, string> = {};
    const sentencias: D1PreparedStatement[] = [];
    for (const [nombre, caso] of Object.entries(casos)) {
      const { id, sentencia } = sentenciaRefresh(usuario, dispositivo, {
        expira_at: caso.expira_at,
        revocado_at: 'revocado_at' in caso ? caso.revocado_at : null,
      });
      ids[nombre] = id;
      sentencias.push(sentencia);
    }
    await insertarEnLotes(sentencias);

    const logs = espiarLogs();
    const resultado = await ejecutarMantenimiento(env, AHORA);

    expect(resultado.refresh_tokens_purgados).toBe(3);
    expect(resultado.purga_completa).toBe(true);
    expect(resultado.umbral_purga).toBe(haceDias(DIAS_RETENCION_REFRESH_TOKENS));
    for (const [nombre, caso] of Object.entries(casos)) {
      expect(await existe(ids[nombre] as string), nombre).toBe(!caso.purgar);
    }
    expect(logs.eventos()).toContainEqual(
      expect.objectContaining({
        nivel: 'info',
        evento: 'purga_refresh_tokens',
        purgados: 3,
        completa: true,
      }),
    );

    // Repetir no borra nada más (idempotente).
    expect((await ejecutarMantenimiento(env, AHORA)).refresh_tokens_purgados).toBe(0);
  });

  it('purga en lotes y respeta el presupuesto (lo que falte sigue en la siguiente ejecución)', async () => {
    const { usuario, dispositivo } = await usuarioConDispositivo();
    const total = 2 * LOTE_PURGA + 203;
    const viejos = Array.from(
      { length: total },
      () => sentenciaRefresh(usuario, dispositivo, { expira_at: haceDias(200) }).sentencia,
    );
    await insertarEnLotes(viejos);

    // 1 consulta de conteos + 2 lotes de purga.
    const logs = espiarLogs();
    const limitado = await ejecutarMantenimiento(
      env,
      AHORA,
      new Presupuesto({ maxOperaciones: 3 }),
    );
    expect(limitado.refresh_tokens_purgados).toBe(2 * LOTE_PURGA);
    expect(limitado.purga_completa).toBe(false);
    expect(logs.eventos()).toContainEqual(
      expect.objectContaining({ nivel: 'aviso', evento: 'purga_refresh_tokens', completa: false }),
    );

    const resto = await ejecutarMantenimiento(env, AHORA);
    expect(resto.refresh_tokens_purgados).toBe(203);
    expect(resto.purga_completa).toBe(true);
  });

  it('nunca toca tablas de negocio', async () => {
    const antes = await ejecutarMantenimiento(env, AHORA);
    const despues = await ejecutarMantenimiento(env, AHORA);
    for (const tabla of TABLAS_BACKUP) {
      expect(despues.filas[tabla.nombre], tabla.nombre).toBe(antes.filas[tabla.nombre]);
    }
  });
});

describe('tamaño de la base', () => {
  it('registra conteos por tabla y bytes, sin datos personales', async () => {
    await sembrarTodo();
    const logs = espiarLogs();
    const resultado = await ejecutarMantenimiento(env, AHORA);

    for (const tabla of TABLAS_BACKUP) {
      const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tabla.nombre}`).all<{
        n: number;
      }>();
      expect(resultado.filas[tabla.nombre], tabla.nombre).toBe(results[0]?.n);
    }
    const evento = logs.eventos().find((e) => e.evento === 'tamano_base');
    expect(evento).toMatchObject({
      nivel: 'info',
      filas_users: resultado.filas.users,
      filas_audit_log: resultado.filas.audit_log,
      filas_refresh_tokens: resultado.filas.refresh_tokens,
    });
    expect(Object.keys(evento ?? {}).filter((k) => k.startsWith('filas_'))).toHaveLength(
      TABLAS_BACKUP.length,
    );
    expect(evento?.bytes_base === null || Number(evento?.bytes_base) > 0).toBe(true);
    // Ningún correo, nombre ni hash en los logs.
    expect(logs.texto()).not.toMatch(/@|Usuario |pbkdf2/);
  });
});

describe('ejecutarCron', () => {
  it('un error del backup no impide el mantenimiento y queda registrado', async () => {
    const fecha = '2026-12-20';
    // progreso.json corrupto: el backup falla al leerlo (R2 real, sin mocks).
    await env.BACKUPS.put(`${prefijoDelDia(fecha)}progreso.json`, '{no es json');
    const logs = espiarLogs();
    const resultado = await ejecutarCron(
      env,
      { cron: '0 8 * * *', scheduledTime: Date.parse(`${fecha}T08:00:00.000Z`) },
      { ahora: new Date(`${fecha}T08:00:01.000Z`) },
    );
    expect(resultado).toEqual({ backup: 'error', mantenimiento: 'hecho' });
    const eventos = logs.eventos();
    expect(eventos.map((e) => e.evento)).toEqual([
      'cron_ejecutado',
      'backup_fallido',
      'tamano_base',
      'purga_refresh_tokens',
      'cron_fin',
    ]);
    expect(eventos[1]).toMatchObject({ nivel: 'error', evento: 'backup_fallido' });
    expect(String(eventos[1]?.error)).toMatch(/Error/);
    expect(eventos.at(-1)).toMatchObject({
      nivel: 'error',
      backup: 'error',
      mantenimiento: 'hecho',
    });
  });

  it('con el presupuesto agotado deja el backup pausado y aun así hace el mantenimiento', async () => {
    const fecha = '2026-12-21';
    const logs = espiarLogs();
    const resultado = await ejecutarCron(
      env,
      { cron: '0 8 * * *', scheduledTime: Date.parse(`${fecha}T08:00:00.000Z`) },
      {
        ahora: new Date(`${fecha}T08:00:01.000Z`),
        presupuesto: new Presupuesto({ maxOperaciones: 30 }),
      },
    );
    expect(resultado).toEqual({ backup: 'pausado', mantenimiento: 'hecho' });
    expect(logs.eventos()).toContainEqual(
      expect.objectContaining({ nivel: 'aviso', evento: 'backup_resumen', estado: 'pausado' }),
    );
    expect(await leerManifest(fecha)).toBeNull();
  });

  it('describe errores sin lanzar y truncados', () => {
    expect(describirError(new TypeError('x'))).toBe('TypeError: x');
    expect(describirError('texto')).toBe('Error desconocido');
    expect(describirError(new Error('y'.repeat(1000)))).toHaveLength(300);
  });
});

describe('handler scheduled', () => {
  it('hace el backup completo y el mantenimiento dentro de waitUntil', async () => {
    await sembrarTodo();
    const { usuario, dispositivo } = await usuarioConDispositivo();
    const viejo = sentenciaRefresh(usuario, dispositivo, {
      expira_at: new Date(Date.now() - 120 * DIA_MS).toISOString(),
    });
    await viejo.sentencia.run();

    const logs = espiarLogs();
    const antes = fechaBackup(new Date());
    const controller = createScheduledController({
      scheduledTime: new Date(`${antes}T08:00:00.000Z`),
      cron: '0 8 * * *',
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    const despues = fechaBackup(new Date());

    const eventos = logs.eventos();
    expect(eventos.map((e) => e.evento)).toEqual([
      'cron_ejecutado',
      'backup_resumen',
      'tamano_base',
      'purga_refresh_tokens',
      'cron_fin',
    ]);
    expect(eventos[1]).toMatchObject({ nivel: 'info', estado: 'completo' });
    expect(eventos.at(-1)).toMatchObject({
      nivel: 'info',
      backup: 'completo',
      mantenimiento: 'hecho',
    });
    // El día UTC de ejecución (a prueba del cambio de día durante la prueba).
    const fecha = (await leerManifest(antes)) !== null ? antes : despues;
    // El backup corre ANTES de la purga: conserva el token viejo; la base ya no lo tiene.
    await verificarBackupCompleto(fecha, { refresh_tokens: [viejo.id] });
    expect(await existe(viejo.id)).toBe(false);

    // Una invocación de respaldo el mismo día no repite nada.
    const logs2 = espiarLogs();
    const ctx2 = createExecutionContext();
    await worker.scheduled(controller, env, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(logs2.eventos().at(-1)).toMatchObject({
      evento: 'cron_fin',
      backup: 'ya_existia',
      mantenimiento: 'omitido',
    });
  });
});

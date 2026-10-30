// M3 (ADR 0020, puntos 1 y 3): una fila mayor que la cota no bloquea su tabla, y una tabla que
// falla de forma persistente queda `incompleta` sin impedir respaldar las demás. D1 y R2 locales
// reales; el fallo se inyecta con el gancho `fallarEn` de `OpcionesBackup` (no hay mocks de D1).
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ejecutarBackup,
  MAX_INTENTOS_TABLA,
  prefijoDelDia,
  type InfoPagina,
  type ResultadoBackup,
} from '../src/cron/backup';
import { CRON_CONTINUACION, CRON_INICIO, ejecutarCron } from '../src/cron/ejecutar';
import { Presupuesto } from '../src/cron/presupuesto';
import {
  leerManifest,
  leerProgreso,
  sembrarAuditoria,
  sembrarTodo,
  verificarBackupCompleto,
  type Fila,
} from './fase6-cron-helpers';
import { ahora, crearDispositivo, crearUsuario, insertar } from './fixtures-db';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const a = (fecha: string, hora: number) =>
  new Date(`${fecha}T${String(hora).padStart(2, '0')}:00:00.000Z`);

beforeAll(async () => {
  await sembrarTodo();
  // Tres filas de sync_mutations de ~60 KiB: con una cota de 1 KiB cada una supera la cota sola.
  const usuario = await crearUsuario('supervisor');
  const dispositivo = await crearDispositivo(usuario);
  for (let i = 0; i < 3; i++) {
    const t = ahora();
    await insertar('sync_mutations', {
      mutation_id: uuidv7(),
      user_id: usuario,
      device_id: dispositivo,
      tipo: 'consumo.crear',
      resultado: 'rechazada',
      respuesta_json: '{"resultado":"rechazada","code":"VALIDACION"}',
      payload_json: JSON.stringify({ relleno: 'B'.repeat(60_000) }),
      procesada_at: t,
      created_at: t,
      updated_at: t,
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function espiarLogs() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => log.mock.calls.map((c) => JSON.parse(String(c[0])) as Fila);
}

describe('fila mayor que la cota de bytes', () => {
  it('entra en su página sin arrastrar a otra fila grande y la tabla termina', async () => {
    const fecha = '2027-04-01';
    const paginas: InfoPagina[] = [];
    const resultado = await ejecutarBackup(env, a(fecha, 8), {
      maxBytesPagina: 1024,
      observarPagina: (info) => paginas.push(info),
      presupuesto: new Presupuesto({ maxConsultasD1: 100_000 }),
    });
    expect(resultado.estado).toBe('completo');
    const grandes = paginas.filter((p) => p.tabla === 'sync_mutations' && p.bytesNdjson > 50_000);
    // Cada fila grande va en su propia página: la cota admite como mucho una fila de más (la que la
    // cruza), así que nunca hay dos filas de 60 KiB juntas.
    expect(grandes).toHaveLength(3);
    expect(grandes.every((p) => p.bytesNdjson < 120_000)).toBe(true);
    await verificarBackupCompleto(fecha);
  });
});

describe('tabla que falla de forma persistente (ADR 0020, punto 3)', () => {
  const fallarSync = (tabla: string) => {
    if (tabla === 'sync_mutations') {
      throw new Error('fallo simulado de sync_mutations');
    }
  };

  it(`tras ${String(MAX_INTENTOS_TABLA)} intentos queda incompleta y las demás se respaldan`, async () => {
    const fecha = '2027-04-02';
    const eventos = espiarLogs();
    const estados: ResultadoBackup['estado'][] = [];
    let errores = 0;
    for (let i = 0; i < 10 && (await leerManifest(fecha)) === null; i++) {
      try {
        const r = await ejecutarBackup(env, a(fecha, 8 + Math.min(i, 5)), {
          fallarEn: fallarSync,
          modo: i === 0 ? 'inicio' : 'continuacion',
        });
        estados.push(r.estado);
      } catch (error) {
        errores += 1;
        expect(String(error)).toMatch(/fallo simulado/);
      }
    }
    // Dos invocaciones terminan en error (se reintenta en la siguiente); a la tercera la tabla queda
    // incompleta y el backup sigue con las demás en esa misma invocación.
    expect(errores).toBe(MAX_INTENTOS_TABLA - 1);
    expect(estados).toEqual(['parcial']);

    const manifest = await leerManifest(fecha);
    expect(manifest?.estado).toBe('parcial');
    const sync = manifest?.tablas.find((t) => t.tabla === 'sync_mutations');
    expect(sync).toEqual({
      tabla: 'sync_mutations',
      estado: 'incompleta',
      intentos: MAX_INTENTOS_TABLA,
      motivo: 'Error: fallo simulado de sync_mutations',
    });
    await verificarBackupCompleto(fecha, {}, ['sync_mutations']);
    expect(eventos()).toContainEqual(
      expect.objectContaining({
        nivel: 'error',
        evento: 'backup_tabla_incompleta',
        fecha,
        tabla: 'sync_mutations',
        intentos: MAX_INTENTOS_TABLA,
      }),
    );
  });

  it('una invocación que murió sin catch cuenta como intento (progreso con intentos agotados)', async () => {
    const fecha = '2027-04-03';
    // Inicio pausado a propósito, y luego se simula lo que deja una invocación que murió tres veces
    // en sync_mutations (por memoria o CPU): el contador ya guardado, sin error capturado.
    const pausado = await ejecutarBackup(env, a(fecha, 8), {
      presupuesto: new Presupuesto({ maxOperaciones: 8 }),
    });
    expect(pausado.estado).toBe('pausado');
    const clave = `${prefijoDelDia(fecha)}progreso.json`;
    const progreso = (await leerProgreso(fecha)) as Fila & { intentos: Record<string, number> };
    await env.BACKUPS.put(
      clave,
      JSON.stringify({
        ...progreso,
        en_curso: null,
        intentos: { ...progreso.intentos, sync_mutations: MAX_INTENTOS_TABLA },
      }),
    );

    const r = await ejecutarBackup(env, a(fecha, 9), { modo: 'continuacion' });
    expect(r).toMatchObject({ estado: 'parcial', tablas_incompletas: ['sync_mutations'] });
    const manifest = await leerManifest(fecha);
    expect(manifest?.tablas.find((t) => t.tabla === 'sync_mutations')).toEqual({
      tabla: 'sync_mutations',
      estado: 'incompleta',
      intentos: MAX_INTENTOS_TABLA,
      motivo: 'invocación interrumpida sin error capturado',
    });
    await verificarBackupCompleto(fecha, {}, ['sync_mutations']);
  });

  it('una tabla grande que avanza entre invocaciones no cuenta como fallo', async () => {
    const fecha = '2027-04-04';
    await sembrarAuditoria(40);
    const estados: ResultadoBackup['estado'][] = [];
    /** Invocaciones seguidas que terminaron en pausa dentro de la misma tabla. */
    let seguidas = 0;
    let maxSeguidas = 0;
    let anterior: string | null = null;
    for (let i = 0; i < 400; i++) {
      // Páginas de una fila y presupuesto justo para unas pocas: cada tabla cruza varias invocaciones.
      const r = await ejecutarBackup(env, a(fecha, 8), {
        tamanoPagina: 1,
        presupuesto: new Presupuesto({ maxOperaciones: 36 }),
      });
      estados.push(r.estado);
      if (r.estado !== 'pausado') {
        break;
      }
      seguidas = r.tabla_en_curso === anterior ? seguidas + 1 : 1;
      anterior = r.tabla_en_curso;
      maxSeguidas = Math.max(maxSeguidas, seguidas);
    }
    expect(estados.at(-1)).toBe('completo');
    // Alguna tabla cruzó más invocaciones que el tope de intentos, y aun así quedó completa.
    expect(maxSeguidas).toBeGreaterThan(MAX_INTENTOS_TABLA);
    await verificarBackupCompleto(fecha);
  });

  it('ejecutarCron registra backup_parcial y la última continuación no lo trata como incompleto', async () => {
    const fecha = '2027-04-05';
    const eventos = espiarLogs();
    // Agota los intentos con el gancho en tres disparos: inicio y dos continuaciones.
    await ejecutarCron(
      env,
      { cron: CRON_INICIO, scheduledTime: a(fecha, 8).getTime() },
      { ahora: a(fecha, 8), opcionesBackup: { fallarEn: fallarSync } },
    );
    await ejecutarCron(
      env,
      { cron: CRON_CONTINUACION, scheduledTime: a(fecha, 9).getTime() },
      { ahora: a(fecha, 9), opcionesBackup: { fallarEn: fallarSync } },
    );
    const r = await ejecutarCron(
      env,
      { cron: CRON_CONTINUACION, scheduledTime: a(fecha, 13).getTime() },
      { ahora: a(fecha, 13), opcionesBackup: { fallarEn: fallarSync } },
    );
    expect(r).toEqual({ backup: 'parcial', mantenimiento: 'omitido' });
    expect(eventos()).toContainEqual(
      expect.objectContaining({
        nivel: 'error',
        evento: 'backup_parcial',
        fecha,
        // Los logs no admiten listas: las tablas van separadas por coma.
        tablas_incompletas: 'sync_mutations',
      }),
    );
    expect(eventos().map((e) => e.evento)).not.toContain('backup_incompleto_del_dia');
  });
});

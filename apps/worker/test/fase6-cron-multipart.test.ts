// Tarea 6.1: tablas que superan una parte de R2 (5 MiB comprimidos) → multipart upload, también
// cuando la subida se reparte entre varias invocaciones. D1 y R2 locales reales.
//
// Para pasar de 5 MiB comprimidos con pocas filas se usan datos aleatorios (no se comprimen).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ejecutarBackup, TAMANO_PARTE_BYTES, type ResultadoBackup } from '../src/cron/backup';
import { Presupuesto } from '../src/cron/presupuesto';
import { leerProgreso, sembrarAuditoria, verificarBackupCompleto } from './fase6-cron-helpers';

const dia = (fecha: string) => new Date(`${fecha}T08:00:00.000Z`);

beforeAll(async () => {
  // ~1500 × 6 KB de base64 aleatorio ≈ 9 MB de NDJSON y ≈ 7 MB comprimidos: dos partes.
  await sembrarAuditoria(1500, 4500);
}, 120_000);

describe('multipart upload', () => {
  it('una tabla de más de 5 MiB comprimidos se sube por partes en una invocación', async () => {
    const fecha = '2026-12-01';
    const resultado = await ejecutarBackup(env, dia(fecha));
    expect(resultado.estado).toBe('completo');
    const manifest = await verificarBackupCompleto(fecha);
    const auditoria = manifest.tablas.find((t) => t.tabla === 'audit_log');
    expect(auditoria?.filas).toBeGreaterThanOrEqual(1500);
    expect(auditoria?.bytes).toBeGreaterThan(TAMANO_PARTE_BYTES);
    expect(auditoria?.segmentos_gzip).toEqual([0]);
  }, 120_000);

  it('reparte la subida entre invocaciones (parcial → partes → completar) sin duplicar', async () => {
    const fecha = '2026-12-02';
    const estados: ResultadoBackup['estado'][] = [];
    let progresoConPartes = false;
    for (let i = 0; i < 50; i++) {
      const resultado = await ejecutarBackup(env, dia(fecha), {
        tamanoPagina: 50,
        presupuesto: new Presupuesto({ maxOperaciones: 36 }),
      });
      estados.push(resultado.estado);
      if (resultado.estado === 'completo') {
        break;
      }
      const progreso = (await leerProgreso(fecha)) as {
        en_curso: { tabla: string; upload_id: string | null; partes: unknown[] } | null;
      };
      if (progreso.en_curso?.tabla === 'audit_log' && progreso.en_curso.partes.length > 0) {
        progresoConPartes = true;
        expect(progreso.en_curso.upload_id).toEqual(expect.any(String));
      }
    }
    expect(estados.at(-1)).toBe('completo');
    expect(estados[0]).toBe('pausado');
    // Hubo al menos una pausa con una subida multipart ya iniciada (reanudada después).
    expect(progresoConPartes).toBe(true);
    const manifest = await verificarBackupCompleto(fecha);
    const auditoria = manifest.tablas.find((t) => t.tabla === 'audit_log');
    expect(auditoria?.filas).toBeGreaterThanOrEqual(1500);
    expect(auditoria?.bytes).toBeGreaterThan(TAMANO_PARTE_BYTES);
    expect(auditoria?.segmentos_gzip.length).toBeGreaterThan(1);
  }, 120_000);
});

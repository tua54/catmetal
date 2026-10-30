// Helpers de las pruebas del cron de backup y mantenimiento (tarea 6.1, ADR 0014).
// Todo contra la D1 y el R2 locales reales del pool de Workers (sin mocks).
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import {
  archivoDeTabla,
  prefijoDelDia,
  type ArchivoBackup,
  type ManifestBackup,
} from '../src/cron/backup';
import { TABLAS_BACKUP } from '../src/cron/tablas';
import {
  crearAuditoria,
  crearConsumo,
  crearDispositivo,
  crearEscenario,
  crearEvidencia,
  crearMaterial,
  crearMutacionSync,
  crearNovedad,
  crearUsuario,
  decidir,
  sentenciaInsert,
} from './fixtures-db';
import { asignar, planear } from './fase2-helpers';

export type Fila = Record<string, unknown>;

/** Hex de un sha256 (WebCrypto sobre los bytes completos: verificación independiente). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function leerManifest(fecha: string): Promise<ManifestBackup | null> {
  const objeto = await env.EVIDENCE.get(`${prefijoDelDia(fecha)}manifest.json`);
  return objeto === null ? null : objeto.json<ManifestBackup>();
}

export async function leerProgreso(fecha: string): Promise<Fila | null> {
  const objeto = await env.EVIDENCE.get(`${prefijoDelDia(fecha)}progreso.json`);
  return objeto === null ? null : objeto.json<Fila>();
}

export async function bytesDe(clave: string): Promise<Uint8Array> {
  const objeto = await env.EVIDENCE.get(clave);
  expect(objeto, clave).not.toBeNull();
  return new Uint8Array(await (objeto as R2ObjectBody).arrayBuffer());
}

async function descomprimir(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Lee un archivo del backup y devuelve sus filas. Verifica el sha256 y el tamaño del manifest. El
 * `DecompressionStream` de workerd solo lee un miembro gzip, así que se descomprime cada segmento
 * declarado en el manifest (un archivo de una sola invocación tiene un único segmento: [0]).
 */
export async function leerTabla(fecha: string, entrada: ArchivoBackup): Promise<Fila[]> {
  const bytes = await bytesDe(`${prefijoDelDia(fecha)}${entrada.archivo}`);
  expect(bytes.length, entrada.tabla).toBe(entrada.bytes);
  expect(await sha256Hex(bytes), entrada.tabla).toBe(entrada.sha256);
  expect(entrada.segmentos_gzip[0], entrada.tabla).toBe(0);
  const limites = [...entrada.segmentos_gzip, bytes.length];
  let texto = '';
  for (let i = 0; i + 1 < limites.length; i++) {
    texto += await descomprimir(bytes.subarray(limites[i], limites[i + 1]));
  }
  if (texto === '') {
    return [];
  }
  expect(texto.endsWith('\n'), entrada.tabla).toBe(true);
  return texto
    .slice(0, -1)
    .split('\n')
    .map((linea) => JSON.parse(linea) as Fila);
}

export async function filasDeTabla(tabla: string): Promise<Fila[]> {
  const definicion = TABLAS_BACKUP.find((t) => t.nombre === tabla);
  if (definicion === undefined) {
    throw new Error(`Tabla desconocida: ${tabla}`);
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${tabla} ORDER BY ${definicion.pk.join(', ')}`,
  ).all<Fila>();
  return results;
}

/**
 * Comprueba el backup completo de `fecha` contra el contenido ACTUAL de la base: un archivo por
 * tabla, en el orden de la ADR, con exactamente las mismas filas (sin duplicados ni faltantes).
 */
export async function verificarBackupCompleto(
  fecha: string,
  /** Filas que el backup tiene y la base ya no (purgadas después por el mantenimiento). */
  purgadas: Record<string, string[]> = {},
): Promise<ManifestBackup> {
  const manifest = await leerManifest(fecha);
  expect(manifest).not.toBeNull();
  const m = manifest as ManifestBackup;
  expect(m.fecha).toBe(fecha);
  expect(m.tablas.map((t) => t.tabla)).toEqual(TABLAS_BACKUP.map((t) => t.nombre));
  for (const entrada of m.tablas) {
    expect(entrada.archivo).toBe(archivoDeTabla(entrada.tabla));
    const ids = purgadas[entrada.tabla] ?? [];
    const enBackup = (await leerTabla(fecha, entrada)).filter((f) => !ids.includes(String(f.id)));
    expect(entrada.filas - enBackup.length, entrada.tabla).toBe(ids.length);
    const enBase = await filasDeTabla(entrada.tabla);
    expect(enBackup.length, entrada.tabla).toBe(enBase.length);
    expect(enBackup, entrada.tabla).toEqual(enBase);
  }
  expect(await leerProgreso(fecha)).toBeNull();
  const parciales = await env.EVIDENCE.list({ prefix: `${prefijoDelDia(fecha)}_parciales/` });
  expect(parciales.objects).toEqual([]);
  return m;
}

/** Inserta sentencias en batches de `tamano` (D1 local; respeta todos los triggers). */
export async function insertarEnLotes(sentencias: D1PreparedStatement[], tamano = 100) {
  for (let i = 0; i < sentencias.length; i += tamano) {
    await env.DB.batch(sentencias.slice(i, i + tamano));
  }
}

/** Filas de auditoría sin orden (no tocan otras tablas). `relleno` agrega bytes aleatorios. */
export async function sembrarAuditoria(n: number, rellenoBytes = 0): Promise<void> {
  const t = new Date().toISOString();
  const sentencias: D1PreparedStatement[] = [];
  for (let i = 0; i < n; i++) {
    const datos =
      rellenoBytes > 0 ? JSON.stringify({ relleno: base64Aleatorio(rellenoBytes) }) : null;
    sentencias.push(
      sentenciaInsert('audit_log', {
        id: uuidv7(),
        entidad: 'consumptions',
        entidad_id: uuidv7(),
        accion: 'crear',
        datos_despues: datos,
        server_at: t,
        created_at: t,
        updated_at: t,
      }),
    );
  }
  await insertarEnLotes(sentencias, rellenoBytes > 0 ? 25 : 100);
}

function base64Aleatorio(bytes: number): string {
  const aleatorios = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...aleatorios));
}

export interface ValoresRefresh {
  expira_at: string;
  revocado_at?: string | null;
  created_at?: string;
}

/** Refresh token de prueba (hash hex aleatorio de 64 caracteres). */
export function sentenciaRefresh(userId: string, deviceId: string, valores: ValoresRefresh) {
  const id = uuidv7();
  // Por defecto nace 30 días antes de vencer (REFRESH_TOKEN_TTL_S).
  const t =
    valores.created_at ?? new Date(Date.parse(valores.expira_at) - 30 * 86_400_000).toISOString();
  const hash = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return {
    id,
    sentencia: sentenciaInsert('refresh_tokens', {
      id,
      user_id: userId,
      device_id: deviceId,
      token_hash: hash,
      familia_id: uuidv7(),
      expira_at: valores.expira_at,
      revocado_at: valores.revocado_at ?? null,
      reemplazado_por: null,
      created_at: t,
      updated_at: valores.revocado_at ?? t,
    }),
  };
}

/** Datos en todas las tablas: PK simples, compuestas (varias filas por `order_id`) y `settings`. */
export async function sembrarTodo(): Promise<void> {
  const e = await crearEscenario();
  const otroSupervisor = await crearUsuario('supervisor');
  await crearDispositivo(otroSupervisor);
  const otroMaterial = await crearMaterial();
  const tercerMaterial = await crearMaterial();
  await planear(e.orden, e.material, 100);
  await planear(e.orden, otroMaterial, 50);
  await planear(e.orden, tercerMaterial, 25);
  await asignar(e.orden, e.supervisor, e.jefe);
  await asignar(e.orden, otroSupervisor, e.jefe);
  const consumo = await crearConsumo(e);
  const otro = await crearConsumo(e, { lote: 'L-002' });
  await decidir(consumo, e.jefe, 'aprobado');
  await decidir(otro, e.jefe, 'rechazado');
  const novedad = await crearNovedad(consumo, e.supervisor);
  await crearEvidencia(novedad);
  await crearMutacionSync(e.supervisor, e.dispositivo);
  await crearMutacionSync(e.supervisor, e.dispositivo);
  await crearAuditoria({ order_id: e.orden, actor_id: e.jefe, device_id: e.dispositivoJefe });
  const vigente = sentenciaRefresh(e.supervisor, e.dispositivo, {
    expira_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await vigente.sentencia.run();
}

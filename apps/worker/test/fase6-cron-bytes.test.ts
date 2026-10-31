// M3 (ADR 0020): página del backup acotada por BYTES, no solo por filas. D1 y R2 locales reales.
//
// Escenario de la auditoría: un cliente llena `sync_mutations` de filas de ~64 KiB (rechazos
// guardados con `payload_json` máximo). Con 2000 filas por página, una página son ~128 MiB y el
// Worker se queda sin memoria en producción.
//
// La cota se prueba con el medidor `observarPagina` (ADR 0020, punto 5), NO con el runtime: workerd
// en local (Miniflare / pool de Vitest) no aplica el límite de 128 MB de producción, así que una
// página enorme no revienta aquí. La prueba falla porque el medidor registra una página por encima
// de la cota.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  archivoDeTabla,
  ejecutarBackup,
  MAX_BYTES_PAGINA,
  prefijoDelDia,
  type InfoPagina,
} from '../src/cron/backup';
import { Presupuesto } from '../src/cron/presupuesto';
import { TABLAS_BACKUP } from '../src/cron/tablas';
import { bytesDe, insertarEnLotes, leerManifest, sha256Hex } from './fase6-cron-helpers';
import { ahora, crearDispositivo, crearUsuario, sentenciaInsert } from './fixtures-db';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const FILAS = 2500;
/** `payload_json` de 64 000 caracteres ASCII (el CHECK admite hasta 65 536). */
const TAMANO_PAYLOAD = 64_000;
/** Tamaño máximo de una fila de D1 (~2 MB): una página puede pasar la cota en una fila. */
const MAX_FILA_D1 = 2_000_000;

const idsSync: string[] = [];

beforeAll(async () => {
  const usuario = await crearUsuario('supervisor');
  const dispositivo = await crearDispositivo(usuario);
  // Relleno comprimible (la cota es de memoria del Worker, no de R2): mismo bloque por fila, con
  // un prefijo único para que las filas no sean iguales. `{"relleno":"` + 8 + bloque + `"}` = TAMANO_PAYLOAD.
  const bloque = 'A'.repeat(TAMANO_PAYLOAD - 22);
  const sentencias: D1PreparedStatement[] = [];
  for (let i = 0; i < FILAS; i++) {
    const id = uuidv7();
    idsSync.push(id);
    const t = ahora();
    const relleno = `${String(i).padStart(8, '0')}${bloque}`;
    sentencias.push(
      sentenciaInsert('sync_mutations', {
        mutation_id: id,
        user_id: usuario,
        device_id: dispositivo,
        tipo: 'consumo.crear',
        resultado: 'rechazada',
        respuesta_json: '{"resultado":"rechazada","code":"VALIDACION"}',
        payload_json: JSON.stringify({ relleno }),
        procesada_at: t,
        created_at: t,
        updated_at: t,
      }),
    );
  }
  await insertarEnLotes(sentencias, 25);
});

/** Lee un NDJSON.gz de un solo miembro en streaming y devuelve las PK y el tamaño de cada línea. */
async function recorrerNdjson(
  clave: string,
): Promise<{ ids: string[]; maxLinea: number; payloads: number[] }> {
  const objeto = await env.BACKUPS.get(clave);
  expect(objeto, clave).not.toBeNull();
  const texto = (objeto as R2ObjectBody).body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream());
  const ids: string[] = [];
  const payloads: number[] = [];
  let maxLinea = 0;
  let resto = '';
  for await (const trozo of texto) {
    resto += trozo;
    let fin = resto.indexOf('\n');
    while (fin >= 0) {
      const linea = resto.slice(0, fin);
      resto = resto.slice(fin + 1);
      maxLinea = Math.max(maxLinea, linea.length);
      const fila = JSON.parse(linea) as { mutation_id: string; payload_json: string | null };
      ids.push(fila.mutation_id);
      payloads.push(fila.payload_json?.length ?? 0);
      fin = resto.indexOf('\n');
    }
  }
  expect(resto).toBe('');
  return { ids, maxLinea, payloads };
}

describe('página acotada por bytes (M3)', () => {
  it(`${String(FILAS)} filas de ~64 KiB completan el backup sin páginas por encima de la cota`, async () => {
    const fecha = '2027-03-01';
    const paginas: InfoPagina[] = [];
    const resultado = await ejecutarBackup(env, new Date(`${fecha}T08:00:00.000Z`), {
      presupuesto: new Presupuesto(),
      observarPagina: (info) => paginas.push(info),
    });
    expect(resultado.estado).toBe('completo');

    // El medidor vio todas las páginas de todas las tablas, y ninguna pasa la cota.
    const deSync = paginas.filter((p) => p.tabla === 'sync_mutations');
    expect(deSync.reduce((n, p) => n + p.filas, 0)).toBe(FILAS);
    const mayor = Math.max(...paginas.map((p) => p.bytesNdjson));
    expect(mayor).toBeLessThanOrEqual(2 * MAX_BYTES_PAGINA + MAX_FILA_D1);
    // La ventana de medición no mide 2000 filas de 64 KiB (ADR 0020: lectura acotada en SQLite).
    expect(Math.max(...deSync.map((p) => p.filasMedicion))).toBeLessThanOrEqual(256);

    // Manifest: conteos y sha256 cuadran con lo almacenado y con la base.
    const manifest = await leerManifest(fecha);
    expect(manifest?.estado).toBe('completo');
    for (const tabla of TABLAS_BACKUP) {
      const entrada = manifest?.tablas.find((t) => t.tabla === tabla.nombre);
      expect(entrada?.estado, tabla.nombre).toBe('completa');
      if (entrada?.estado !== 'completa') {
        continue;
      }
      const conteo = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${tabla.nombre}${tabla.nombre === 'audit_log' ? ' WHERE seq <= ?' : ''}`,
      )
        .bind(...(tabla.nombre === 'audit_log' ? [manifest?.seq_final ?? 0] : []))
        .first<{ n: number }>();
      expect(entrada.filas, tabla.nombre).toBe(conteo?.n);
      const bytes = await bytesDe(`${prefijoDelDia(fecha)}${archivoDeTabla(tabla.nombre)}`);
      expect(bytes.length, tabla.nombre).toBe(entrada.bytes);
      expect(await sha256Hex(bytes), tabla.nombre).toBe(entrada.sha256);
    }

    // Contenido de sync_mutations: todas las filas, una vez, en orden de PK y completas.
    const leido = await recorrerNdjson(
      `${prefijoDelDia(fecha)}${archivoDeTabla('sync_mutations')}`,
    );
    const esperados = [...idsSync].sort();
    expect(leido.ids.filter((id) => idsSync.includes(id))).toEqual(esperados);
    expect(Math.min(...leido.payloads.filter((n) => n > 1000))).toBe(TAMANO_PAYLOAD);
  });
});

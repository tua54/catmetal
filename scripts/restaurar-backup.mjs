#!/usr/bin/env node
// Restauración del backup diario de R2 (ADR 0021; docs/despliegue.md §9.2).
//
// Este script NO se conecta a Cloudflare ni ejecuta nada en una base: lee una carpeta con el
// manifest y los NDJSON comprimidos que una persona descargó, comprueba su integridad y escribe
// los archivos que la persona aplica después con `wrangler d1 execute … --file`:
//
//   restauracion.sql            guardia + borrado de triggers + datos + triggers (base recién migrada)
//   verificacion.sql            verificaciones que ABORTAN el archivo si alguna encuentra filas (R-02)
//   verificacion-detalle.sql    las mismas consultas, legibles: cada una debe devolver 0 filas
//   post-restauracion.sql       cambio de época con su auditoría (tras verificar)
//   informe-restauracion.json   qué se excluyó, revirtió o descartó, y qué hay que revisar o rehacer
//
// Todo en streaming (revisión de esquema R-01): cada NDJSON se descomprime y se lee línea a línea
// (`zlib.createGunzip` + `readline`) y el SQL se escribe sentencia a sentencia con
// `fs.createWriteStream`, respetando la contrapresión. Ninguna tabla ni el SQL se arman en un solo
// texto (Node limita un string a ~512 MiB).
//
// Uso:
//   node scripts/restaurar-backup.mjs --backup <carpeta> --salida <carpeta fuera del repo>
//     [--migraciones migrations] [--conservar-sin-auditoria] [--omitir-sync-mutations]
//
// `--omitir-sync-mutations` restaura sin ninguna fila de `sync_mutations`, igual que si la tabla
// hubiera quedado `incompleta` (ADR 0021, 4.1): es seguro, y sirve si esa tabla es enorme.
//
// Códigos de salida: 0 correcto; 1 uso o E/S; 2 integridad del backup o backup no admitido;
// 3 filas sin auditoría en el origen (se conservan con --conservar-sin-auditoria).
//
// La salida contiene hashes de contraseñas y datos personales (F6-03): el script se niega a
// escribirla dentro del repositorio. Node puro, sin dependencias; funciona en Windows y Linux.

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import {
  archivoSql,
  ErrorRestauracion,
  restaurarEnStreaming,
  triggersDeMigraciones,
} from './restauracion-nucleo.mjs';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class ErrorUso extends Error {}

function leerArgumentos(argv) {
  const opciones = {
    backup: null,
    salida: null,
    migraciones: join(raiz, 'migrations'),
    conservarSinAuditoria: false,
    omitirSyncMutations: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valor = () => {
      const siguiente = argv[i + 1];
      if (siguiente === undefined || siguiente.startsWith('--')) {
        throw new ErrorUso(`${arg} necesita un valor.`);
      }
      i += 1;
      return resolve(siguiente);
    };
    if (arg === '--backup') {
      opciones.backup = valor();
    } else if (arg === '--salida') {
      opciones.salida = valor();
    } else if (arg === '--migraciones') {
      opciones.migraciones = valor();
    } else if (arg === '--conservar-sin-auditoria') {
      opciones.conservarSinAuditoria = true;
    } else if (arg === '--omitir-sync-mutations') {
      opciones.omitirSyncMutations = true;
    } else {
      throw new ErrorUso(`Argumento desconocido: ${arg}`);
    }
  }
  if (opciones.backup === null || opciones.salida === null) {
    throw new ErrorUso('Faltan --backup y/o --salida.');
  }
  return opciones;
}

/** ¿`ruta` está dentro del repositorio? */
function dentroDelRepo(ruta) {
  const rel = relative(raiz, ruta);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function errorIntegridad(mensaje) {
  return new ErrorRestauracion('INTEGRIDAD', mensaje);
}

/** sha256 de un archivo, en streaming. */
async function sha256De(ruta) {
  const hash = createHash('sha256');
  for await (const trozo of createReadStream(ruta)) {
    hash.update(trozo);
  }
  return hash.digest('hex');
}

/** Lee el manifest y verifica (bytes y sha256, en streaming) cada tabla `completa`. */
async function verificarBackup(carpeta) {
  const rutaManifest = join(carpeta, 'manifest.json');
  if (!existsSync(rutaManifest)) {
    throw new ErrorUso(`No existe ${rutaManifest}: sin manifest el backup está sin terminar.`);
  }
  const manifest = JSON.parse(readFileSync(rutaManifest, 'utf8'));
  if (manifest.formato !== 2) {
    throw errorIntegridad(
      'El backup no es de formato 2 (ADR 0021): no se restaura con este script.',
    );
  }
  const archivos = new Map();
  for (const entrada of manifest.tablas ?? []) {
    if (entrada.estado !== 'completa' || entrada.tabla === 'refresh_tokens') {
      continue;
    }
    const ruta = join(carpeta, entrada.archivo);
    if (!existsSync(ruta)) {
      throw new ErrorUso(`Falta el archivo ${entrada.archivo} del manifest.`);
    }
    const bytes = statSync(ruta).size;
    if (bytes !== entrada.bytes) {
      throw errorIntegridad(
        `${entrada.archivo}: mide ${bytes} bytes y el manifest dice ${entrada.bytes}.`,
      );
    }
    if ((await sha256De(ruta)) !== entrada.sha256) {
      throw errorIntegridad(`${entrada.archivo}: el sha256 no coincide con el manifest.`);
    }
    archivos.set(entrada.tabla, ruta);
  }
  return { manifest, archivos };
}

/**
 * Filas de un NDJSON comprimido, una a una. `createGunzip` lee los gzip de varios miembros (uno
 * por invocación del cron que escribió la tabla).
 */
async function* filasDeArchivo(ruta) {
  if (statSync(ruta).size === 0) {
    return;
  }
  const lineas = createInterface({
    input: createReadStream(ruta).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const linea of lineas) {
    if (linea.trim() !== '') {
      yield JSON.parse(linea);
    }
  }
}

function leerMigraciones(carpeta) {
  return readdirSync(carpeta)
    .filter((nombre) => nombre.endsWith('.sql'))
    .map((nombre) => ({ nombre, contenido: readFileSync(join(carpeta, nombre), 'utf8') }));
}

/** Archivo de salida que se escribe a un temporal y solo se renombra si todo salió bien. */
function abrirSalida(ruta) {
  const temporal = `${ruta}.parcial`;
  const flujo = createWriteStream(temporal, { encoding: 'utf8' });
  return {
    async escribir(texto) {
      if (!flujo.write(texto)) {
        await once(flujo, 'drain');
      }
    },
    async cerrar() {
      flujo.end();
      await finished(flujo);
      renameSync(temporal, ruta);
    },
    descartar() {
      flujo.destroy();
      rmSync(temporal, { force: true });
    },
  };
}

function resumen(informe) {
  const lineas = [
    `Backup del ${informe.fecha}: corte en seq ${informe.corte.seq} (${informe.corte.at}), seq_final ${informe.seq_final}.`,
  ];
  for (const [tabla, c] of Object.entries(informe.tablas)) {
    lineas.push(
      `  ${tabla}: ${c.importadas} importadas de ${c.exportadas} (excluidas ${c.excluidas}, revertidas ${c.revertidas}, más recientes ${c.conservadas_mas_recientes}, recortadas ${c.recortadas})`,
    );
  }
  lineas.push(
    `  refresh_tokens: ${informe.refresh_tokens_omitidos} omitidos (todos inician sesión otra vez).`,
  );
  lineas.push(
    `Cambios posteriores al corte (rehacer lo hecho por REST): ${informe.cambios_tras_el_corte.length}`,
  );
  lineas.push(`Rechazos posteriores al corte (revisar): ${informe.rechazos_tras_el_corte.length}`);
  lineas.push(`Usuarios a revisar (seguridad): ${informe.revisar_seguridad.length}`);
  if (informe.sync_mutations.tabla_omitida) {
    lineas.push(
      informe.sync_mutations.omitida_por_opcion
        ? 'AVISO: sync_mutations se omitió (--omitir-sync-mutations) y se restaura vacía.'
        : 'AVISO: sync_mutations quedó incompleta en el backup y se restaura vacía.',
    );
  }
  return lineas.join('\n');
}

async function principal() {
  const opciones = leerArgumentos(process.argv.slice(2));
  if (dentroDelRepo(opciones.salida)) {
    throw new ErrorUso(
      'La salida contiene datos personales: use una carpeta FUERA del repositorio.',
    );
  }
  const { manifest, archivos } = await verificarBackup(opciones.backup);
  const triggers = triggersDeMigraciones(
    leerMigraciones(opciones.migraciones),
    manifest.ultima_migracion,
  );
  mkdirSync(opciones.salida, { recursive: true });
  const salida = abrirSalida(join(opciones.salida, 'restauracion.sql'));
  let resultado;
  try {
    const encabezado = [
      `Restauración del backup del ${manifest.fecha} (ADR 0021). Base: recién migrada hasta ${manifest.ultima_migracion}.`,
      'Generado por scripts/restaurar-backup.mjs. Contiene datos personales: no lo copie al repositorio.',
    ];
    await salida.escribir(archivoSql([], encabezado));
    resultado = await restaurarEnStreaming({
      manifest,
      triggers,
      conservarSinAuditoria: opciones.conservarSinAuditoria,
      omitirSyncMutations: opciones.omitirSyncMutations,
      leerTabla: (tabla) => {
        const ruta = archivos.get(tabla);
        if (ruta === undefined) {
          throw errorIntegridad(`No hay archivo verificado de ${tabla}.`);
        }
        return filasDeArchivo(ruta);
      },
      escribir: (sentencia) => salida.escribir(`${sentencia};\n`),
    });
    await salida.cerrar();
  } catch (error) {
    salida.descartar();
    throw error;
  }
  writeFileSync(
    join(opciones.salida, 'verificacion.sql'),
    archivoSql(resultado.verificacionAutofallante, [
      'Aborta (CHECK constraint failed: ok = 1) si alguna verificación encuentra filas.',
      'En ese caso, NO siga: descarte la base. verificacion-detalle.sql dice cuál falló.',
    ]),
  );
  const detalle = resultado.verificacion.flatMap((v) => [
    `-- ${v.nombre}: debe devolver 0 filas`,
    `${v.sql};`,
  ]);
  writeFileSync(join(opciones.salida, 'verificacion-detalle.sql'), `${detalle.join('\n')}\n`);
  writeFileSync(
    join(opciones.salida, 'post-restauracion.sql'),
    archivoSql(resultado.postRestauracion, [
      'Ejecutar SOLO si verificacion.sql terminó sin errores.',
    ]),
  );
  writeFileSync(
    join(opciones.salida, 'informe-restauracion.json'),
    `${JSON.stringify(resultado.informe, null, 2)}\n`,
  );
  console.log(resumen(resultado.informe));
  console.log(`Archivos escritos en ${opciones.salida}`);
}

try {
  await principal();
} catch (error) {
  if (error instanceof ErrorUso) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof ErrorRestauracion) {
    console.error(`Error: ${error.message}`);
    if (error.detalle !== null) {
      console.error(JSON.stringify(error.detalle, null, 2));
    }
    process.exit(error.codigo === 'SIN_AUDITORIA' ? 3 : 2);
  }
  console.error(error instanceof Error ? `Error: ${error.message}` : 'Error desconocido');
  process.exit(1);
}

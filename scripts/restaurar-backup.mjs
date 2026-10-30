#!/usr/bin/env node
// Restauración del backup diario de R2 (ADR 0021; docs/despliegue.md §9.2).
//
// Este script NO se conecta a Cloudflare ni ejecuta nada en una base: lee una carpeta con el
// manifest y los NDJSON comprimidos que una persona descargó, comprueba su integridad y escribe
// cuatro archivos que la persona aplica después con `wrangler d1 execute … --file`:
//
//   restauracion.sql          guardia + borrado de triggers + datos + triggers (base recién migrada)
//   verificacion.sql          cada consulta debe devolver 0 filas
//   post-restauracion.sql     cambio de época con su auditoría (tras verificar)
//   informe-restauracion.json qué se excluyó, revirtió o descartó, y qué hay que revisar o rehacer
//
// Uso:
//   node scripts/restaurar-backup.mjs --backup <carpeta> --salida <carpeta fuera del repo>
//     [--migraciones migrations] [--conservar-sin-auditoria]
//
// Códigos de salida: 0 correcto; 1 uso o E/S; 2 integridad del backup o backup no admitido;
// 3 filas sin auditoría en el origen (se conservan con --conservar-sin-auditoria).
//
// La salida contiene hashes de contraseñas y datos personales (F6-03): el script se niega a
// escribirla dentro del repositorio. Node puro, sin dependencias; funciona en Windows y Linux.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  archivoSql,
  ErrorRestauracion,
  filasDeNdjson,
  planificarRestauracion,
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

/** Lee, verifica (bytes y sha256 del manifest) y descomprime cada tabla `completa`. */
function leerBackup(carpeta) {
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
  const filas = {};
  for (const entrada of manifest.tablas ?? []) {
    if (entrada.estado !== 'completa' || entrada.tabla === 'refresh_tokens') {
      continue;
    }
    const ruta = join(carpeta, entrada.archivo);
    if (!existsSync(ruta)) {
      throw new ErrorUso(`Falta el archivo ${entrada.archivo} del manifest.`);
    }
    const bytes = readFileSync(ruta);
    if (bytes.length !== entrada.bytes) {
      throw errorIntegridad(
        `${entrada.archivo}: mide ${bytes.length} bytes y el manifest dice ${entrada.bytes}.`,
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entrada.sha256) {
      throw errorIntegridad(`${entrada.archivo}: el sha256 no coincide con el manifest.`);
    }
    // gunzip de Node lee los gzip de varios miembros (uno por invocación que escribió la tabla).
    const texto = bytes.length === 0 ? '' : gunzipSync(bytes).toString('utf8');
    filas[entrada.tabla] = filasDeNdjson(texto);
  }
  return { manifest, filas };
}

function leerMigraciones(carpeta) {
  return readdirSync(carpeta)
    .filter((nombre) => nombre.endsWith('.sql'))
    .map((nombre) => ({ nombre, contenido: readFileSync(join(carpeta, nombre), 'utf8') }));
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
    lineas.push('AVISO: sync_mutations quedó incompleta en el backup y se restaura vacía.');
  }
  return lineas.join('\n');
}

function principal() {
  const opciones = leerArgumentos(process.argv.slice(2));
  if (dentroDelRepo(opciones.salida)) {
    throw new ErrorUso(
      'La salida contiene datos personales: use una carpeta FUERA del repositorio.',
    );
  }
  const { manifest, filas } = leerBackup(opciones.backup);
  const triggers = triggersDeMigraciones(
    leerMigraciones(opciones.migraciones),
    manifest.ultima_migracion,
  );
  const plan = planificarRestauracion({
    manifest,
    filas,
    triggers,
    conservarSinAuditoria: opciones.conservarSinAuditoria,
  });
  mkdirSync(opciones.salida, { recursive: true });
  const encabezado = [
    `Restauración del backup del ${manifest.fecha} (ADR 0021). Base: recién migrada hasta ${manifest.ultima_migracion}.`,
    'Generado por scripts/restaurar-backup.mjs. Contiene datos personales: no lo copie al repositorio.',
  ];
  writeFileSync(
    join(opciones.salida, 'restauracion.sql'),
    archivoSql(plan.restauracion, encabezado),
  );
  const verificacion = plan.verificacion.flatMap((v) => [
    `-- ${v.nombre}: debe devolver 0 filas`,
    `${v.sql};`,
  ]);
  writeFileSync(join(opciones.salida, 'verificacion.sql'), `${verificacion.join('\n')}\n`);
  writeFileSync(
    join(opciones.salida, 'post-restauracion.sql'),
    archivoSql(plan.postRestauracion, [
      'Ejecutar SOLO si verificacion.sql devolvió 0 filas en todas las consultas.',
    ]),
  );
  writeFileSync(
    join(opciones.salida, 'informe-restauracion.json'),
    `${JSON.stringify(plan.informe, null, 2)}\n`,
  );
  console.log(resumen(plan.informe));
  console.log(`Archivos escritos en ${opciones.salida}`);
}

try {
  principal();
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

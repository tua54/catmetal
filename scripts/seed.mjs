#!/usr/bin/env node
// `pnpm db:seed:local`: datos de ejemplo en la D1 LOCAL (docs/spec.md §4 "Seed local", plan de la
// Fase 1, tarea 1.2).
//
// - Crea 1 admin, 1 jefe, 2 supervisores, 10 materiales de fundición y 2 órdenes con sus
//   supervisores asignados y sus materiales planeados. No crea consumos.
// - La contraseña de los usuarios sale de SEED_PASSWORD en apps/worker/.dev.vars (nunca del código y
//   nunca se imprime). Cada usuario tiene su propia sal.
// - Hash compatible con el Worker (ADR 0007): `pbkdf2-sha256$100000$<sal_b64>$<hash_b64>`, base64
//   estándar con relleno, sal de 16 bytes, 32 bytes de salida, SHA-256.
// - Idempotente: ids UUID v7 fijos y `INSERT ... ON CONFLICT DO NOTHING`. Se prefiere a la variante
//   "OR IGNORE" porque esa también descarta en silencio las filas que violan un CHECK o un NOT NULL;
//   así un dato inválido hace fallar el seed en vez de desaparecer. Nunca se usa el reemplazo
//   implícito de SQLite (ADR 0006).
// - Cada fila de negocio lleva su fila de audit_log (`accion = 'seed'`, actor NULL, id fijo), porque
//   /sync/pull recorre la auditoría (ADR 0005). `datos_despues` se arma en SQL a partir de la fila
//   guardada, así coincide con lo que quedó en la base aunque se ejecute varias veces. `seq` lo
//   asigna SQLite (trigger audit_log_seq_creciente).
// - SOLO local: ejecuta `wrangler d1 execute DB --local`. Se niega a correr con --remote, --env,
//   --preview o cualquier otro argumento que no conozca.
//
// Uso:
//   node scripts/seed.mjs [--persist-to <dir>]   siembra la base local (o la de <dir>)
//   node scripts/seed.mjs --reset                borra apps/worker/.wrangler/state, migra y siembra
//
// Node puro, sin dependencias; funciona en Windows y Linux.

import { spawnSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirWorker = join(raiz, 'apps', 'worker');
const rutaDevVars = join(dirWorker, '.dev.vars');
const dirEstadoLocal = join(dirWorker, '.wrangler', 'state');

// ---------------------------------------------------------------------------------------------
// Parámetros del hash (ADR 0007). No subir ITERACIONES: el runtime de Workers rechaza > 100.000.
// ---------------------------------------------------------------------------------------------
const ITERACIONES = 100000;
const BYTES_SAL = 16;
const BYTES_HASH = 32;
const LONGITUD_MINIMA_CONTRASENA = 10;

const REGEX_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function paso(texto) {
  console.log(`[seed] ${texto}`);
}

function fallar(texto) {
  console.error(`[seed] ERROR: ${texto}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Argumentos: lista blanca. Todo lo demás (en especial --remote, --env, --preview) se rechaza.
// ---------------------------------------------------------------------------------------------
const PROHIBIDOS = ['--remote', '--env', '-e', '--preview', '--config', '-c', '--cwd'];

function leerArgumentos(argv) {
  const opciones = { persistTo: null, reset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nombre = arg.split('=')[0];
    if (PROHIBIDOS.includes(nombre) || /^-e./.test(arg)) {
      fallar(`el seed solo corre contra la D1 LOCAL; no se admite "${nombre}".`);
    }
    if (arg === '--reset') {
      opciones.reset = true;
    } else if (arg === '--persist-to') {
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('-')) {
        fallar('--persist-to necesita un directorio.');
      }
      opciones.persistTo = resolve(valor);
      i += 1;
    } else if (arg.startsWith('--persist-to=')) {
      const valor = arg.slice('--persist-to='.length);
      if (valor === '') {
        fallar('--persist-to necesita un directorio.');
      }
      opciones.persistTo = resolve(valor);
    } else {
      fallar(
        `argumento desconocido "${arg}". Uso: node scripts/seed.mjs [--persist-to <dir>] [--reset]`,
      );
    }
  }
  if (opciones.reset && opciones.persistTo !== null) {
    fallar('--reset solo borra el estado local por defecto (apps/worker/.wrangler/state).');
  }
  return opciones;
}

// ---------------------------------------------------------------------------------------------
// .dev.vars
// ---------------------------------------------------------------------------------------------
function leerSeedPassword() {
  const ayuda = 'Ejecute `pnpm setup:dev-vars` para generarlo.';
  if (!existsSync(rutaDevVars)) {
    fallar(`no existe ${relative(raiz, rutaDevVars)}. ${ayuda}`);
  }
  let valor;
  for (const linea of readFileSync(rutaDevVars, 'utf8').split(/\r?\n/)) {
    const coincidencia = /^\s*SEED_PASSWORD\s*=\s*(.*?)\s*$/.exec(linea);
    if (coincidencia) {
      valor = coincidencia[1];
      const comillas = /^(["'])(.*)\1$/.exec(valor);
      if (comillas) {
        valor = comillas[2];
      }
    }
  }
  if (valor === undefined || valor === '') {
    fallar(`${relative(raiz, rutaDevVars)} no define SEED_PASSWORD. ${ayuda} (con --force)`);
  }
  if (valor.length < LONGITUD_MINIMA_CONTRASENA) {
    fallar(`SEED_PASSWORD debe tener al menos ${LONGITUD_MINIMA_CONTRASENA} caracteres.`);
  }
  return valor;
}

/**
 * `pbkdf2-sha256$100000$<sal_b64>$<hash_b64>` (ADR 0007). La contraseña entra como UTF-8 sin
 * normalizar, igual que `TextEncoder` en el Worker. Exportada para las pruebas.
 */
export function hashContrasena(contrasena, sal = randomBytes(BYTES_SAL)) {
  const hash = pbkdf2Sync(contrasena, sal, ITERACIONES, BYTES_HASH, 'sha256');
  return `pbkdf2-sha256$${ITERACIONES}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

// ---------------------------------------------------------------------------------------------
// Datos. Ids UUID v7 fijos (prefijo 019a3000, el mismo de migrations/0002). Grupo por entidad:
//   0001 usuarios · 0002 materiales · 0003 órdenes · 0010 auditoría del seed.
// La migración 0002 usa 019a3000-0000-... para la auditoría de settings: no se repite.
// ---------------------------------------------------------------------------------------------
const id = (grupo, n) => `019a3000-${grupo}-7000-8000-${String(n).padStart(12, '0')}`;

const U = {
  admin: id('0001', 1),
  jefe: id('0001', 2),
  supervisor1: id('0001', 3),
  supervisor2: id('0001', 4),
};

const USUARIOS = [
  { id: U.admin, nombre: 'Administrador Catmetal', email: 'admin@catmetal.test', rol: 'admin' },
  { id: U.jefe, nombre: 'Roberto Martínez', email: 'jefe@catmetal.test', rol: 'jefe' },
  {
    id: U.supervisor1,
    nombre: 'Juan Sánchez',
    email: 'supervisor1@catmetal.test',
    rol: 'supervisor',
  },
  {
    id: U.supervisor2,
    nombre: 'Laura Gómez',
    email: 'supervisor2@catmetal.test',
    rol: 'supervisor',
  },
];

// Costos de referencia en pesos colombianos por unidad (enteros).
const MATERIALES = [
  ['MP-001', 'Arena sílice', 'kg', 450],
  ['MP-002', 'Resina furánica', 'kg', 14500],
  ['MP-003', 'Catalizador para resina furánica', 'l', 12800],
  ['MP-004', 'Ferrosilicio 75 %', 'kg', 9800],
  ['MP-005', 'Chatarra de acero', 'kg', 1300],
  ['MP-006', 'Carbón coque', 'kg', 2600],
  ['MP-007', 'Ferromanganeso', 'kg', 8900],
  ['MP-008', 'Inoculante', 'kg', 16500],
  ['MP-009', 'Nodulizante FeSiMg', 'kg', 18500],
  ['MP-010', 'Pintura refractaria para moldes', 'l', 22000],
].map(([codigo, nombre, unidad, costo], i) => ({
  id: id('0002', i + 1),
  codigo,
  nombre,
  unidad,
  costo_unitario_cop: costo,
}));

const M = Object.fromEntries(MATERIALES.map((m) => [m.codigo, m]));

const O = { op0587: id('0003', 1), op0588: id('0003', 2) };

/** "Hoy en la mañana" en Bogotá (UTC-5, sin horario de verano): 07:00 locales, sin pasar de ahora. */
function hoyEnLaManana(ahora) {
  const fechaBogota = new Date(ahora.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
  const manana = new Date(`${fechaBogota}T12:00:00.000Z`);
  return (manana < ahora ? manana : ahora).toISOString();
}

function construirDatos(contrasena, ahora) {
  const t = ahora.toISOString();
  const marcas = { created_at: t, updated_at: t };

  const usuarios = USUARIOS.map((u) => ({
    ...u,
    email: u.email.toLowerCase(),
    password_hash: hashContrasena(contrasena),
    activo: 1,
    intentos_fallidos: 0,
    bloqueado_hasta: null,
    ...marcas,
  }));

  const materiales = MATERIALES.map((m) => ({ ...m, activo: 1, ...marcas }));

  const ordenes = [
    {
      id: O.op0587,
      codigo: 'OP-2026-0587',
      linea: 'Moldeo 1',
      estado: 'en_proceso',
      fecha_inicio: hoyEnLaManana(ahora),
      fecha_fin: null,
      creada_por: U.jefe,
      ...marcas,
    },
    {
      id: O.op0588,
      codigo: 'OP-2026-0588',
      linea: 'Fusión 2',
      estado: 'planeada',
      fecha_inicio: null,
      fecha_fin: null,
      creada_por: U.jefe,
      ...marcas,
    },
  ];

  const supervisores = [
    [O.op0587, U.supervisor1],
    [O.op0587, U.supervisor2],
    [O.op0588, U.supervisor2],
  ].map(([order_id, user_id]) => ({
    order_id,
    user_id,
    asignado_por: U.admin,
    activo: 1,
    ...marcas,
  }));

  // Moldeo 1 (hierro nodular): arena, resina y catalizador del moldeo, pintura de moldes y el
  // tratamiento del metal. Fusión 2: carga del horno y ferroaleaciones.
  const planeados = [
    [O.op0587, 'MP-001', 12000],
    [O.op0587, 'MP-002', 120],
    [O.op0587, 'MP-003', 48],
    [O.op0587, 'MP-010', 35],
    [O.op0587, 'MP-009', 45],
    [O.op0587, 'MP-008', 18],
    [O.op0588, 'MP-005', 8000],
    [O.op0588, 'MP-006', 650],
    [O.op0588, 'MP-004', 95],
    [O.op0588, 'MP-007', 60],
  ].map(([order_id, codigo, cantidad]) => ({
    order_id,
    material_id: M[codigo].id,
    cantidad_planeada: cantidad,
    unidad: M[codigo].unidad,
    ...marcas,
  }));

  return { usuarios, materiales, ordenes, supervisores, planeados };
}

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------
function literal(valor) {
  if (valor === null) {
    return 'NULL';
  }
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) {
      throw new Error(`Número no válido en el seed: ${valor}`);
    }
    return String(valor);
  }
  return `'${String(valor).replaceAll("'", "''")}'`;
}

/**
 * Descripción de cada tabla: clave (para ubicar la fila), expresión de `entidad_id` (las PK
 * compuestas se escriben `<order_id>:<otro_id>`), columnas booleanas (van como true/false en el JSON,
 * igual que las expone Drizzle) y columnas que nunca entran en la auditoría.
 */
const TABLAS = {
  users: { clave: ['id'], entidadId: 'id', booleanos: ['activo'], secretas: ['password_hash'] },
  materials: { clave: ['id'], entidadId: 'id', booleanos: ['activo'] },
  production_orders: { clave: ['id'], entidadId: 'id' },
  order_supervisors: {
    clave: ['order_id', 'user_id'],
    entidadId: "order_id || ':' || user_id",
    booleanos: ['activo'],
  },
  order_planned_materials: {
    clave: ['order_id', 'material_id'],
    entidadId: "order_id || ':' || material_id",
  },
};

function sentenciasDe(tabla, fila, idAuditoria) {
  const { clave, entidadId, booleanos = [], secretas = [] } = TABLAS[tabla];
  const columnas = Object.keys(fila);
  const insercion =
    `INSERT INTO ${tabla} (${columnas.join(', ')})\n` +
    `VALUES (${columnas.map((c) => literal(fila[c])).join(', ')})\n` +
    'ON CONFLICT DO NOTHING;';

  const pares = columnas
    .filter((c) => !secretas.includes(c))
    .map((c) =>
      booleanos.includes(c)
        ? `'${c}', json(CASE WHEN ${c} THEN 'true' ELSE 'false' END)`
        : `'${c}', ${c}`,
    );
  const filtro = clave.map((c) => `${c} = ${literal(fila[c])}`).join(' AND ');
  const auditoria =
    'INSERT INTO audit_log (\n' +
    '  id, entidad, entidad_id, accion, actor_id, device_id, datos_antes, datos_despues,\n' +
    '  client_at, server_at, alerta_reloj, created_at, updated_at\n' +
    ')\n' +
    `SELECT ${literal(idAuditoria)}, '${tabla}', ${entidadId}, 'seed', NULL, NULL, NULL,\n` +
    `  json_object(${pares.join(', ')}),\n` +
    '  NULL, created_at, 0, created_at, created_at\n' +
    `FROM ${tabla} WHERE ${filtro}\n` +
    'ON CONFLICT DO NOTHING;';
  return [insercion, auditoria];
}

function construirSql(datos) {
  const sentencias = [];
  let n = 0;
  const agregar = (tabla, filas) => {
    for (const fila of filas) {
      n += 1;
      sentencias.push(...sentenciasDe(tabla, fila, id('0010', n)));
    }
  };
  // Orden de las FK: usuarios y materiales, luego órdenes y sus filas dependientes.
  agregar('users', datos.usuarios);
  agregar('materials', datos.materiales);
  agregar('production_orders', datos.ordenes);
  agregar('order_supervisors', datos.supervisores);
  agregar('order_planned_materials', datos.planeados);
  return {
    sql: `-- Generado por scripts/seed.mjs. Solo D1 LOCAL.\n${sentencias.join('\n')}\n`,
    idsAuditoria: Array.from({ length: n }, (_, i) => id('0010', i + 1)),
  };
}

// ---------------------------------------------------------------------------------------------
// Wrangler (solo --local)
// ---------------------------------------------------------------------------------------------
function binWrangler() {
  const requerir = createRequire(join(dirWorker, 'package.json'));
  return join(dirname(requerir.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

const WRANGLER = binWrangler();

// Sin telemetría ni selección de entorno o cuenta heredada del shell: todo es local.
const entorno = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' };
for (const variable of ['CLOUDFLARE_ENV', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  delete entorno[variable];
}

function wrangler(args, { persistTo, capturar = false }) {
  if (args.some((a) => PROHIBIDOS.includes(a.split('=')[0]))) {
    throw new Error('Argumento remoto en una llamada a wrangler del seed');
  }
  const completos = [WRANGLER, ...args, '--local'];
  if (persistTo !== null) {
    completos.push('--persist-to', persistTo);
  }
  const resultado = spawnSync(process.execPath, completos, {
    cwd: dirWorker,
    env: entorno,
    encoding: 'utf8',
    stdio: capturar ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (resultado.error) {
    throw resultado.error;
  }
  if (resultado.status !== 0) {
    if (capturar) {
      process.stderr.write(resultado.stdout ?? '');
      process.stderr.write(resultado.stderr ?? '');
    }
    throw new Error(
      `wrangler ${args.slice(0, 3).join(' ')} terminó con código ${resultado.status}`,
    );
  }
  return resultado.stdout;
}

/** Ejecuta una consulta y devuelve la primera fila (salida `--json` de wrangler). */
function consultar(sql, persistTo) {
  const salida = wrangler(['d1', 'execute', 'DB', '--command', sql, '--json'], {
    persistTo,
    capturar: true,
  });
  const inicio = salida.indexOf('[');
  const resultado = JSON.parse(inicio >= 0 ? salida.slice(inicio) : salida);
  return resultado[0]?.results?.[0] ?? {};
}

// ---------------------------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------------------------
function main() {
  const opciones = leerArgumentos(process.argv.slice(2));
  const contrasena = leerSeedPassword();

  const datos = construirDatos(contrasena, new Date());
  const { sql, idsAuditoria } = construirSql(datos);

  const idsFijos = [
    ...datos.usuarios.map((f) => f.id),
    ...datos.materiales.map((f) => f.id),
    ...datos.ordenes.map((f) => f.id),
    ...idsAuditoria,
  ];
  for (const valor of idsFijos) {
    if (!REGEX_UUID_V7.test(valor)) {
      fallar(`id fijo no válido como UUID v7: ${valor}`);
    }
  }

  if (opciones.reset) {
    paso(`Borrando el estado local ${relative(raiz, dirEstadoLocal)}…`);
    try {
      rmSync(dirEstadoLocal, { recursive: true, force: true });
    } catch (error) {
      fallar(`no se pudo borrar el estado local (¿está corriendo \`pnpm dev\`?): ${error.message}`);
    }
    paso('Aplicando migraciones a la D1 local…');
    wrangler(['d1', 'migrations', 'apply', 'DB'], { persistTo: null });
  }

  const destino = opciones.persistTo === null ? 'estado por defecto' : opciones.persistTo;
  paso(`Sembrando la D1 LOCAL (${destino})…`);

  const dirTemporal = mkdtempSync(join(tmpdir(), 'catmetal-seed-'));
  const archivo = join(dirTemporal, 'seed.sql');
  try {
    writeFileSync(archivo, sql, { encoding: 'utf8', mode: 0o600 });
    // Se captura la salida: wrangler imprime el resultado JSON de cada sentencia.
    const salida = wrangler(['d1', 'execute', 'DB', '--file', archivo, '--yes'], {
      persistTo: opciones.persistTo,
      capturar: true,
    });
    const linea = salida.split(/\r?\n/).find((l) => /commands? executed/i.test(l));
    paso(linea === undefined ? 'SQL del seed ejecutado.' : linea.replace(/^\W+/, ''));
  } finally {
    rmSync(dirTemporal, { recursive: true, force: true });
  }

  const enLista = (ids) => ids.map(literal).join(', ');
  const resumen = consultar(
    'SELECT ' +
      [
        '(SELECT count(*) FROM users) AS usuarios',
        '(SELECT count(*) FROM materials) AS materiales',
        '(SELECT count(*) FROM production_orders) AS ordenes',
        '(SELECT count(*) FROM order_supervisors) AS asignaciones',
        '(SELECT count(*) FROM order_planned_materials) AS planeados',
        '(SELECT count(*) FROM audit_log) AS auditoria',
        `(SELECT count(*) FROM users WHERE id IN (${enLista(datos.usuarios.map((f) => f.id))})) AS usuarios_seed`,
        `(SELECT count(*) FROM materials WHERE id IN (${enLista(datos.materiales.map((f) => f.id))})) AS materiales_seed`,
        `(SELECT count(*) FROM production_orders WHERE id IN (${enLista(datos.ordenes.map((f) => f.id))})) AS ordenes_seed`,
        `(SELECT count(*) FROM audit_log WHERE id IN (${enLista(idsAuditoria)})) AS auditoria_seed`,
      ].join(', '),
    opciones.persistTo,
  );

  paso(
    `Base local: ${resumen.usuarios} usuarios, ${resumen.materiales} materiales, ` +
      `${resumen.ordenes} órdenes, ${resumen.asignaciones} asignaciones, ` +
      `${resumen.planeados} materiales planeados, ${resumen.auditoria} filas de auditoría.`,
  );

  const esperado = {
    usuarios_seed: datos.usuarios.length,
    materiales_seed: datos.materiales.length,
    ordenes_seed: datos.ordenes.length,
    auditoria_seed: idsAuditoria.length,
  };
  const faltantes = Object.entries(esperado).filter(([clave, n]) => resumen[clave] !== n);
  if (faltantes.length > 0) {
    fallar(
      'faltan filas del seed (¿un email o código ya existía con otro id?): ' +
        faltantes.map(([clave, n]) => `${clave} ${resumen[clave]}/${n}`).join(', '),
    );
  }

  paso(`Usuarios (contraseña: SEED_PASSWORD de ${relative(raiz, rutaDevVars)}):`);
  for (const u of datos.usuarios) {
    paso(`  ${u.rol.padEnd(10)} ${u.email}`);
  }
}

const esScriptPrincipal =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (esScriptPrincipal) {
  try {
    main();
  } catch (error) {
    fallar(error instanceof Error ? error.message : String(error));
  }
}

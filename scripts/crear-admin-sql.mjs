#!/usr/bin/env node
// Genera el SQL del PRIMER administrador de una base nueva (staging o producción).
//
// Este script NO se conecta a Cloudflare ni ejecuta nada remoto: solo escribe un archivo .sql local
// que una persona aplica después con `wrangler d1 execute … --remote --file` (docs/despliegue.md).
//
// Uso (PowerShell):
//   $env:ADMIN_PASSWORD = '<contraseña de al menos 10 caracteres>'
//   node scripts/crear-admin-sql.mjs --email admin@empresa.com --nombre "Nombre Apellido"
//   Remove-Item Env:ADMIN_PASSWORD
//
// - La contraseña sale SOLO de la variable de entorno ADMIN_PASSWORD (nunca de un argumento, para que
//   no quede en el historial de la consola) y nunca se imprime.
// - Hash compatible con el Worker (ADR 0007): `pbkdf2-sha256$100000$<sal_b64>$<hash_b64>`.
// - La fila de auditoría no copia el correo (ADR 0013) y no fija `seq`.
// - El archivo contiene el hash de la contraseña: no lo versione y bórrelo tras aplicarlo.

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ITERACIONES = 100_000;
const LONGITUD_MINIMA_CONTRASENA = 10;

function fallar(mensaje) {
  process.stderr.write(`crear-admin-sql: ${mensaje}\n`);
  process.exit(1);
}

function leerArgumentos(argv) {
  const args = {
    email: undefined,
    nombre: undefined,
    salida: join(tmpdir(), 'catmetal-primer-admin.sql'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [clave, valorEnLinea] = argv[i].split('=', 2);
    const valor = valorEnLinea ?? argv[i + 1];
    if (clave === '--email' || clave === '--nombre' || clave === '--salida') {
      if (valor === undefined) fallar(`falta el valor de ${clave}.`);
      args[clave.slice(2)] = valor;
      if (valorEnLinea === undefined) i += 1;
    } else {
      fallar(`argumento desconocido: ${argv[i]}`);
    }
  }
  return args;
}

/** UUID v7 (RFC 9562): 48 bits de milisegundos, versión 7, variante 10. */
function uuidv7() {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function hashContrasena(contrasena) {
  const sal = randomBytes(16);
  const hash = pbkdf2Sync(contrasena, sal, ITERACIONES, 32, 'sha256');
  return `pbkdf2-sha256$${ITERACIONES}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

/** Literal SQL con comillas simples duplicadas. */
function texto(valor) {
  return `'${String(valor).replaceAll("'", "''")}'`;
}

const args = leerArgumentos(process.argv.slice(2));
const email = args.email?.trim().toLowerCase();
const nombre = args.nombre?.trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fallar('indique un --email válido.');
if (!nombre || nombre.length > 120) fallar('indique un --nombre (máximo 120 caracteres).');
const contrasena = process.env.ADMIN_PASSWORD;
if (!contrasena || contrasena.length < LONGITUD_MINIMA_CONTRASENA) {
  fallar(`defina ADMIN_PASSWORD con al menos ${LONGITUD_MINIMA_CONTRASENA} caracteres.`);
}

const ahora = new Date().toISOString();
const id = uuidv7();
const datosDespues = JSON.stringify({ id, nombre, rol: 'admin', activo: true });
const sql = [
  '-- Primer administrador. Generado por scripts/crear-admin-sql.mjs. Contiene un hash de contraseña:',
  '-- no versionar; borrar después de aplicarlo.',
  'INSERT INTO users (id, nombre, email, password_hash, rol, activo, intentos_fallidos, bloqueado_hasta, created_at, updated_at)',
  `VALUES (${texto(id)}, ${texto(nombre)}, ${texto(email)}, ${texto(hashContrasena(contrasena))}, 'admin', 1, 0, NULL, ${texto(ahora)}, ${texto(ahora)});`,
  'INSERT INTO audit_log (id, entidad, entidad_id, accion, actor_id, device_id, datos_antes, datos_despues, client_at, server_at, alerta_reloj, created_at, updated_at)',
  `VALUES (${texto(uuidv7())}, 'users', ${texto(id)}, 'usuario.crear', NULL, NULL, NULL, ${texto(datosDespues)}, NULL, ${texto(ahora)}, 0, ${texto(ahora)}, ${texto(ahora)});`,
  '',
].join('\n');

writeFileSync(args.salida, sql, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(
  `SQL del primer administrador escrito en ${args.salida}\n` +
    'Aplíquelo con wrangler d1 execute (ver docs/despliegue.md) y luego borre el archivo.\n',
);

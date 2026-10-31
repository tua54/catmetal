#!/usr/bin/env node
// Desbloqueo de emergencia del login de un usuario, SIN depender de un admin con sesión
// (docs/spec.md §5 (c); ADR 0018 punto 9).
//
// Este script NO se conecta a Cloudflare ni ejecuta nada remoto: solo escribe un archivo .sql local
// que una persona aplica después con `wrangler d1 execute … --file` (docs/despliegue.md).
//
// Uso:
//   node scripts/desbloqueo-emergencia-sql.mjs --email persona@empresa.com [--salida archivo.sql]
//
// El SQL:
// - resuelve al usuario con `(SELECT id FROM users WHERE email = '<correo>')`: con un correo que no
//   existe no hace nada;
// - el correo nunca llega a `audit_log` (ADR 0013): la auditoría solo lleva el id;
// - es idempotente y seguro aunque se aplique a medias (no se supone que `d1 execute --file` sea
//   atómico): las auditorías tienen id fijo y `NOT EXISTS`, y los UPDATE solo tocan lo que no está
//   ya en cero. Aplicar dos veces el mismo archivo deja el mismo estado y una sola auditoría;
// - no usa DELETE: reinicia los cupos de `login_cupos` y las columnas heredadas de `users`.
//
// La función `generarSqlDesbloqueo` es pura (solo Web Crypto, sin módulos de Node) para que la
// prueba del Worker la importe y ejecute el SQL contra la D1 local real.

/** Patrón mínimo de correo (el mismo criterio que scripts/crear-admin-sql.mjs). */
const PATRON_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** UUID v7 (RFC 9562) con Web Crypto: 48 bits de milisegundos, versión 7, variante 10. */
function uuidv7(ahoraMs) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = BigInt(ahoraMs);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Literal SQL con comillas simples duplicadas. */
function texto(valor) {
  return `'${String(valor).replaceAll("'", "''")}'`;
}

/** Correo normalizado como lo guarda el Worker (minúsculas, sin espacios), o null si no es válido. */
export function normalizarEmail(email) {
  const normalizado = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return PATRON_EMAIL.test(normalizado) && normalizado.length <= 254 ? normalizado : null;
}

/**
 * Sentencias SQL (una por elemento, cada una en una línea) del desbloqueo de emergencia.
 * Lanza un Error si el correo no es válido.
 */
export function generarSqlDesbloqueo({ email, ahora = new Date() }) {
  const correo = normalizarEmail(email);
  if (correo === null) {
    throw new Error('indique un --email válido.');
  }
  const marca = ahora.toISOString();
  const usuario = `(SELECT id FROM users WHERE email = ${texto(correo)})`;
  const idCupos = uuidv7(ahora.getTime());
  const idUsuario = uuidv7(ahora.getTime());
  // N2 (R-v12-01, ADR 0028): marca de escritura nueva de `users`, fija en el archivo (así aplicarlo
  // dos veces deja la misma). Nunca NULL: un NULL reabriría el ABA contra una lectura NULL.
  const escrituraUsuario = uuidv7(ahora.getTime());
  const columnas =
    'id, entidad, entidad_id, accion, actor_id, device_id, datos_antes, datos_despues, client_at, server_at, alerta_reloj, created_at, updated_at';
  return [
    // 1. Auditoría del desbloqueo de los cupos (siempre que el usuario exista). Solo columnas de la
    //    lista blanca de `login_cupos` (apps/worker/src/auditoria/auditar.ts), sin el correo.
    `INSERT INTO audit_log (${columnas}) SELECT ${texto(idCupos)}, 'login_cupos', id, 'login_cupos.desbloqueo_emergencia', NULL, NULL, NULL, json_object('user_id', id, 'tipo', 'todos', 'fallos', 0, 'bloqueado_hasta', NULL), NULL, ${texto(marca)}, 0, ${texto(marca)}, ${texto(marca)} FROM users WHERE email = ${texto(correo)} AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ${texto(idCupos)});`,
    // 2. Auditoría del reinicio de las columnas heredadas de la v1, solo si había algo que reiniciar.
    `INSERT INTO audit_log (${columnas}) SELECT ${texto(idUsuario)}, 'users', id, 'usuario.desbloqueado', NULL, NULL, NULL, json_object('id', id, 'intentos_fallidos', 0, 'bloqueado_hasta', NULL), NULL, ${texto(marca)}, 0, ${texto(marca)}, ${texto(marca)} FROM users WHERE email = ${texto(correo)} AND (intentos_fallidos <> 0 OR bloqueado_hasta IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ${texto(idUsuario)});`,
    // 3. Reinicio de todos los cupos del usuario (dispositivos, orígenes y global), sin DELETE.
    `UPDATE login_cupos SET fallos = 0, bloqueado_hasta = NULL, updated_at = ${texto(marca)} WHERE user_id = ${usuario} AND (fallos <> 0 OR bloqueado_hasta IS NOT NULL);`,
    // 4. Columnas heredadas de la v1: ya no bloquean, pero se dejan en 0/NULL. También renueva la
    //    marca de escritura (N2): la edición concurrente de un admin basada en una lectura previa
    //    no se aplica aunque caiga en el mismo milisegundo.
    `UPDATE users SET intentos_fallidos = 0, bloqueado_hasta = NULL, updated_at = ${texto(marca)}, escritura_id = ${texto(escrituraUsuario)} WHERE email = ${texto(correo)} AND (intentos_fallidos <> 0 OR bloqueado_hasta IS NOT NULL);`,
  ];
}

/** Contenido completo del archivo .sql. */
export function archivoSqlDesbloqueo(opciones) {
  return [
    '-- Desbloqueo de emergencia del login. Generado por scripts/desbloqueo-emergencia-sql.mjs.',
    '-- Idempotente: aplicarlo dos veces no cambia nada más. No contiene secretos.',
    ...generarSqlDesbloqueo(opciones),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI (solo en Node; la prueba del Worker importa las funciones de arriba)
// ---------------------------------------------------------------------------------------------

function leerArgumentos(argv, fallar) {
  const args = { email: undefined, salida: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const [clave, valorEnLinea] = argv[i].split('=', 2);
    const valor = valorEnLinea ?? argv[i + 1];
    if (clave === '--email' || clave === '--salida') {
      if (valor === undefined) fallar(`falta el valor de ${clave}.`);
      args[clave.slice(2)] = valor;
      if (valorEnLinea === undefined) i += 1;
    } else {
      fallar(`argumento desconocido: ${argv[i]}`);
    }
  }
  return args;
}

function esLlamadaDirecta() {
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return false;
  }
  const rutaArgumento = process.argv?.[1];
  if (rutaArgumento === undefined) {
    return false;
  }
  const { resolve } = process.getBuiltinModule('node:path');
  const { pathToFileURL } = process.getBuiltinModule('node:url');
  const esperada = pathToFileURL(resolve(rutaArgumento)).href;
  return process.platform === 'win32'
    ? esperada.toLowerCase() === import.meta.url.toLowerCase()
    : esperada === import.meta.url;
}

if (esLlamadaDirecta()) {
  const { writeFileSync } = process.getBuiltinModule('node:fs');
  const { tmpdir } = process.getBuiltinModule('node:os');
  const { join } = process.getBuiltinModule('node:path');
  const fallar = (mensaje) => {
    process.stderr.write(`desbloqueo-emergencia-sql: ${mensaje}\n`);
    process.exit(1);
  };
  const args = leerArgumentos(process.argv.slice(2), fallar);
  if (normalizarEmail(args.email) === null) fallar('indique un --email válido.');
  const salida = args.salida ?? join(tmpdir(), 'catmetal-desbloqueo-emergencia.sql');
  writeFileSync(salida, archivoSqlDesbloqueo({ email: args.email }), { encoding: 'utf8' });
  process.stdout.write(
    `SQL de desbloqueo de emergencia escrito en ${salida}\n` +
      'Aplíquelo con wrangler d1 execute (ver docs/despliegue.md). Si el correo no existe, no hace nada.\n',
  );
}

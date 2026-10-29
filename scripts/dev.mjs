#!/usr/bin/env node
// `pnpm dev`: entorno de desarrollo LOCAL completo (ADR 0002).
//
//   1. Genera apps/worker/.dev.vars si no existe (secretos aleatorios locales).
//   2. Garantiza apps/web/dist (marcador si la PWA no está compilada).
//   3. Aplica las migraciones a la D1 LOCAL (`wrangler d1 migrations apply DB --local`).
//   4. Lanza en paralelo `wrangler dev` (API + assets, 127.0.0.1:8787) y `vite` (5173, proxy /api).
//
// Node puro, sin dependencias; funciona en Windows y Linux. Ctrl+C detiene ambos procesos
// y sus hijos (workerd). Nunca usa recursos remotos de Cloudflare.

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { generarDevVars } from './gen-dev-vars.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirWorker = join(raiz, 'apps', 'worker');
const dirWeb = join(raiz, 'apps', 'web');
const esWindows = process.platform === 'win32';

/** Ruta del ejecutable JS de un paquete instalado en `dir` (sin shell ni shims .cmd). */
function binDe(dir, paquete, rutaBin) {
  const requerir = createRequire(join(dir, 'package.json'));
  return join(dirname(requerir.resolve(`${paquete}/package.json`)), rutaBin);
}

const WRANGLER = binDe(dirWorker, 'wrangler', join('bin', 'wrangler.js'));
const VITE = binDe(dirWeb, 'vite', join('bin', 'vite.js'));

// Sin telemetría de Wrangler en desarrollo local.
const entorno = { ...process.env, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '1' };

function paso(texto) {
  console.log(`[dev] ${texto}`);
}

// 1 y 2: preparación.
generarDevVars({ silencioso: true });
spawnSync(process.execPath, [join(raiz, 'scripts', 'ensure-web-dist.mjs')], { stdio: 'inherit' });

// 3: migraciones locales. `CI=true` evita la confirmación interactiva de Wrangler.
paso('Aplicando migraciones a la D1 local…');
const migracion = spawnSync(
  process.execPath,
  [WRANGLER, 'd1', 'migrations', 'apply', 'DB', '--local'],
  { cwd: dirWorker, stdio: 'inherit', env: { ...entorno, CI: 'true' } },
);
if (migracion.status !== 0) {
  paso(`Las migraciones locales fallaron (código ${migracion.status ?? 'desconocido'}).`);
  process.exit(migracion.status ?? 1);
}

// 4: procesos de larga duración.
const procesos = [
  {
    nombre: 'worker',
    args: [WRANGLER, 'dev', '--ip', '127.0.0.1', '--port', '8787'],
    cwd: dirWorker,
  },
  {
    nombre: 'web',
    args: [VITE, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    cwd: dirWeb,
  },
];

const hijos = [];
let cerrando = false;

/** Mata el árbol de procesos del hijo (wrangler lanza workerd como nieto). */
function matarArbol(hijo) {
  if (hijo.exitCode !== null || hijo.pid === undefined) {
    return;
  }
  if (esWindows) {
    spawnSync('taskkill', ['/PID', String(hijo.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      // Grupo de procesos propio (detached), así se alcanza también a workerd.
      process.kill(-hijo.pid, 'SIGTERM');
    } catch {
      hijo.kill('SIGTERM');
    }
  }
}

function cerrar(codigo) {
  if (cerrando) {
    return;
  }
  cerrando = true;
  paso('Deteniendo procesos…');
  for (const hijo of hijos) {
    matarArbol(hijo);
  }
  process.exitCode = codigo;
}

function prefijar(flujo, nombre, destino) {
  const lector = createInterface({ input: flujo });
  lector.on('line', (linea) => destino.write(`[${nombre}] ${linea}\n`));
}

for (const { nombre, args, cwd } of procesos) {
  const hijo = spawn(process.execPath, args, {
    cwd,
    env: entorno,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !esWindows,
    windowsHide: true,
  });
  prefijar(hijo.stdout, nombre, process.stdout);
  prefijar(hijo.stderr, nombre, process.stderr);
  hijo.on('exit', (codigo, senal) => {
    if (!cerrando) {
      paso(`${nombre} terminó (${senal ?? `código ${codigo}`}); se detiene el resto.`);
      cerrar(codigo ?? 1);
    }
  });
  hijos.push(hijo);
}

paso('API: http://127.0.0.1:8787/api/v1/health · PWA: http://127.0.0.1:5173 (Ctrl+C para salir)');

for (const senal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(senal, () => cerrar(0));
}

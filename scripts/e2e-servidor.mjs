#!/usr/bin/env node
// Servidor de las pruebas E2E (`webServer` de playwright.config.ts). SOLO LOCAL.
//
//   1. Borra el estado E2E aislado (apps/worker/.wrangler/e2e, ignorado por git).
//   2. Compila la PWA (vite build). Con E2E_SIN_BUILD=1 reutiliza apps/web/dist (más rápido, pero
//      puede estar desactualizado).
//   3. Garantiza apps/worker/.dev.vars con secretos aleatorios SOLO si no existe (igual que
//      `pnpm dev`); nunca lo sobrescribe. Sus valores no influyen en las pruebas.
//   4. Aplica las migraciones y el seed a la D1 LOCAL del estado E2E (--local --persist-to). El seed usa
//      la contraseña fija de prueba de scripts/e2e-config.mjs (E2E_SEED_PASSWORD), no la del .dev.vars.
//   5. Lanza `wrangler dev --local` en 127.0.0.1:8788 sirviendo la PWA compilada y la API.
//
// Nunca usa recursos remotos de Cloudflare. Node puro; funciona en Windows y Linux. Al terminar (o al
// recibir SIGINT/SIGTERM) mata el árbol de procesos de wrangler (workerd es un proceso nieto).

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { generarDevVars } from './gen-dev-vars.mjs';
import { CONTRASENA_E2E, DIR_ESTADO_E2E, PUERTO_E2E, RAIZ } from './e2e-config.mjs';

const dirWorker = join(RAIZ, 'apps', 'worker');
const dirWeb = join(RAIZ, 'apps', 'web');
const esWindows = process.platform === 'win32';

/** Ruta del ejecutable JS de un paquete instalado en `dir` (sin shell ni shims .cmd). */
function binDe(dir, paquete, rutaBin) {
  const requerir = createRequire(join(dir, 'package.json'));
  return join(dirname(requerir.resolve(`${paquete}/package.json`)), rutaBin);
}

const WRANGLER = binDe(dirWorker, 'wrangler', join('bin', 'wrangler.js'));
const VITE = binDe(dirWeb, 'vite', join('bin', 'vite.js'));

// Sin telemetría ni selección de entorno o cuenta heredada del shell (todo es local).
const entorno = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' };
for (const variable of ['CLOUDFLARE_ENV', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  delete entorno[variable];
}

// Los mensajes van a stderr: Playwright solo muestra el stderr del servidor (stdout se ignora).
function paso(texto) {
  process.stderr.write(`[e2e-servidor] ${texto}\n`);
}

function ejecutar(descripcion, args, { cwd, env = entorno }) {
  paso(descripcion);
  const resultado = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (resultado.error || resultado.status !== 0) {
    paso(`FALLÓ: ${descripcion} (código ${resultado.status ?? resultado.error?.message}).`);
    process.exit(resultado.status ?? 1);
  }
}

// 1. Estado aislado y desechable.
paso(`Borrando el estado E2E ${relative(RAIZ, DIR_ESTADO_E2E)}…`);
rmSync(DIR_ESTADO_E2E, { recursive: true, force: true });
mkdirSync(DIR_ESTADO_E2E, { recursive: true });

// 2. PWA compilada (el Worker la sirve como assets). vite build no pasa por tsc: los tipos son un
//    gate aparte (`pnpm typecheck`).
if (process.env.E2E_SIN_BUILD === '1') {
  ejecutar(
    'Reutilizando apps/web/dist (E2E_SIN_BUILD=1)…',
    [join(RAIZ, 'scripts', 'ensure-web-dist.mjs')],
    { cwd: RAIZ },
  );
} else {
  ejecutar('Compilando la PWA (vite build)…', [VITE, 'build'], { cwd: dirWeb });
}

// 3. Secretos de wrangler dev: solo si no hay .dev.vars. Nunca se sobrescribe.
generarDevVars({ silencioso: true });

// 4. Migraciones y seed en la D1 LOCAL aislada.
ejecutar(
  'Aplicando migraciones a la D1 local E2E…',
  [WRANGLER, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', DIR_ESTADO_E2E],
  { cwd: dirWorker },
);
ejecutar(
  'Sembrando la D1 local E2E…',
  [
    '--import',
    // En Windows --import exige una URL file://, no una ruta absoluta.
    pathToFileURL(join(RAIZ, 'scripts', 'e2e-precarga-seed.mjs')).href,
    join(RAIZ, 'scripts', 'seed.mjs'),
    '--persist-to',
    DIR_ESTADO_E2E,
  ],
  { cwd: RAIZ, env: { ...entorno, E2E_SEED_PASSWORD: CONTRASENA_E2E } },
);

// 5. wrangler dev. Su salida normal va a un log (cada petición genera una línea); stderr se reenvía.
const registro = createWriteStream(join(DIR_ESTADO_E2E, 'wrangler-dev.log'));
const hijo = spawn(
  process.execPath,
  [
    WRANGLER,
    'dev',
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(PUERTO_E2E),
    '--persist-to',
    DIR_ESTADO_E2E,
    '--show-interactive-dev-session=false',
  ],
  {
    cwd: dirWorker,
    env: { ...entorno, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !esWindows,
    windowsHide: true,
  },
);
hijo.stdout.pipe(registro);
createInterface({ input: hijo.stderr }).on('line', (linea) =>
  process.stderr.write(`[wrangler] ${linea}\n`),
);

let cerrando = false;

/** Mata el árbol de procesos de wrangler (workerd es nieto). */
function matarArbol() {
  if (hijo.exitCode !== null || hijo.pid === undefined) {
    return;
  }
  if (esWindows) {
    spawnSync('taskkill', ['/PID', String(hijo.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
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
  matarArbol();
  process.exitCode = codigo;
}

hijo.on('exit', (codigo, senal) => {
  if (!cerrando) {
    paso(`wrangler dev terminó (${senal ?? `código ${codigo}`}).`);
    cerrando = true;
    process.exitCode = codigo ?? 1;
  }
});
for (const senal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(senal, () => cerrar(0));
}
process.on('exit', matarArbol);

paso(`Servidor E2E en http://127.0.0.1:${PUERTO_E2E} (estado: ${relative(RAIZ, DIR_ESTADO_E2E)}).`);

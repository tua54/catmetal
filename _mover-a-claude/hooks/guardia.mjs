#!/usr/bin/env node
// Hook PreToolUse — guardia del proyecto Catmetal.
// Bloquea (exit 2) acciones que el equipo humano se reservó:
//   - git push, cambios de remotos y reescritura de historial
//   - commits/cambios de rama hechos por subagentes (solo el orquestador hace commits)
//   - cualquier acción remota de Cloudflare (deploy, secretos, --remote, API, recursos)
//   - comandos gh y scripts de paquete de deploy/release/remote/prod/staging
//   - escrituras dentro de .claude/ (configuración, hooks y subagentes)
// Funciona en Windows (Git Bash o PowerShell) y en Linux. Solo usa Node, sin dependencias.

import { readFileSync } from 'node:fs';

const MOTIVO_PIE =
  '\nNo intentes rodear este bloqueo (npx, pnpm exec, scripts, otra sintaxis). ' +
  'Si la acción es necesaria, anótala con el comando exacto en docs/pendientes-humanos.md y continúa con otra tarea.';

function bloquear(motivo) {
  process.stderr.write(`BLOQUEADO por .claude/hooks/guardia.mjs: ${motivo}${MOTIVO_PIE}\n`);
  process.exit(2);
}

let entrada;
try {
  entrada = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch (e) {
  process.stderr.write(`guardia.mjs: no se pudo leer la entrada del hook (${e.message}); se permite la acción.\n`);
  process.exit(0);
}

const herramienta = entrada.tool_name || '';
const input = entrada.tool_input || {};
const esSubagente = Boolean(entrada.agent_id || entrada.agent_type);

// ---------- Escrituras de archivos ----------
if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(herramienta)) {
  const ruta = String(input.file_path || input.notebook_path || '').replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)\.claude\//.test(ruta)) {
    bloquear(`no se permite modificar ${input.file_path || input.notebook_path}: la carpeta .claude/ (configuración, hooks y subagentes) la controla el equipo humano.`);
  }
  process.exit(0);
}

if (!['Bash', 'PowerShell'].includes(herramienta)) process.exit(0);

const comando = String(input.command || '');
const bajo = comando.toLowerCase();

// ---------- Chequeos sobre el texto completo ----------
if (bajo.includes('api.cloudflare.com')) bloquear('llamada directa a la API de Cloudflare.');
if (/cloudflare_api_token|cloudflare_account_id|cf_api_token/.test(bajo)) {
  bloquear('el comando usa credenciales de Cloudflare.');
}

// ---------- Tokenización tipo shell ----------
// Divide en segmentos por && || ; | & y saltos de línea fuera de comillas,
// y cada segmento en tokens respetando comillas simples y dobles.
function segmentar(texto) {
  const segmentos = [];
  let tokens = [];
  let actual = '';
  let comilla = null;
  let enToken = false;
  const cerrarToken = () => {
    if (enToken) tokens.push(actual);
    actual = '';
    enToken = false;
  };
  const cerrarSegmento = () => {
    cerrarToken();
    if (tokens.length) segmentos.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comilla) {
      if (c === comilla) comilla = null;
      else actual += c;
      continue;
    }
    if (c === '"' || c === "'") { comilla = c; enToken = true; continue; }
    if (c === '`' || c === '(' || c === ')' || c === '{' || c === '}') { cerrarSegmento(); continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|') { cerrarSegmento(); continue; }
    if (/\s/.test(c)) { cerrarToken(); continue; }
    actual += c;
    enToken = true;
  }
  cerrarSegmento();
  return segmentos;
}

const base = (t) => t.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');

// Opciones globales de git que llevan valor en el siguiente token
const GIT_OPC_CON_VALOR = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function subcomando(tokens, desde, opcionesConValor = new Set()) {
  for (let i = desde; i < tokens.length; i++) {
    const t = tokens[i];
    if (opcionesConValor.has(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    return { valor: t.toLowerCase(), indice: i };
  }
  return { valor: '', indice: tokens.length };
}

function revisarGit(tokens, i) {
  const { valor: sub, indice } = subcomando(tokens, i + 1, GIT_OPC_CON_VALOR);
  const resto = tokens.slice(indice + 1).map((t) => t.toLowerCase());

  if (sub === 'push') bloquear('git push está prohibido: el equipo humano revisa, audita y hace el push.');
  if (sub === 'remote' && ['add', 'set-url', 'remove', 'rm', 'rename', 'set-head', 'prune'].includes(resto[0] || '')) {
    bloquear('no se permite modificar los remotos de git.');
  }
  if (sub === 'commit' && resto.some((t) => t === '--amend')) bloquear('no se permite commit --amend: el historial solo se agrega. Usa un commit nuevo (fix:/revert:).');
  if (['rebase', 'filter-branch', 'filter-repo', 'replace', 'update-ref', 'reflog', 'gc', 'prune'].includes(sub)) {
    bloquear(`git ${sub} está prohibido: el historial solo se agrega.`);
  }
  if (sub === 'reset' && resto.some((t) => t === '--hard' || t === '--keep' || t === '--merge')) {
    bloquear('git reset --hard está prohibido: el historial solo se agrega.');
  }
  if (sub === 'clean') bloquear('git clean está prohibido: puede borrar trabajo no versionado.');
  if (sub === 'branch' && resto.some((t) => ['-d', '-D', '--delete', '-m', '-M', '--move', '-f', '--force'].includes(t))) {
    bloquear('no se permite borrar, renombrar ni forzar ramas.');
  }
  if (sub === 'tag' && resto.some((t) => ['-d', '--delete', '-f', '--force'].includes(t))) {
    bloquear('no se permite borrar ni sobrescribir tags.');
  }
  if (sub === 'config' && resto.some((t) => t === '--global' || t === '--system')) {
    bloquear('no se permite cambiar la configuración global de git.');
  }
  if (esSubagente && ['add', 'commit', 'tag', 'checkout', 'switch', 'stash', 'merge', 'restore', 'reset', 'revert', 'cherry-pick', 'am', 'apply', 'rm', 'mv'].includes(sub)) {
    bloquear(`los subagentes no ejecutan "git ${sub}": solo el orquestador hace commits y cambia de rama. Termina tu tarea y reporta los archivos cambiados.`);
  }
}

const WRANGLER_PROHIBIDOS = new Set([
  'deploy', 'publish', 'versions', 'rollback', 'deployments', 'secret', 'secrets-store', 'login',
  'triggers', 'pages', 'queues', 'hyperdrive', 'vectorize', 'workflows', 'dispatch-namespace', 'cert', 'mtls-certificate',
]);

function revisarWrangler(tokens, i) {
  const resto = tokens.slice(i + 1).map((t) => t.toLowerCase());
  if (resto.some((t) => t === '--remote' || t.startsWith('--remote='))) {
    bloquear('wrangler con --remote está prohibido: todo el desarrollo es local.');
  }
  const { valor: sub, indice } = subcomando(tokens, i + 1);
  const sub2 = (subcomando(tokens, indice + 1).valor || '');
  if (WRANGLER_PROHIBIDOS.has(sub)) bloquear(`"wrangler ${sub}" afecta recursos remotos de Cloudflare.`);
  if (sub === 'd1' && ['create', 'delete', 'time-travel', 'insights'].includes(sub2)) bloquear(`"wrangler d1 ${sub2}" afecta recursos remotos.`);
  if (sub === 'r2' && ['bucket'].includes(sub2)) bloquear('"wrangler r2 bucket" afecta recursos remotos.');
  if (sub === 'kv' && ['namespace'].includes(sub2)) bloquear('"wrangler kv namespace" afecta recursos remotos.');
}

const SCRIPT_PROHIBIDO = /(deploy|release|publish|remote|prod|staging)/i;
const GESTORES = new Set(['pnpm', 'npm', 'yarn', 'bun', 'corepack']);

function revisarGestor(tokens, i) {
  // Salta "corepack pnpm ..." y opciones como --filter x, -C dir, -r
  let j = i + 1;
  if (base(tokens[i]) === 'corepack' && GESTORES.has(base(tokens[j] || ''))) j++;
  const conValor = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '-w', '--workspace']);
  const { valor: sub, indice } = subcomando(tokens, j, conValor);
  if (['publish', 'deploy'].includes(sub)) bloquear(`"${base(tokens[i])} ${sub}" está prohibido.`);
  let script = '';
  if (sub === 'run' || sub === 'run-script') script = subcomando(tokens, indice + 1, conValor).valor;
  else if (!['install', 'i', 'add', 'remove', 'exec', 'dlx', 'x', 'test', 't', 'why', 'list', 'ls', 'outdated', 'audit', 'store', 'config', 'init', 'approve-builds', 'rebuild', 'update', 'up', 'fetch', 'prune', 'licenses', 'create'].includes(sub)) script = sub;
  if (script && SCRIPT_PROHIBIDO.test(script)) {
    bloquear(`el script "${script}" parece de despliegue o de entornos remotos. Esos scripts los ejecuta el equipo humano.`);
  }
}

function revisarSegmento(tokens, profundidad = 0) {
  if (profundidad > 4) return;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const b = base(t);
    if (b === 'git') { revisarGit(tokens, i); break; }
    if (b === 'gh') bloquear('el CLI de GitHub (gh) está prohibido en esta sesión.');
    if (b === 'wrangler' || b === 'wrangler-dist') { revisarWrangler(tokens, i); break; }
    if (GESTORES.has(b)) {
      revisarGestor(tokens, i);
      // "pnpm exec wrangler ..." / "npx wrangler ...": se sigue revisando el resto del segmento
      continue;
    }
  }
  // Comandos anidados en cadenas de shells envoltorio: bash -c "...", sh -c, cmd /c, powershell -Command, wsl, eval...
  // (no se revisan cadenas de otros comandos, p. ej. mensajes de commit que mencionen "git push").
  const envoltorio = tokens.findIndex((t) => ENVOLTORIOS.has(base(t)));
  if (envoltorio !== -1) {
    for (const t of tokens.slice(envoltorio + 1)) {
      if (/\s/.test(t)) for (const seg of segmentar(t)) revisarSegmento(seg, profundidad + 1);
    }
  }
}

const ENVOLTORIOS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', 'wsl', 'eval', 'xargs', 'env', 'start-process', 'invoke-expression', 'iex']);

for (const seg of segmentar(comando)) revisarSegmento(seg);

process.exit(0);

#!/usr/bin/env node
// Hook Stop — mantiene viva la sesión larga.
// Claude Code puede terminar solo si existe uno de estos archivos (rutas relativas a la raíz):
//   <archivoFinal> definido en .claude/sesion.json (por defecto docs/INFORME-FINAL.md)
//   docs/BLOQUEO.md   (bloqueo total, documentado)
//   docs/PAUSA.md     (el humano pidió pausar)
// .claude/sesion.json lo controla el equipo humano (Claude Code no puede editar .claude/).
// Válvulas de escape para el humano:
//   - variable de entorno CATMETAL_PERMITIR_PARAR=1 al lanzar claude
//   - tope de 60 continuaciones forzadas por sesión
// Funciona en Windows y Linux. Solo Node, sin dependencias.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let entrada = {};
try {
  entrada = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

if (process.env.CATMETAL_PERMITIR_PARAR === '1') process.exit(0);

const raiz = process.env.CLAUDE_PROJECT_DIR || entrada.cwd || process.cwd();

let archivoFinal = 'docs/INFORME-FINAL.md';
try {
  const conf = JSON.parse(readFileSync(join(raiz, '.claude', 'sesion.json'), 'utf8'));
  if (typeof conf.archivoFinal === 'string' && conf.archivoFinal.trim()) archivoFinal = conf.archivoFinal.trim();
} catch {
  // sin sesion.json: se usa el valor por defecto
}

const salidas = [archivoFinal, 'docs/BLOQUEO.md', 'docs/PAUSA.md'];
if (salidas.some((f) => existsSync(join(raiz, ...f.split('/'))))) process.exit(0);

const TOPE = 60;
const sesion = String(entrada.session_id || 'sin-sesion').replace(/[^a-zA-Z0-9_-]/g, '');
const contadorRuta = join(tmpdir(), `catmetal-no-parar-${sesion}.json`);
let n = 0;
try {
  n = JSON.parse(readFileSync(contadorRuta, 'utf8')).n || 0;
} catch {
  n = 0;
}
if (n >= TOPE) process.exit(0);
try {
  writeFileSync(contadorRuta, JSON.stringify({ n: n + 1 }));
} catch {
  // si no se puede escribir el contador, igual se fuerza la continuación
}

process.stderr.write(
  `La sesión todavía no ha terminado (continuación forzada ${n + 1}/${TOPE}). ` +
    'Lee docs/progreso.md, retoma desde "Siguiente paso" y continúa según CLAUDE.md. ' +
    `Solo puedes terminar si existe ${archivoFinal} (trabajo completo), docs/BLOQUEO.md (bloqueo total documentado) ` +
    'o docs/PAUSA.md (el humano pidió pausar). Si el humano te hizo una pregunta, ya la respondiste: sigue trabajando.\n',
);
process.exit(2);

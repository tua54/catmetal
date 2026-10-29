#!/usr/bin/env node
// Garantiza que exista apps/web/dist/index.html.
//
// `wrangler dev` y el pool de Vitest del Worker exigen que `assets.directory` (../web/dist) exista.
// En un clon limpio o en CI la PWA todavía no está compilada: este script crea un index.html
// MARCADOR mínimo, solo si no existe. El build real (`pnpm --filter @catmetal/web build`) lo
// reemplaza, porque Vite vacía dist (emptyOutDir). apps/web/dist está en .gitignore.
//
// Uso: node scripts/ensure-web-dist.mjs   (Node puro; funciona en Windows y Linux)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(raiz, 'apps', 'web', 'dist');
const indice = join(dist, 'index.html');

// Sin estilos ni scripts inline: debe cumplir la CSP del Worker.
const MARCADOR = `<!doctype html>
<html lang="es-CO">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Control de Materia Prima · Catmetal</title>
  </head>
  <body>
    <!-- Marcador generado por scripts/ensure-web-dist.mjs. No es la PWA. -->
    <p>La PWA no está compilada. Ejecute: pnpm --filter @catmetal/web build</p>
  </body>
</html>
`;

if (existsSync(indice)) {
  process.exit(0);
}

mkdirSync(dist, { recursive: true });
writeFileSync(indice, MARCADOR, 'utf8');
console.log(`[ensure-web-dist] Se creó un index.html marcador en ${relative(raiz, indice)}.`);

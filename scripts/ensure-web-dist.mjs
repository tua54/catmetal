#!/usr/bin/env node
// Garantiza que existan apps/web/dist/index.html, sw.js y manifest.webmanifest.
//
// `wrangler dev` y el pool de Vitest del Worker exigen que `assets.directory` (../web/dist) exista.
// En un clon limpio o en CI la PWA todavía no está compilada: este script crea MARCADORES mínimos.
// Las pruebas del Worker piden `/`, `/sw.js` y `/manifest.webmanifest` al binding ASSETS real para
// comprobar sus cabeceras (F4-10), por eso los tres deben existir.
//
// Solo se tocan marcadores: si index.html existe y NO es el marcador, dist es un build real y no se
// agrega nada (un sw.js marcador junto a la PWA real rompería el modo offline). El build real
// (`pnpm --filter @catmetal/web build`) los reemplaza, porque Vite vacía dist (emptyOutDir).
// apps/web/dist está en .gitignore.
//
// Uso: node scripts/ensure-web-dist.mjs   (Node puro; funciona en Windows y Linux)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(raiz, 'apps', 'web', 'dist');
const indice = join(dist, 'index.html');

const SENAL_MARCADOR = 'Marcador generado por scripts/ensure-web-dist.mjs';

// Sin estilos ni scripts inline: debe cumplir la CSP del Worker.
const INDICE_MARCADOR = `<!doctype html>
<html lang="es-CO">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Control de Materia Prima · Catmetal</title>
  </head>
  <body>
    <!-- ${SENAL_MARCADOR}. No es la PWA. -->
    <p>La PWA no está compilada. Ejecute: pnpm --filter @catmetal/web build</p>
  </body>
</html>
`;

// Service Worker vacío: no intercepta peticiones ni guarda nada en caché.
const SW_MARCADOR = `// ${SENAL_MARCADOR}. No es el Service Worker de la PWA.\n`;

const MANIFEST_MARCADOR = `${JSON.stringify(
  {
    name: 'Control de Materia Prima · Catmetal (marcador)',
    short_name: 'Catmetal MP',
    start_url: '/',
    display: 'standalone',
  },
  null,
  2,
)}\n`;

const ARCHIVOS = [
  ['index.html', INDICE_MARCADOR],
  ['sw.js', SW_MARCADOR],
  ['manifest.webmanifest', MANIFEST_MARCADOR],
];

if (existsSync(indice) && !readFileSync(indice, 'utf8').includes(SENAL_MARCADOR)) {
  process.exit(0);
}

mkdirSync(dist, { recursive: true });
for (const [nombre, contenido] of ARCHIVOS) {
  const ruta = join(dist, nombre);
  if (!existsSync(ruta)) {
    writeFileSync(ruta, contenido, 'utf8');
    console.log(`[ensure-web-dist] Se creó un ${nombre} marcador en ${relative(raiz, ruta)}.`);
  }
}

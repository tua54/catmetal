#!/usr/bin/env node
// Genera apps/worker/.dev.vars con secretos aleatorios para el desarrollo LOCAL.
//
// - JWT_SECRET y REFRESH_SECRET: 32 bytes aleatorios (node:crypto) en base64url.
// - SEED_PASSWORD: contraseña aleatoria legible (24 caracteres) para los usuarios del seed local.
// - No sobrescribe un .dev.vars existente, salvo con --force.
// - Nunca imprime los valores, solo los nombres de las variables.
// - .dev.vars está en .gitignore: nunca se versiona.
//
// Uso: node scripts/gen-dev-vars.mjs [--force]   (o `pnpm setup:dev-vars`)

import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const destino = join(raiz, 'apps', 'worker', '.dev.vars');

// Sin caracteres ambiguos (0/O, 1/l/I) para que se pueda leer y escribir a mano.
const ALFABETO = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function secretoBase64Url() {
  return randomBytes(32).toString('base64url');
}

/** 4 grupos de 5 caracteres separados por guiones (~114 bits de entropía). */
function contrasenaLegible() {
  const grupos = [];
  for (let g = 0; g < 4; g += 1) {
    let grupo = '';
    for (let i = 0; i < 5; i += 1) {
      grupo += ALFABETO[randomInt(ALFABETO.length)];
    }
    grupos.push(grupo);
  }
  return grupos.join('-');
}

/**
 * Crea el archivo si no existe (o si `forzar`). Devuelve `true` si lo escribió.
 * Exportada para que scripts/dev.mjs la reutilice.
 */
export function generarDevVars({ forzar = false, silencioso = false } = {}) {
  const ruta = relative(raiz, destino);
  if (existsSync(destino) && !forzar) {
    if (!silencioso) {
      console.log(`[dev-vars] ${ruta} ya existe; no se modifica (use --force para regenerarlo).`);
    }
    return false;
  }

  const variables = {
    JWT_SECRET: secretoBase64Url(),
    REFRESH_SECRET: secretoBase64Url(),
    SEED_PASSWORD: contrasenaLegible(),
  };
  const contenido =
    '# Generado por scripts/gen-dev-vars.mjs. Solo para desarrollo LOCAL. No versionar.\n' +
    Object.entries(variables)
      .map(([nombre, valor]) => `${nombre}=${valor}`)
      .join('\n') +
    '\n';

  // `mode` se ignora en Windows; en Linux deja el archivo legible solo por su dueño.
  writeFileSync(destino, contenido, { encoding: 'utf8', mode: 0o600 });
  console.log(`[dev-vars] Se generó ${ruta} con: ${Object.keys(variables).join(', ')}.`);
  console.log(`[dev-vars] La contraseña del seed local (SEED_PASSWORD) está en ${ruta}.`);
  return true;
}

const esScriptPrincipal =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (esScriptPrincipal) {
  generarDevVars({ forzar: process.argv.includes('--force') });
}

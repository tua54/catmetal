// Precarga (`node --import`) SOLO para sembrar la base E2E.
//
// scripts/seed.mjs lee la contraseña de los usuarios exclusivamente de apps/worker/.dev.vars. En E2E
// la contraseña debe ser la conocida de scripts/e2e-config.mjs y NO se debe tocar el .dev.vars del
// desarrollador. Esta precarga hace que, dentro del proceso del seed, la lectura de ese archivo vea
// `SEED_PASSWORD=<contraseña E2E>` sin escribir nada en disco. No afecta a otros procesos.
// (Mejora sugerida: que seed.mjs acepte SEED_PASSWORD por variable de entorno y retirar este archivo.)

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { CONTRASENA_E2E, RAIZ } from './e2e-config.mjs';

const objetivo = resolve(join(RAIZ, 'apps', 'worker', '.dev.vars'));
const contenido = `SEED_PASSWORD=${CONTRASENA_E2E}\n`;
const esObjetivo = (ruta) => typeof ruta === 'string' && resolve(ruta) === objetivo;

const existsSync = fs.existsSync;
const readFileSync = fs.readFileSync;
fs.existsSync = (ruta) => (esObjetivo(ruta) ? true : existsSync(ruta));
fs.readFileSync = (ruta, ...resto) => (esObjetivo(ruta) ? contenido : readFileSync(ruta, ...resto));
syncBuiltinESMExports();

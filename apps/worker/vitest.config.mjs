// Pruebas del Worker dentro del runtime de Workers (workerd) con @cloudflare/vitest-plugin.
// D1, R2, KV y Rate Limiting son los locales reales de Miniflare (sin mocks).
//
// Es .mjs a propósito: si fuera .ts tendría que entrar en el tsconfig del Worker y arrastraría
// @types/node (vía miniflare/undici) al programa de src/, que corre en workerd y no en Node.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { defineConfig } from 'vitest/config';

// Relativa al directorio del paquete: pnpm ejecuta los scripts con cwd = apps/worker.
const DIRECTORIO_MIGRACIONES = '../../migrations';

// Secretos fijos SOLO para pruebas. También se exponen en process.env porque Wrangler valida
// `secrets.required` contra .dev.vars/.env/process.env (si no, avisa en cada archivo de prueba).
const SECRETOS_DE_PRUEBA = {
  JWT_SECRET: 'secreto-jwt-de-prueba-no-usar-fuera-de-vitest',
  REFRESH_SECRET: 'secreto-refresh-de-prueba-no-usar-fuera-de-vitest',
};
for (const [nombre, valor] of Object.entries(SECRETOS_DE_PRUEBA)) {
  process.env[nombre] = valor;
}

const migraciones = await readD1Migrations(DIRECTORIO_MIGRACIONES);

// Archivos que revisa la prueba estática de la ADR 0006 (sin reemplazo implícito de SQLite).
// workerd no tiene `fs`: la lista se arma aquí, en Node, y se pasa como binding de prueba.
const DIRECTORIOS_REVISADOS = ['src', DIRECTORIO_MIGRACIONES, '../../scripts'];
const EXTENSIONES_REVISADAS = new Set(['.ts', '.sql', '.mjs']);

function archivosFuente(directorio) {
  return readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      return archivosFuente(ruta);
    }
    return EXTENSIONES_REVISADAS.has(extname(entrada.name)) ? [ruta] : [];
  });
}

// Workflows de GitHub Actions para la prueba estática de B8 (despliegue solo desde main).
const DIRECTORIO_WORKFLOWS = '../../.github/workflows';
const workflows = readdirSync(DIRECTORIO_WORKFLOWS)
  .filter((nombre) => extname(nombre) === '.yml')
  .map((nombre) => ({
    ruta: `.github/workflows/${nombre}`,
    contenido: readFileSync(join(DIRECTORIO_WORKFLOWS, nombre), 'utf8'),
  }));

const archivosRevisados = DIRECTORIOS_REVISADOS.flatMap(archivosFuente).map((ruta) => ({
  ruta: relative('../..', ruta).replaceAll('\\', '/'),
  contenido: readFileSync(ruta, 'utf8'),
}));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Segunda D1 local, SOLO de pruebas: la base limpia donde la prueba de restauración importa
        // el NDJSON del backup (ADR 0021, punto 9). No existe en wrangler.jsonc.
        d1Databases: { DB_RESTAURADA: 'restauracion-pruebas' },
        bindings: {
          ...SECRETOS_DE_PRUEBA,
          TEST_MIGRATIONS: migraciones,
          TEST_ARCHIVOS_FUENTE: archivosRevisados,
          TEST_WORKFLOWS: workflows,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/aplicar-migraciones.ts'],
    coverage: {
      // En el pool de Workers solo funciona istanbul (v8 no).
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      // Umbral mínimo del proyecto (CLAUDE.md). No se baja para pasar.
      thresholds: {
        lines: 80,
      },
    },
  },
});

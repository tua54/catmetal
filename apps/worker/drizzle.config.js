// Configuración de drizzle-kit (solo `generate`, sin conexión a ninguna base).
//
// - Sin `driver` ni credenciales a propósito: `drizzle-kit migrate/push` con `d1-http` irían contra la
//   D1 remota y están prohibidos (CLAUDE.md). Las migraciones se aplican con
//   `wrangler d1 migrations apply DB --local` (script `db:migrate:local`).
// - Es .js (ESM, porque el paquete es "type": "module") para no meter un archivo de Node en el
//   programa TypeScript de src/ (que corre en workerd) y para que ESLint lo trate como JS.
// - Rutas relativas a apps/worker (pnpm ejecuta los scripts con ese cwd).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: '../../migrations',
  strict: true,
  verbose: true,
});

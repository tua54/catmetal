// Tipos de Hono para el Worker.
//
// `Env` lo genera `wrangler types` en worker-configuration.d.ts a partir de wrangler.jsonc
// (bindings, vars y `secrets.required`). Tras cambiar wrangler.jsonc: `pnpm --filter @catmetal/worker cf-typegen`.

export interface AppEnv {
  Bindings: Env;
}

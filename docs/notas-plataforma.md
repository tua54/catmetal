# Notas de plataforma

Particularidades encontradas en Windows, Cloudflare y las librerías durante la sesión.

## Windows

- **pnpm sin permisos de administrador.** `corepack enable` intenta escribir en `C:\Program Files\nodejs` y falla con `EPERM`. Alternativa sin admin: `corepack enable pnpm --install-directory "%APPDATA%\npm"` (esa carpeta ya está en el `PATH` del usuario; crearla si no existe).

## Diseño

- El servidor MCP de Figma no estaba conectado en la sesión. Se trabajó con `docs/diseno/README.md` y las capturas de baja resolución.

## Versiones

- `typescript-eslint` 8.72 admite `typescript >=4.8.4 <6.1.0`, así que no se puede usar TypeScript 7 (la versión `latest` en npm). Se fija TypeScript 6.0.x.
- `@cloudflare/vitest-pool-workers` 0.23 exige `vitest ^4.1.0`, así que no se puede usar Vitest 5. Se fija Vitest 4.1.x en todo el monorepo.

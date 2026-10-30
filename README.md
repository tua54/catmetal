# Control de Materia Prima · Catmetal S.A.S.

Aplicación para registrar el **consumo de materias primas por orden de producción** en la planta de Catmetal (La Mesa, Cundinamarca). El supervisor registra desde una tablet, muchas veces **sin conexión**; el jefe aprueba o rechaza cada consumo, y todo queda auditado.

Es una PWA offline-first (React + Vite + Dexie) servida por un único Cloudflare Worker (Hono) con D1, R2 y KV. Los requisitos completos están en [`docs/spec.md`](docs/spec.md).

## Estructura del monorepo

```text
apps/web          PWA (React + Vite, Tailwind, vite-plugin-pwa, Dexie)
apps/worker       Worker de Cloudflare: API /api/v1 (Hono) + PWA compilada como Static Assets
packages/shared   Contratos compartidos: tipos, esquemas Zod, roles, permisos, errores, unidades
migrations        Migraciones SQL de D1 (se aplican solo en local con wrangler)
scripts           Scripts de Node para desarrollo (dev, .dev.vars, dist de la web)
docs              Especificación, diseño, planes, ADR, progreso, evidencia y auditoría
```

## Arranque en Windows

Los comandos funcionan igual en **PowerShell** y en **cmd**. No se necesitan permisos de administrador.

### 1. Node.js

Instale Node.js **22 o superior**. Se recomienda la versión **24**, que es la del archivo `.nvmrc`. Compruebe la versión:

```text
node --version
```

### 2. pnpm (con corepack, sin administrador)

La versión de pnpm está fijada en el campo `packageManager` de `package.json` (pnpm 12). Corepack, incluido en Node.js, la instala por usted.

`corepack enable` a secas intenta escribir en `C:\Program Files\nodejs` y falla con `EPERM` si no es administrador. Instale el shim de pnpm en su carpeta de usuario `%APPDATA%\npm`, que ya está en el `PATH` del usuario.

En **PowerShell**:

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\npm" | Out-Null
corepack enable pnpm --install-directory "$env:APPDATA\npm"
```

En **cmd**:

```bat
if not exist "%APPDATA%\npm" mkdir "%APPDATA%\npm"
corepack enable pnpm --install-directory "%APPDATA%\npm"
```

Si tiene permisos de administrador, también sirve `corepack enable` desde una consola elevada.

Abra una consola nueva y compruebe:

```text
pnpm --version
```

### 3. Dependencias

Desde la raíz del repositorio:

```text
pnpm install
```

### 4. Secretos locales (`.dev.vars`)

```text
pnpm setup:dev-vars
```

Genera `apps/worker/.dev.vars` con `JWT_SECRET`, `REFRESH_SECRET` y `SEED_PASSWORD` aleatorios, y no sobrescribe uno existente. Use `node scripts/gen-dev-vars.mjs --force` para regenerarlo.

- La contraseña de los usuarios del seed local (`SEED_PASSWORD`) está en ese archivo.
- `.dev.vars` está en `.gitignore`. **Nunca lo versione ni lo comparta.** `apps/worker/.dev.vars.example` lista solo los nombres.

### 5. Base de datos local

```text
pnpm db:migrate:local
```

Aplica las migraciones de `migrations/` a la D1 **local**, guardada en `apps/worker/.wrangler/state`. Para empezar de cero, borre la carpeta `apps/worker/.wrangler`.

### 6. Desarrollo

```text
pnpm dev
```

- Genera `.dev.vars` si falta, aplica las migraciones locales y lanza dos procesos:
  - `wrangler dev`: API y PWA compilada en http://127.0.0.1:8787 (D1, R2 y KV locales).
  - `vite`: PWA con recarga en caliente en **http://localhost:5173**, que reenvía `/api` a la API en el puerto 8787.
- Abra **http://localhost:5173** en el navegador. Si `localhost` no responde, use http://127.0.0.1:5173.
- Comprobación rápida de la API: http://127.0.0.1:8787/api/v1/health.
- Para detenerlo, pulse **Ctrl+C** en la consola: se cierran los dos procesos y `workerd`.

Si un puerto quedó ocupado por una sesión anterior que no se cerró bien, en **PowerShell**:

```powershell
Get-NetTCPConnection -LocalPort 8787,5173 -State Listen | Select-Object LocalPort, OwningProcess
```

Luego cierre ese proceso con `taskkill /PID <pid> /T /F`.

### 7. Verificación (gates de calidad)

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

`pnpm test` incluye la cobertura de `packages/shared` y `apps/worker`, con un umbral de líneas del 80 %. Las pruebas del Worker corren dentro de `workerd`, con D1, R2 y KV locales reales.

## Scripts de la raíz

| Script                              | Qué hace                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`                          | Entorno de desarrollo local completo (Worker + Vite).                          |
| `pnpm setup:dev-vars`               | Genera `apps/worker/.dev.vars` con secretos aleatorios locales.                |
| `pnpm db:migrate:local`             | Aplica las migraciones a la D1 local.                                          |
| `pnpm db:seed:local`                | Carga usuarios, materiales y órdenes de prueba en la D1 local.                 |
| `pnpm db:reset:local`               | Borra solo el estado local de Wrangler, vuelve a migrar y siembra.             |
| `pnpm lint`                         | ESLint en todo el repositorio.                                                 |
| `pnpm typecheck`                    | `tsc --noEmit` en cada paquete; en el Worker también `wrangler types --check`. |
| `pnpm test`                         | Pruebas de todos los paquetes, con cobertura.                                  |
| `pnpm test:e2e`                     | Pruebas E2E con Playwright (Chromium y WebKit), incluidos offline, PWA y axe.  |
| `pnpm test:e2e:instalar`            | Descarga los navegadores de Playwright (una vez).                              |
| `pnpm test:lighthouse`              | Lighthouse con perfil de tablet; falla si alguna categoría baja de 90.         |
| `pnpm format` / `pnpm format:check` | Aplica o verifica el formato de Prettier.                                      |

Scripts útiles por paquete:

- `pnpm --filter @catmetal/web build`: compila la PWA en `apps/web/dist`.
- `pnpm --filter @catmetal/worker cf-typegen`: regenera `apps/worker/worker-configuration.d.ts` después de cambiar `wrangler.jsonc`.

## Reglas

- **Nada remoto.** Todo el desarrollo y las pruebas usan recursos locales (`wrangler dev`, `--local`). No ejecute `wrangler deploy`, `wrangler secret`, `wrangler login` ni comandos con `--remote`.
- **El despliegue lo hace una persona** siguiendo [`docs/despliegue.md`](docs/despliegue.md). Requiere el plan Workers Paid. El primer administrador de staging/producción se genera con `node scripts/crear-admin-sql.mjs` (solo escribe un SQL local).
- **Secretos fuera de git**: `.dev.vars` es local; en Cloudflare se usan secrets de Wrangler.
- Las decisiones de arquitectura están en [`docs/adr/`](docs/adr/) y el estado del trabajo, en [`docs/progreso.md`](docs/progreso.md).

# Plan — Fase 0: Fundaciones

Referencia: `docs/spec.md` §2 (arquitectura, monorepo, stack, entornos) y §10 (Fase 0).

**Criterio de cierre:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pasan, y `pnpm dev` levanta el Worker local con D1, R2 y KV locales.

## Decisiones de partida

- Versiones (ver ADR 0001): TypeScript 6.0.x, Vitest 4.1.x, Vite 8, React 19.3, Hono 4.13, Drizzle ORM 0.45 / drizzle-kit 0.31, Wrangler 4.x, Zod 4, Tailwind 4, vite-plugin-pwa 2, Dexie 4, Playwright 1.64, ESLint 10 + typescript-eslint 8.
- `packages/shared` se consume como **código fuente TypeScript** (`"exports": { ".": "./src/index.ts" }`), sin paso de build. Lo resuelven Vite, Wrangler (esbuild) y Vitest. Nombre del paquete: `@catmetal/shared`.
- Nombres de paquetes: `@catmetal/shared`, `@catmetal/worker`, `@catmetal/web`.
- `wrangler.jsonc` vive en `apps/worker/`. `assets.directory = "../web/dist"`, `migrations_dir = "../../migrations"`. `.dev.vars` vive en `apps/worker/` (ignorado por git).
- Proceso de desarrollo (ADR 0002): `pnpm dev` = `wrangler dev` (API + assets, puerto 8787) + `vite` (puerto 5173, proxy de `/api` al 8787), lanzados por un script de Node. No se usa `@cloudflare/vite-plugin` en la v1.
- Nombres de scripts: **ninguno** puede contener `deploy`, `release`, `publish`, `remote`, `prod` ni `staging` (los bloquea el hook del equipo).

## Tareas

### 0.1 — Andamiaje del monorepo y herramientas
- **Responsable:** `general-purpose` (rol Backend/infra).
- **Archivos:** raíz (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.npmrc`, `.nvmrc`), `package.json` y `tsconfig.json` mínimos de `packages/shared`, `apps/worker`, `apps/web`.
- **Contrato:** scripts raíz `lint`, `typecheck`, `test`, `format`, `format:check`, `dev`. Cada paquete expone `typecheck` y `test`.
- **Acepta:** `pnpm install`, `pnpm lint`, `pnpm typecheck` y `pnpm test` pasan con paquetes casi vacíos (una prueba trivial por paquete). Todas las dependencias de la Fase 0 instaladas y fijadas en `pnpm-lock.yaml`.

### 0.2 — `packages/shared`: contratos
- **Responsable:** `general-purpose`.
- **Archivos:** solo `packages/shared/**`.
- **Contrato:** ver "Contrato de `packages/shared`" abajo.
- **Acepta:** pruebas unitarias de conversión de unidades, tolerancia, formato es-CO/Bogotá, UUID v7, permisos por rol y esquemas Zod (casos válidos e inválidos). Cobertura de líneas ≥ 80 %.

### 0.3 — `apps/worker`: esqueleto, Wrangler y pruebas con el pool de Workers
- **Responsable:** `general-purpose`.
- **Archivos:** `apps/worker/**`, `scripts/gen-dev-vars.mjs`, `scripts/dev.mjs`, `scripts/ensure-web-dist.mjs` (si hace falta), `package.json` raíz (scripts).
- **Contrato:** `wrangler.jsonc` con nivel superior (local), `env.staging` y `env.production`; bindings `DB`, `EVIDENCE`, `CONFIG`, `ASSETS`, `LOGIN_LIMITER` repetidos en cada entorno; `assets.not_found_handling = "single-page-application"`; `assets.run_worker_first = ["/api/*"]`; cron `0 8 * * *`; observability habilitado. App Hono con `GET /api/v1/health` y el formato de error único `{ code, message, details }` de `@catmetal/shared`. `.dev.vars.example` solo con nombres (`JWT_SECRET`, `REFRESH_SECRET`, `SEED_PASSWORD`).
- **Acepta:** pruebas con `@cloudflare/vitest-pool-workers` que llaman a `/api/v1/health` y verifican que D1, R2 y KV locales responden (escritura y lectura). `node scripts/gen-dev-vars.mjs` genera `apps/worker/.dev.vars` con valores aleatorios sin sobrescribir uno existente. `pnpm dev` levanta el Worker local.

### 0.4 — `apps/web`: esqueleto de la PWA
- **Responsable:** `react-developer`.
- **Archivos:** solo `apps/web/**`.
- **Contrato:** React + Vite + TS; Tailwind 4 con los tokens de `docs/diseno/README.md` (`brand-*`, `navy-800`, `ink-*`, `surface-50`, semánticos); Poppins empaquetada con `@fontsource/poppins`; proxy de `/api` a `http://127.0.0.1:8787`; build en `apps/web/dist`. Vitest + Testing Library con jsdom.
- **Acepta:** prueba de humo de un componente; `pnpm --filter @catmetal/web build` produce `dist/index.html`.

### 0.5 — CI y README de arranque para Windows
- **Responsable:** `general-purpose`.
- **Archivos:** `.github/workflows/ci.yml`, `README.md`.
- **Acepta:** `ci.yml` con lint, typecheck, test (y e2e preparado para la Fase 4) en `push` y `pull_request`; README con pasos para Windows (Node, corepack sin admin, pnpm, `.dev.vars`, `pnpm dev`).

### 0.6 — ADR de versiones y de proceso de desarrollo
- **Responsable:** orquestador.
- **Archivos:** `docs/adr/0001-versiones.md`, `docs/adr/0002-proceso-de-desarrollo.md`, `docs/adr/0003-shared-como-fuente.md`.

## Orden y paralelismo

0.1 → (0.2 ∥ 0.4) → 0.3 → 0.5. Las ADR se escriben al conocer las versiones instaladas en 0.1. Solo el responsable de 0.4 puede ejecutar `pnpm add` mientras corre en paralelo con 0.2, y solo dentro de `apps/web`.

## Contrato de `packages/shared`

Módulos (todos exportados desde `src/index.ts`):

- `dominio.ts` — constantes `as const` y tipos derivados:
  `ROLES = ['supervisor','jefe','admin']`, `ESTADOS_ORDEN = ['planeada','en_proceso','finalizada','cancelada']`, `ESTADOS_CONSUMO = ['pendiente','aprobado','rechazado']`, `UNIDADES = ['kg','g','l','ml','und','m']`, `TIPOS_NOVEDAD = ['reproceso','merma','dano','error_registro','otro']`, `DECISIONES = ['aprobado','rechazado']`, `RESULTADOS_MUTACION = ['aplicada','rechazada','conflicto']`, `ESTADOS_OUTBOX = ['pendiente','enviando','aplicada','rechazada','conflicto']`, `TIPOS_MUTACION = ['consumo.crear','consumo.editar','novedad.crear','consumo.aprobar','consumo.rechazar']`, `MIMES_EVIDENCIA = ['image/jpeg','image/png','image/webp']`, y límites: `TOLERANCIA_PCT_DEFECTO = 5`, `MAX_MUTACIONES_POR_LOTE = 25`, `MAX_CAMBIOS_PULL = 200`, `MAX_FILAS_REVISADAS_PULL = 1000`, `MAX_EVIDENCIA_BYTES = 5 * 1024 * 1024`, `MAX_EVIDENCIAS_POR_NOVEDAD = 5`, `PBKDF2_ITERACIONES_SERVIDOR = 100_000`, `ACCESS_TOKEN_TTL_S = 900`, `REFRESH_TOKEN_TTL_S = 2_592_000`, `MAX_INTENTOS_LOGIN = 5`, `BLOQUEO_MINUTOS = 15`, `ALERTA_RELOJ_MS = 600_000`, `ZONA_HORARIA = 'America/Bogota'`.
- `permisos.ts` — `PERMISOS` (`ordenes.ver_todas`, `ordenes.gestionar`, `consumos.registrar`, `consumos.editar_propio`, `novedades.registrar`, `consumos.validar`, `auditoria.ver_todo`, `admin.gestionar`), `PERMISOS_POR_ROL` según la tabla de la §3 de la spec y `tienePermiso(rol, permiso)`.
- `errores.ts` — `CODIGOS_ERROR` (al menos: `NO_AUTENTICADO`, `PERMISO_DENEGADO`, `VALIDACION`, `NO_ENCONTRADO`, `CONFLICTO`, `CREDENCIALES_INVALIDAS`, `CUENTA_BLOQUEADA`, `DEMASIADOS_INTENTOS`, `ORIGEN_INVALIDO`, `TOKEN_INVALIDO`, `SESION_REVOCADA`, `UNIDAD_INCOMPATIBLE`, `ORDEN_NO_EN_PROCESO`, `ESTADO_ORDEN_INVALIDO`, `ORDEN_CON_PENDIENTES`, `CONSUMO_NO_PENDIENTE`, `AUTOAPROBACION`, `REQUIERE_NOVEDAD`, `DEPENDENCIA_RECHAZADA`, `EVIDENCIA_DESCONOCIDA`, `EVIDENCIA_TIPO_INVALIDO`, `EVIDENCIA_DEMASIADO_GRANDE`, `EVIDENCIA_YA_SUBIDA`, `CORRECCION_INVALIDA`, `MATERIAL_INACTIVO`, `USUARIO_INACTIVO`, `ID_INVALIDO`, `ID_DUPLICADO`, `LOTE_DEMASIADO_GRANDE`, `ERROR_INTERNO`), `MENSAJES_ERROR` en español de Colombia, el tipo `ApiError = { code, message, details? }` y `crearError(code, details?)`.
- `unidades.ts` — `MAGNITUD` por unidad, `sonConvertibles(de, a)`, `convertir(cantidad, de, a): number | null` (solo `kg↔g`, `l↔ml`, identidad; redondeo a 6 decimales para evitar errores de coma flotante), `excedeTolerancia({ planeada, consumidaAcumulada, toleranciaPct })` (estrictamente mayor que planeada × (1 + tol/100)).
- `formato.ts` — `formatearCOP(n)` con `Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', maximumFractionDigits: 0 })`, `formatearHora(iso)` (12 h, `a. m.`/`p. m.`, Bogotá), `formatearFechaHora(iso)`, `formatearCantidad(n)` (hasta 3 decimales, coma decimal), `parsearCantidad(texto)` (acepta punto o coma; devuelve `number | null`), `diaBogota(iso)` → `AAAA-MM-DD`.
- `uuid.ts` — `uuidv7()` con `crypto.getRandomValues` (sirve en navegador y Worker) y `esUuidV7(s)`.
- `esquemas.ts` — Zod 4:
  - `uuidV7Schema`, `isoFechaSchema` (ISO-8601 UTC con `Z`), `cantidadSchema` (> 0, máximo 3 decimales, ≤ 1e9), `loteSchema` (1–64), `emailSchema` (trim + minúsculas), `passwordSchema` (10–128).
  - Auth: `loginSchema { email, password, device_id, device_nombre? }`.
  - Admin: `crearUsuarioSchema`, `editarUsuarioSchema` (nombre?, rol?, activo?, password?), `crearMaterialSchema`, `editarMaterialSchema`, `toleranciaSchema { tolerancia_pct: 0..100 }`, `asignarSupervisoresSchema { supervisores: uuid[] }`.
  - Órdenes: `crearOrdenSchema { id?, codigo /^OP-\d{4}-\d{4}$/, linea, materiales: [{ material_id, cantidad_planeada, unidad }] }`, `finalizarOrdenSchema { force?: boolean }`.
  - Consumos: `crearConsumoSchema { id, order_id, material_id, cantidad, unidad, lote, client_created_at, corrige_a?: uuid | null }`, `editarConsumoSchema { id, version, material_id?, cantidad?, unidad?, lote?, client_created_at }`.
  - Novedades: `evidenciaMetaSchema { id, mime, tamano_bytes ≤ 5 MB, sha256 (hex 64) }`, `crearNovedadSchema { id, consumption_id, tipo, descripcion (1–2000), client_created_at, evidencias: evidenciaMeta[] ≤ 5 }`.
  - Validación: `aprobarSchema { id (de la validación), client_created_at }`, `rechazarSchema { id, motivo (3–500), client_created_at }`.
  - Sync: `mutacionSchema` (unión discriminada por `tipo` sobre `TIPOS_MUTACION`, con `mutation_id`, `client_created_at` y `payload` con el esquema correspondiente; en `consumo.aprobar` y `consumo.rechazar` el payload lleva además `consumption_id`), `syncPushRequestSchema { device_id, mutaciones: 1..25 }`, `resultadoMutacionSchema { mutation_id, resultado, code?, message?, servidor? }`, `syncPullQuerySchema { cursor: entero ≥ 0 }` y el tipo de respuesta `SyncPullResponse { cursor, hay_mas, cambios: Array<{ seq, tipo: 'upsert' | 'revocar', entidad, id, datos }> }`.
- `tipos.ts` — interfaces de las filas que expone la API (`Usuario` sin `password_hash`, `Material`, `Orden`, `MaterialPlaneado`, `Consumo`, `Novedad`, `Evidencia`, `Validacion`, `EntradaAuditoria`, `Perfil` con permisos).

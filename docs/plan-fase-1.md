# Plan — Fase 1: Base de datos y autenticación

Referencia: `docs/spec.md` §3 (roles), §4 (D1), §5 (auth) y §10 (Fase 1). ADR: 0005 (cursor `audit_log.seq`), 0006 (triggers en migración propia), 0007 (hash de contraseñas y de refresh tokens), 0008 (sesiones, CSRF, bloqueo, dispositivos), 0009 (época de sync y contrato robusto de push). Las cinco incorporan la revisión de `software-architect` del 2026-10-29; **en caso de diferencia, mandan las ADR sobre este plan**.

**Criterio de cierre (§10):** pruebas con el pool de Workers que demuestran: UPDATE/DELETE en `audit_log` fallan y DELETE falla en las tablas de negocio; todos los triggers existen después de todas las migraciones; FK activas; iteraciones PBKDF2 ≤ 100.000; login y rotación funcionan; la reutilización de un refresh revoca su familia; el bloqueo se activa tras 5 intentos; cada regla de la §3 probada (positiva y negativa); la auditoría no contiene secretos.

## Diseño

### Esquema (`apps/worker/src/db/schema.ts`, Drizzle `sqlite-core`)

Tablas y columnas de la §4 de la spec, con `created_at`/`updated_at` TEXT ISO UTC en todas. Además:

- `CHECK` en todos los enumerados (`rol`, `estado`, `unidad`, `tipo`, `decision`, `resultado`), en los booleanos (`IN (0,1)`), en `cantidad > 0`, `cantidad_planeada > 0`, `costo_unitario_cop >= 0`, en JSON (`json_valid`) y en `validations`: `decision = 'aprobado' OR (motivo IS NOT NULL AND length(trim(motivo)) >= 3)`.
- `users.email` único (siempre en minúsculas). `materials.codigo` y `production_orders.codigo` únicos.
- `order_planned_materials`: PK compuesta (`order_id`, `material_id`).
- `consumptions.corrige_a` → índice **único parcial** (`WHERE corrige_a IS NOT NULL`): un rechazado se corrige una sola vez.
- `consumptions.version` INTEGER NOT NULL DEFAULT 1.
- `devices.id` lo propone el cliente (UUID v7 por usuario y navegador); si ya pertenece a otro usuario, el servidor asigna uno nuevo y lo devuelve. Columna adicional `devices.instalacion_id` (TEXT, nullable; id por navegador compartido entre usuarios, ADR 0008).
- `refresh_tokens.token_hash` **UNIQUE**; índice adicional `refresh_tokens(familia_id)`.
- `validations(consumption_id)` **UNIQUE** (un consumo se decide una sola vez).
- `sync_mutations.payload_json` (TEXT nullable, `json_valid`, ≤ 64 KB) para mutaciones rechazadas o en conflicto (ADR 0009). `settings` incluye `sync_epoca` (ADR 0009).
- Columnas de fecha: siempre `toISOString()` (24 caracteres, milisegundos, `Z`), con `CHECK (length(col) = 24)` en las columnas NOT NULL de fecha.
- `audit_log.seq INTEGER PRIMARY KEY AUTOINCREMENT`.
- Índices exactos de la §4.

Migraciones en `/migrations` (raíz). `0000_*.sql` generada por drizzle-kit; `0001_triggers.sql` creada con `drizzle-kit generate --custom --name triggers` y escrita a mano.

### Triggers (`0001_triggers.sql`)

La lista completa y obligatoria está en la ADR 0006 (incluye la prohibición de `REPLACE` con prueba estática). La prueba de `sqlite_master` verifica exactamente esa lista.

### Auth

- Contraseñas: `pbkdf2-sha256$100000$<sal_b64>$<hash_b64>`, sal de 16 bytes, hash de 32 bytes, comparación de tiempo constante. Constante `PBKDF2_ITERACIONES_SERVIDOR` de `@catmetal/shared` con prueba `≤ 100_000`. Si el usuario no existe se ejecuta igual una derivación ficticia (tiempo parejo).
- Access token, refresh, rotación (orden INSERT → UPDATE → auditoría condicional), ventana de gracia de 30 s, middleware (rol actual desde D1, familia vigente), CSRF por Origin, fuerza bruta (contador atómico en SQL; sin comparar el hash durante el bloqueo), dispositivos e instalacion_id: **ver ADR 0008**, que manda.
- Auditoría: helper `auditar(...)` que devuelve la sentencia de inserción para incluirla en el mismo `db.batch()`, aplica una **lista blanca de columnas por entidad** (nunca `password_hash`, `token_hash` ni secretos; un campo nuevo no se audita hasta que se agregue a la lista), y calcula `alerta_reloj` (|client_at − server_at| > 10 min).
- Endpoints: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, y de admin `GET /users`, `POST /users`, `PATCH /users/:id` (desactivar, cambiar rol, restablecer contraseña; nunca borrar).

### Seed (`scripts/seed.mjs`)

Node puro. Lee `SEED_PASSWORD` de `apps/worker/.dev.vars`, genera hashes con `node:crypto` en el mismo formato, escribe un SQL temporal y ejecuta `wrangler d1 execute DB --local --file`. Idempotente (`INSERT OR IGNORE`). Inserta también sus filas de `audit_log` (`accion = 'seed'`), porque `/sync/pull` recorre la auditoría. Rechaza ejecutarse si recibe `--remote` o un `--env`.

## Tareas

| Id | Tarea | Responsable | Archivos | Depende de | Aceptación |
|---|---|---|---|---|---|
| 1.0 | Ajustes de contrato en `packages/shared` por ADR 0008/0009: sobre laxo de `/sync/push` con `user_id`, `indice` en resultados, cambios `hidratar`/`reiniciar`, `epoca` en el pull, fechas normalizadas a milisegundos, `instalacion_id` en el login, `detallesValidacion` acepta `{ issues }` | `general-purpose` | `packages/shared/**` | Fase 0 | Pruebas actualizadas; cobertura ≥ 80 % |
| 1.1 | Esquema Drizzle, migración generada, migración de triggers, `drizzle.config.ts`, script `db:generate` y `db:migrate:local` | `general-purpose` | `apps/worker/src/db/**`, `migrations/**`, `apps/worker/drizzle.config.ts`, scripts de `apps/worker/package.json` y raíz | Fase 0 | Pruebas: triggers presentes, `audit_log` inmutable, DELETE bloqueado en negocio, cambio de cantidad en consumo aprobado bloqueado, FK inválida falla |
| 1.2 | Seed local | `general-purpose` | `scripts/seed.mjs`, `package.json` raíz | 1.1 | `pnpm db:seed:local` dos veces seguidas sin error; conteos esperados |
| 1.3 | Auth: hash, JWT, refresh con rotación, bloqueo, middlewares (auth, CSRF, permisos), auditoría, endpoints de auth y de usuarios | `general-purpose` | `apps/worker/src/**` (salvo `db/schema.ts`), `apps/worker/test/**` | 1.1 | Pruebas de login, rotación, reutilización, bloqueo, limitador, CSRF, iteraciones ≤ 100k, auditoría sin secretos |
| 1.4 | Matriz de permisos de la §3 (positiva y negativa por regla) | `test-engineer` | `apps/worker/test/permisos*.test.ts` | 1.3 | Una prueba positiva y una negativa por fila de la tabla |
| 1.5 | Revisión del esquema, triggers e índices | `database-specialist` (solo lectura) | — | 1.1–1.3 | Informe; hallazgos corregidos o justificados |
| 1.7 | Aplicar la revisión del esquema (ADR 0010): migraciones 0003–0004, índices, `audit_log.order_id`, `version` en aprobar/rechazar | `general-purpose` | `apps/worker/**`, `migrations/**`, `packages/shared/**`, `scripts/seed.mjs` | 1.5 | Gates en verde; 34 triggers |
| 1.6 | ADR 0005–0010 | orquestador | `docs/adr/` | — | — |

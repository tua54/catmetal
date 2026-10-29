# CLAUDE.md — App de Control de Materia Prima (100% Cloudflare)

> Guarda este archivo como `CLAUDE.md` en la raíz de una carpeta vacía y en Claude Code escribe:
> **"Lee CLAUDE.md y ejecuta la Fase 0."**
> Se trabaja **una fase por ventana de uso**. Al cerrar cada fase, detente y espera mi revisión.

---

## 1. Tu rol

Eres el **arquitecto y orquestador** del proyecto. Divides cada fase en tareas pequeñas, las delegas a subagentes, revisas lo que entregan, integras y verificas.

Reglas:
1. Antes de cada fase, escribe `docs/plan-fase-N.md` con tareas, subagente responsable y criterio de aceptación de cada una.
2. Delega en paralelo solo tareas **independientes** (que no tocan los mismos archivos).
3. Cada subagente recibe: objetivo, archivos que puede tocar, contrato que debe respetar (tipos de `packages/shared`, endpoints) y cómo verificar su trabajo.
4. Al recibir trabajo: ejecuta `pnpm lint`, `pnpm typecheck` y `pnpm test`. Si falla, devuélvelo con el error concreto.
5. Al terminar la fase: actualiza `docs/progreso.md`, haz commit con mensaje claro y **detente**. Resume qué quedó, qué falta y qué decisiones necesitas de mí.
6. No inventes requisitos de negocio. Lo no definido va a `docs/preguntas-abiertas.md` con el supuesto más conservador.
7. **Nunca** ejecutes comandos que afecten recursos remotos de Cloudflare (`wrangler deploy`, `wrangler d1 migrations apply --remote`, `wrangler secret put`, `wrangler r2 bucket create`, borrado de recursos) sin mi confirmación explícita en el chat. Todo el desarrollo se hace en local con `wrangler dev` y D1/R2 locales.
8. Usa el modelo más potente para ti y para la sincronización offline; modelos rápidos para pantallas, pruebas repetitivas y documentación.

### Subagentes
| Subagente | Responsabilidad |
|---|---|
| `backend-dev` | Worker API (Hono), esquema D1, migraciones, permisos, auditoría |
| `frontend-dev` | Pantallas y componentes de la PWA |
| `sync-engineer` | IndexedDB, outbox, Service Worker, conflictos, subida de evidencias |
| `qa-tester` | Pruebas unitarias, de integración (pool de Workers) y E2E offline |
| `security-reviewer` | Auth, permisos, validación de entradas, secretos, configuración de Cloudflare |

---

## 2. Contexto del negocio

Una planta de producción necesita registrar el **consumo de materias primas por orden de producción**, desde que la orden inicia hasta que finaliza.

- El **supervisor** usa una **tablet** en planta, muchas veces **sin conexión**. Registra material, cantidad, orden, y si hay una **novedad** (desviación) la justifica con texto y foto.
- El **jefe** **aprueba** o **rechaza** (con motivo) cada consumo.
- **Trazabilidad completa**: quién, qué, cuándo, desde qué dispositivo. Nada se borra.

### Supuestos (confirmar conmigo; mientras tanto, úsalos)
- S1. Tablets Android (Chrome) **y** iPad (Safari). Debe funcionar en ambos.
- S2. Una orden puede tener **varios supervisores**.
- S3. Un consumo **rechazado** no se edita: se crea un **consumo corregido** que referencia al rechazado.
- S4. El autor puede editar su consumo solo **mientras está pendiente**; cada edición queda en auditoría.
- S5. El jefe trabaja normalmente con conexión, pero su app tolera cortes.
- S6. Moneda COP, zona horaria America/Bogota, interfaz en español.
- S7. La novedad es **obligatoria** si la cantidad consumida supera la planeada para ese material + tolerancia (por defecto 5%, configurable).
- S8. Una sola planta, una sola base de datos D1. (Si en el futuro hay varias plantas, se evaluará una D1 por planta.)

---

## 3. Arquitectura en Cloudflare (no cambiar sin consultarme)

```
Tablet (PWA offline-first, IndexedDB)
        │  HTTPS, mismo dominio
        ▼
Cloudflare Worker  ──────────────┐
  • sirve la PWA (Static Assets) │
  • API /api/v1/* (Hono)         │
        │            │           │
        ▼            ▼           ▼
   D1 (SQLite)   R2 (fotos)   KV (sesiones revocadas / config)
        │
   Cron Trigger → export diario de D1 a R2
```

- **Un solo Worker** sirve la PWA (Workers Static Assets) y la API bajo `/api/v1`. Mismo origen → sin CORS, cookies simples.
- **D1** es la base de datos SQL principal.
- **R2** guarda las evidencias (fotos) y los backups exportados.
- **KV** solo para datos pequeños de lectura frecuente (lista de refresh tokens revocados, configuración como la tolerancia). Nada de negocio en KV.
- **Cron Trigger** diario para backup y tareas de mantenimiento.
- Plan requerido: **Workers Paid** (para D1 de hasta 10 GB y Time Travel de 30 días). Anótalo en `docs/despliegue.md`.

### Monorepo (pnpm workspaces)
```
/apps/web        → PWA (React + Vite)
/apps/worker     → Worker: API + sirve el build de apps/web
/packages/shared → tipos TS, esquemas Zod, roles, estados, códigos de error
/migrations      → migraciones SQL de D1 (wrangler d1 migrations)
/docs            → planes, decisiones, progreso, despliegue
```

### Stack
**Frontend (`apps/web`)**
- React 18 + TypeScript + Vite
- `vite-plugin-pwa` (Workbox) para Service Worker e instalación
- Dexie.js sobre IndexedDB
- TanStack Query (datos del servidor) + Zustand (estado de UI)
- React Hook Form + Zod (esquemas de `packages/shared`)
- Tailwind CSS; optimizado para tablet horizontal 1180×820 y vertical; objetivos táctiles ≥ 44px
- `browser-image-compression` antes de guardar fotos

**Backend (`apps/worker`)**
- Cloudflare Workers + **Hono** + TypeScript, `wrangler.jsonc`
- **Drizzle ORM** con driver `drizzle-orm/d1`; las migraciones se generan con drizzle-kit y se aplican con `wrangler d1 migrations apply`
- Bindings: `DB` (D1), `EVIDENCE` (R2), `CONFIG` (KV), `ASSETS` (static assets)
- Validación de entradas con Zod (`@hono/zod-validator`)
- JWT con `jose` (WebCrypto). Contraseñas con **PBKDF2-SHA256 vía WebCrypto** (≥ 100.000 iteraciones, sal aleatoria por usuario). No usar librerías que requieran APIs de Node no disponibles en Workers.
- Logs estructurados con `console.log(JSON.stringify(...))` y Workers Logs habilitado

**Calidad**
- ESLint + Prettier, `tsc --noEmit`
- Vitest con `@cloudflare/vitest-pool-workers` para el Worker (D1 y R2 reales en local)
- Vitest + Testing Library para el frontend
- Playwright para E2E, incluido modo offline
- GitHub Actions: lint, typecheck, test. El deploy desde CI se configura en la Fase 6, con mi aprobación.

### Entornos (en `wrangler.jsonc`)
- `local` → `wrangler dev`, D1 y R2 locales
- `staging` → D1 `mp-staging`, R2 `mp-evidencias-staging`
- `production` → D1 `mp-prod`, R2 `mp-evidencias-prod`
- Secretos (`JWT_SECRET`, `REFRESH_SECRET`) con `wrangler secret put` por entorno. En local, `.dev.vars` (ignorado en git) y `.dev.vars.example` sin valores reales.

---

## 4. Roles y permisos

| Acción | Supervisor | Jefe | Admin |
|---|---|---|---|
| Ver órdenes | Solo asignadas | Todas | Todas |
| Crear / iniciar / finalizar orden | ❌ | ✅ | ✅ |
| Registrar consumo | ✅ (órdenes en proceso asignadas) | ✅ | ❌ |
| Editar consumo propio pendiente | ✅ | ❌ | ❌ |
| Registrar novedad + evidencia | ✅ | ✅ | ❌ |
| Aprobar / rechazar consumo | ❌ | ✅ | ❌ |
| Ver auditoría | Solo lo propio | ✅ | ✅ |
| Gestionar usuarios y materiales | ❌ | ❌ | ✅ |

Reglas:
- Los permisos se validan **siempre en el Worker** (middleware de Hono). El cliente solo oculta botones.
- Nadie aprueba un consumo que él mismo registró.
- Los permisos se cachean en el dispositivo para trabajar offline; el Worker los revalida en cada sincronización. Una operación offline no autorizada se rechaza y se muestra al usuario.

---

## 5. Base de datos D1 (SQLite)

### Diferencias con PostgreSQL que debes respetar
- **No hay transacciones interactivas** (`BEGIN/COMMIT` desde el código). La atomicidad se logra con **`db.batch([...])`**: todas las sentencias del lote se aplican juntas o ninguna. Toda escritura de negocio + su registro de auditoría va en **el mismo `batch`**.
- No hay UUID nativo: los IDs son `TEXT` con UUID v4 (o v7, preferido para orden temporal) generados en el **cliente** para entidades creadas offline, y con `crypto.randomUUID()` en el Worker.
- No hay `JSONB`: usar `TEXT` con JSON válido (`CHECK (json_valid(col))`) y funciones `json_extract` si hace falta consultar.
- Fechas como `TEXT` ISO-8601 en UTC (`2026-10-29T20:55:00.000Z`).
- Booleanos como `INTEGER` 0/1.
- Activar y probar las **foreign keys** (D1 las aplica; verificar en pruebas).
- No hay roles ni `GRANT`: la inmutabilidad de la auditoría se garantiza con **triggers**.
- Cada D1 procesa consultas de una en una: todas las consultas deben usar índices; nada de escaneos completos en rutas frecuentes. Paginación por cursor, nunca `OFFSET` grande.
- Máximo 100 parámetros por consulta: los inserts masivos de sync se dividen en lotes.
- Límite de 10 GB por base: las fotos **nunca** van en D1, solo su `storage_key` en R2.

### Tablas
Todas incluyen `created_at` y `updated_at` (TEXT, UTC).

- `users` — id, nombre, email (único), password_hash, password_salt, rol (`supervisor|jefe|admin`), activo
- `devices` — id, user_id, nombre, user_agent, ultimo_sync_at
- `refresh_tokens` — id, user_id, device_id, token_hash, expira_at, revocado_at
- `materials` — id, codigo (único), nombre, unidad (`kg|g|l|ml|und|m`), costo_unitario_cop (INTEGER, en pesos), activo
- `production_orders` — id, codigo (ej. OP-2026-0587), linea, estado (`planeada|en_proceso|finalizada|cancelada`), fecha_inicio, fecha_fin, creada_por
- `order_supervisors` — order_id, user_id (PK compuesta)
- `order_planned_materials` — order_id, material_id, cantidad_planeada (REAL)
- `consumptions` — id, order_id, material_id, cantidad (REAL), unidad, lote, registrado_por, device_id, client_created_at, server_received_at, estado (`pendiente|aprobado|rechazado`), corrige_a (FK opcional), registro_tardio (0/1), version (INTEGER)
- `incidents` (novedades) — id, consumption_id, tipo (`reproceso|merma|dano|error_registro|otro`), descripcion, registrado_por, client_created_at, server_received_at
- `evidences` — id, incident_id, storage_key, mime, tamano_bytes, sha256, subido (0/1)
- `validations` — id, consumption_id, decision (`aprobado|rechazado`), motivo (obligatorio si rechaza, `CHECK`), validado_por, client_created_at, server_received_at
- `sync_mutations` — mutation_id (PK), user_id, device_id, tipo, resultado (`aplicada|rechazada|conflicto`), respuesta_json, procesada_at → **garantiza idempotencia**
- `audit_log` — **seq INTEGER PRIMARY KEY AUTOINCREMENT**, id (UUID), entidad, entidad_id, accion, actor_id, device_id, datos_antes (TEXT JSON), datos_despues (TEXT JSON), client_at, server_at, alerta_reloj (0/1)

### Reglas de integridad
- Triggers en `audit_log`: `BEFORE UPDATE` y `BEFORE DELETE` → `SELECT RAISE(ABORT, 'audit_log es inmutable')`.
- Triggers equivalentes que impiden `DELETE` en `consumptions`, `incidents`, `validations`, `evidences` y `production_orders`. Nada se borra; se usan estados.
- Trigger que impide cambiar `cantidad`/`material_id` de un consumo cuyo estado ya no es `pendiente`.
- Toda escritura de negocio inserta su fila de `audit_log` en el mismo `db.batch()`.
- Índices: `consumptions(order_id, estado)`, `consumptions(registrado_por, created_at)`, `validations(consumption_id)`, `audit_log(entidad, entidad_id)`, `order_supervisors(user_id)`.
- `audit_log.seq` es el **cursor de sincronización** (`/sync/pull`).

### Backups
- **Time Travel** de D1 (restauración a un punto en el tiempo, 30 días en Workers Paid) es la primera línea.
- Además, **Cron Trigger diario** que exporta las tablas a JSON comprimido en R2 (`backups/AAAA-MM-DD/`), con retención de 90 días. Documentar en `docs/despliegue.md` cómo restaurar.

---

## 6. Protocolo de sincronización offline (parte crítica)

**Principio:** el dispositivo nunca espera al servidor para registrar. Todo se escribe primero en IndexedDB.

### Cliente
1. Cada acción genera una **mutación** en la tabla local `outbox`:
   `{ mutation_id (UUID), tipo, entidad_id, payload, client_created_at, intentos, estado: pendiente|enviando|aplicada|rechazada|conflicto, error }`
2. La UI lee de las tablas locales (optimista) y muestra el estado de cada registro: pendiente de sync / sincronizado / aprobado / rechazado por el servidor.
3. Disparadores del motor de sync: evento `online`, apertura de la app, cada 60 s si hay pendientes, botón "Sincronizar ahora", y Background Sync donde exista (en iOS no existe: los demás disparadores lo cubren).
4. Envía la cola **en orden** en lotes de máx. 25 mutaciones a `POST /api/v1/sync/push`. Reintentos con backoff exponencial (máx. 5 min).
5. Evidencias aparte: `PUT /api/v1/evidences/:id` con el archivo comprimido (el Worker lo escribe en R2 y guarda el sha256). Nunca bloquear el registro del consumo por la foto. Reintentar en segundo plano.
6. Después del push: `GET /api/v1/sync/pull?cursor=<ultimo_seq>` para traer validaciones del jefe, órdenes nuevas y catálogos.
7. `navigator.storage.persist()` al iniciar; si no se concede (frecuente en Safari), mostrar aviso de que hay que sincronizar a diario.
8. Indicador global: "En línea" / "Sin conexión · N por sincronizar".

### Worker
1. `POST /sync/push` es **idempotente** por `mutation_id` usando `sync_mutations`: si ya existe, devuelve la respuesta guardada sin reaplicar.
2. Cada mutación se procesa en su propio `db.batch()`: cambio de negocio + `audit_log` + fila en `sync_mutations`. Revalida permisos y reglas; guarda `server_received_at`.
3. Respuesta por mutación: `aplicada` | `rechazada` (código y mensaje en español) | `conflicto` (incluye la versión del servidor).
4. `GET /sync/pull` devuelve los cambios con `seq > cursor` visibles para ese usuario, paginados (máx. 200), y el nuevo cursor.

### Reglas de conflicto
- Validaciones del jefe: **el servidor manda**. Si el supervisor editó offline un consumo ya validado, la edición se rechaza y la UI ofrece crear un consumo corregido.
- Edición de consumo pendiente: control por `version`. Si no coincide → `conflicto` y se muestra la versión del servidor.
- Registro en orden ya finalizada o cancelada: se acepta con `registro_tardio = 1` y queda pendiente de validación del jefe (no se pierden datos de planta).
- Se guardan la hora del dispositivo y la del servidor. Si difieren más de 10 min → `alerta_reloj = 1` en la auditoría.

---

## 7. API (Hono, JSON, prefijo `/api/v1`)

**Auth**
- `POST /auth/login` → access token (15 min) + refresh token (30 días) en cookie `HttpOnly; Secure; SameSite=Strict`
- `POST /auth/refresh` (rotación: el refresh usado se revoca) · `POST /auth/logout` · `GET /auth/me` (incluye permisos)
- Rate limit de login con el binding de Rate Limiting de Workers (o regla WAF): máx. 5 intentos/min por IP + email.

**Catálogos y órdenes**
- `GET /materials` · `POST /materials` · `PATCH /materials/:id` (admin)
- `GET /orders?estado=&cursor=` · `GET /orders/:id` (con materiales planeados y consumo vs plan)
- `POST /orders` · `POST /orders/:id/start` · `POST /orders/:id/finish` (jefe). Finalizar exige que no queden consumos pendientes, o confirmación explícita (`force: true`) que queda en auditoría.

**Consumos y novedades** (también llegan vía `/sync/push`)
- `GET /orders/:id/consumptions`
- `POST /consumptions` · `PATCH /consumptions/:id`
- `POST /consumptions/:id/incident`
- `PUT /evidences/:id` (sube a R2; solo `image/jpeg|png|webp`, máx. 5 MB)
- `GET /evidences/:id` (el Worker verifica permisos y hace streaming desde R2; el bucket **nunca** es público)

**Validación**
- `GET /validations/queue?orden=&supervisor=&con_novedad=`
- `POST /consumptions/:id/approve` · `POST /consumptions/:id/reject` (motivo obligatorio)

**Sync y auditoría**
- `POST /sync/push` · `GET /sync/pull`
- `GET /audit?entidad=&entidad_id=&desde=&hasta=&cursor=` · `GET /orders/:id/audit`

**Reportes**
- `GET /reports/orders/:id/summary` — real vs planeado, costo total COP, novedades
- `GET /reports/orders/:id/export.csv`

Errores con formato único `{ code, message, details }`, mensajes en español. Códigos definidos en `packages/shared`.

---

## 8. Pantallas (frontend)

Referencia visual: archivo de Figma **"Control de Materia Prima - Mockup"** (pantallas *Supervisor · Registro de Consumo* y *Jefe · Validación de Consumos*). Respeta su estructura, jerarquía y estilo.

**Comunes**
- Login (funciona offline si el usuario ya inició sesión antes en ese dispositivo)
- Barra superior: orden activa, indicador de conexión/sync, usuario
- "Estado de sincronización": pendientes, rechazados con motivo, botón "Sincronizar ahora"

**Supervisor**
1. Mis órdenes en proceso
2. Detalle de orden: planeado vs consumido por material (barra de progreso)
3. Registrar consumo: material (buscador), cantidad (teclado numérico), unidad, lote; toggle de novedad con tipo, descripción y foto (cámara). Si supera plan + tolerancia, la novedad es obligatoria.
4. Registros del día con estado
5. Consumo rechazado → motivo → "Crear corrección"

**Jefe**
1. Cola de validación con filtros
2. Detalle de consumo: novedad, evidencia ampliable, Validar / Rechazar (motivo obligatorio)
3. Gestión de órdenes: crear, iniciar, finalizar
4. Resumen de orden: real vs planeado, costo total, novedades abiertas
5. Línea de tiempo de trazabilidad por orden

**Admin**
- Usuarios (crear, desactivar, rol), materiales, asignación de supervisores a órdenes

UX en planta: alto contraste, tipografía legible a distancia, confirmación antes de acciones irreversibles, sin depender de hover.

---

## 9. Seguridad

- Secretos solo como secrets de Wrangler; `.dev.vars` fuera de git.
- Cabeceras de seguridad desde el Worker: CSP estricta, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (cámara solo en el propio origen).
- Bucket R2 privado; acceso a evidencias solo a través del Worker con verificación de permisos.
- Validación Zod en **todas** las entradas; consultas siempre parametrizadas (Drizzle o `prepare().bind()`), nunca concatenación de SQL.
- Al cerrar sesión: borrar IndexedDB **solo si no hay pendientes**; si los hay, advertir.
- Opcional (documentar en Fase 6): proteger las rutas de admin con **Cloudflare Access**.
- Considerar la Ley 1581 de 2012 (datos personales): guardar solo los datos necesarios.
- `security-reviewer` revisa al final de las Fases 2, 4 y 6.

---

## 10. Fases (una por ventana de uso)

**Fase 0 — Fundaciones**
Monorepo pnpm, `packages/shared` (tipos, Zod, roles, estados, códigos de error), `wrangler.jsonc` con entornos local/staging/production y bindings (`DB`, `EVIDENCE`, `CONFIG`, `ASSETS`), lint/test/CI, `.dev.vars.example`, README de arranque.
✔ `pnpm install && pnpm typecheck && pnpm test` pasan; `pnpm dev` levanta el Worker local con D1 y R2 locales.

**Fase 1 — Base de datos y auth**
Esquema Drizzle + migraciones SQL en `/migrations`, triggers de inmutabilidad, seed local (1 admin, 1 jefe, 2 supervisores, 10 materiales, 2 órdenes), login/refresh/logout/me, middleware de permisos.
✔ Pruebas (vitest-pool-workers): UPDATE/DELETE en `audit_log` falla; foreign keys activas; login y rotación de refresh funcionan; cada regla de la sección 4 probada.

**Fase 2 — API de negocio**
Órdenes, consumos, novedades, evidencias en R2, validaciones, auditoría, reportes. Toda escritura con `db.batch()` + auditoría.
✔ Pruebas de integración por endpoint y por permiso; prueba de que un fallo a mitad del batch no deja datos parciales. Revisión de seguridad.

**Fase 3 — Sincronización**
`/sync/push` idempotente con `sync_mutations`, `/sync/pull` por `seq`; en el cliente: Dexie, outbox, motor de sync, subida de evidencias en segundo plano.
✔ Pruebas: mutación repetida no duplica; conflicto de versión; edición de consumo ya validado se rechaza; registro tardío en orden finalizada; lote de 25 mutaciones respeta el límite de parámetros de D1.

**Fase 4 — PWA supervisor**
Shell PWA instalable servida por el Worker, login offline, pantallas del supervisor, indicador de sync.
✔ E2E Playwright: con la red cortada se registran 3 consumos (uno con foto), se reconecta y los 3 quedan en D1 y la foto en R2. Revisión de seguridad.

**Fase 5 — PWA jefe y admin**
Cola de validación, aprobar/rechazar, órdenes, resumen, línea de tiempo, administración.
✔ E2E: supervisor registra → jefe rechaza → supervisor ve el motivo y corrige → jefe aprueba; todo visible en la auditoría.

**Fase 6 — Endurecimiento y despliegue**
Errores, estados vacíos, accesibilidad, rendimiento en tablet, Cron de backup a R2, cabeceras de seguridad, `docs/despliegue.md` con los comandos exactos para crear D1/R2/KV de staging y producción, aplicar migraciones remotas, cargar secretos, desplegar y restaurar backups. Workflow de GitHub Actions para desplegar a staging.
✔ Lighthouse PWA ≥ 90; checklist de despliegue completo; revisión de seguridad final. **Los comandos remotos los ejecuto yo o los apruebo uno por uno.**

---

## 11. Definición de terminado (cada tarea)

- Compila sin errores de tipos y pasa lint.
- Tiene pruebas y pasan.
- Respeta los contratos de `packages/shared`.
- No introduce secretos en el código.
- Queda registrada en `docs/progreso.md`.

---

## 12. Empieza así

1. Lee este documento completo.
2. Crea `docs/preguntas-abiertas.md` con las ambigüedades que detectes (además de S1–S8).
3. Escribe `docs/plan-fase-0.md`, delega a los subagentes y ejecuta la **Fase 0**.
4. Al terminar, detente y entrégame el resumen.

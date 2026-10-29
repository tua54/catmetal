# Especificación — App de Control de Materia Prima · Catmetal S.A.S.

> Versión 2 (2026-10-29). Reemplaza al prompt original `PROMPT_ORQUESTADOR.md`. Incorpora las correcciones de la revisión de arquitectura, resumidas en la sección 13. La forma de trabajar está en `CLAUDE.md`; este documento define **qué** se construye.

---

## 1. Contexto del negocio

**Catmetal S.A.S.** es una empresa colombiana de fundición y mecanizado de hierros (nodular, gris) y aceros, con planta en La Mesa, Cundinamarca. Necesita registrar el **consumo de materias primas por orden de producción**, desde que la orden inicia hasta que finaliza.

- El **supervisor** usa una **tablet** en planta, muchas veces **sin conexión**. Registra material, cantidad, orden y lote. Si hay una **novedad** (desviación), la justifica con texto y foto.
- El **jefe** **aprueba** o **rechaza** cada consumo; el rechazo exige motivo.
- **Trazabilidad completa**: quién, qué, cuándo y desde qué dispositivo. Nada se borra.

### Supuestos de negocio (vigentes hasta que el cliente diga otra cosa)

- **S1.** Tablets Android (Chrome) **y** iPad (Safari). Debe funcionar en ambos.
- **S2.** Una orden puede tener **varios supervisores**.
- **S3.** Un consumo **rechazado** no se edita: se crea un **consumo corregido** que referencia al rechazado (`corrige_a`).
- **S4.** El autor puede editar su consumo solo **mientras está pendiente**, y cada edición queda en auditoría.
- **S5.** El jefe trabaja normalmente con conexión, pero su app tolera cortes.
- **S6.** Moneda COP, zona horaria America/Bogota, interfaz en español (Colombia).
- **S7.** La novedad es **obligatoria** si la cantidad consumida acumulada de un material en la orden supera la planeada más la tolerancia. La tolerancia por defecto es 5% y es configurable.
- **S8.** Una sola planta y una sola base de datos D1.
- **S9.** Nadie aprueba un consumo que él mismo registró. Si el único jefe registró el consumo, queda pendiente hasta que lo valide otro jefe. Esto se registra en `preguntas-abiertas.md` para que el cliente lo confirme.
- **S10.** Un consumo **aprobado** no se corrige en la v1. Las correcciones posteriores a la aprobación quedan como pregunta abierta.
- **S11.** Unidades: una cantidad solo se compara con el plan si está en una unidad de la misma magnitud. Conversiones permitidas: `kg↔g` y `l↔ml`. `und` y `m` no tienen conversión. Si la unidad no es convertible a la del plan, el consumo se rechaza con el código `UNIDAD_INCOMPATIBLE`.
- **S12.** El costo de cada consumo se congela al registrarlo, copiando el costo unitario vigente del material. Así, los reportes históricos no cambian cuando cambia el precio.

---

## 2. Arquitectura en Cloudflare

```
Tablet (PWA offline-first, IndexedDB)
        │  HTTPS, mismo dominio
        ▼
Cloudflare Worker ───────────────────────────┐
  • sirve la PWA (Workers Static Assets)     │
  • API /api/v1/* (Hono)                     │
        │              │              │      │
        ▼              ▼              ▼      ▼
   D1 (SQLite)    R2 (evidencias   KV (caché    Rate Limiting
   fuente de      y backups,       opcional,    binding
   verdad)        privado)         no crítico)
        │
   Cron Trigger diario → backup paginado de D1 a R2
```

- **Un solo Worker** sirve la PWA (Static Assets) y la API bajo `/api/v1`. Al ser el mismo origen no hay CORS.
  - Configura `assets.not_found_handling = "single-page-application"`.
  - Configura `assets.run_worker_first` para que `/api/*` siempre llegue al Worker.
- **D1** es la única fuente de verdad: negocio, sesiones, revocación de tokens, intentos de login y configuración (incluida la tolerancia).
- **R2** guarda las evidencias (fotos) y los backups. El bucket nunca es público.
- **KV** se usa solo como caché opcional de datos no críticos. **Nada de seguridad ni de negocio vive solo en KV**: KV es eventualmente consistente y un cambio puede tardar 60 s o más en propagarse a otras ubicaciones.
- **Cron Trigger** diario a las `0 8 * * *` UTC (03:00 en Bogotá, fuera de turno): backup y mantenimiento.
- Plan requerido: **Workers Paid**. Da acceso a D1 de hasta 10 GB, Time Travel de 30 días y más CPU por invocación. Anótalo en `docs/despliegue.md`.

### Monorepo (pnpm workspaces)

```
/apps/web        → PWA (React + Vite)
/apps/worker     → Worker: API + sirve el build de apps/web
/packages/shared → tipos TS, esquemas Zod, roles, estados, códigos de error, conversión de unidades
/migrations      → migraciones SQL de D1 (wrangler d1 migrations)
/docs            → spec, diseño, planes, ADR, progreso, evidencia, auditoría, despliegue
```

### Stack

**Frontend (`apps/web`)**

- React (versión estable actual) + TypeScript + Vite. Evalúa `@cloudflare/vite-plugin` para tener un solo proceso de desarrollo con el Worker y registra la decisión en un ADR.
- `vite-plugin-pwa` (Workbox) para el Service Worker y la instalación. El Service Worker **nunca** cachea respuestas de `/api/*`.
- Dexie.js sobre IndexedDB.
- TanStack Query para datos del servidor y Zustand para el estado de UI.
- React Hook Form + Zod, con los esquemas de `packages/shared`.
- Tailwind CSS con los tokens de `docs/diseno/README.md`. Optimizado para tablet horizontal (1180×820) y vertical. Objetivos táctiles de 44 px o más.
- `browser-image-compression` antes de guardar las fotos.

**Backend (`apps/worker`)**

- Cloudflare Workers + **Hono** + TypeScript, con `wrangler.jsonc`.
- **Drizzle ORM** con el driver `drizzle-orm/d1`.
  - Las migraciones se generan con drizzle-kit, se revisan y se aplican con `wrangler d1 migrations apply` (en local).
  - Si drizzle-kit genera subdirectorios, configura `migrations_dir` y `migrations_pattern` en `wrangler.jsonc`.
- Bindings: `DB` (D1), `EVIDENCE` (R2), `CONFIG` (KV), `ASSETS` (static assets), `LOGIN_LIMITER` (Rate Limiting).
- Validación de todas las entradas con Zod (`@hono/zod-validator`).
- JWT con `jose` (WebCrypto).
- **Contraseñas: PBKDF2-SHA256 vía WebCrypto con exactamente 100.000 iteraciones y sal aleatoria de 16 bytes por usuario.**
  - El runtime de Workers **rechaza más de 100.000 iteraciones**. `wrangler dev` y Miniflare **no** aplican ese tope, así que las pruebas locales pasarían con más iteraciones y el login fallaría en producción.
  - Guarda el hash autodescriptivo, por ejemplo `pbkdf2-sha256$100000$<sal_b64>$<hash_b64>`, para poder migrar el algoritmo en el futuro.
  - Agrega una prueba que verifique que el número de iteraciones configurado es ≤ 100.000.
  - La comparación del hash es de tiempo constante.
- No uses librerías que requieran APIs de Node no disponibles en Workers.
- Logs estructurados (`console.log(JSON.stringify(...))`) sin datos personales ni secretos. Workers Logs habilitado.

**Calidad**

- ESLint + Prettier, `tsc --noEmit`.
- Vitest con `@cloudflare/vitest-pool-workers` para el Worker, con D1 y R2 reales en local.
- Vitest + Testing Library para el frontend.
- Playwright para E2E, incluido el modo offline. El proyecto Chromium cubre la suite completa. El proyecto WebKit corre una suite de humo (login y registro con conexión) y documenta sus limitaciones offline.
- GitHub Actions:
  - `ci.yml`: lint, typecheck, test y e2e en `push` y `pull_request`.
  - `deploy-staging.yml`: **solo `workflow_dispatch`** con un `environment` protegido. Nunca se dispara automáticamente con un push.

### Entornos (`wrangler.jsonc`)

- **Nivel superior (desarrollo local)**: `wrangler dev`, con D1, R2 y KV locales.
- **`env.staging`**: D1 `mp-staging`, R2 `mp-evidencias-staging`, KV y rate limiter propios.
- **`env.production`**: D1 `mp-prod`, R2 `mp-evidencias-prod`, KV y rate limiter propios.
- Los bindings **no se heredan** entre entornos: repítelos en cada uno. Los IDs remotos se dejan como marcadores de posición documentados en `docs/despliegue.md`.
- Secretos: `JWT_SECRET` y `REFRESH_SECRET`, cargados con `wrangler secret put` por entorno (lo hace una persona). En local van en `.dev.vars`, que está ignorado en git, y `.dev.vars.example` lleva solo los nombres.

---

## 3. Roles y permisos

| Acción | Supervisor | Jefe | Admin |
|---|---|---|---|
| Ver órdenes | Solo asignadas | Todas | Todas |
| Crear / iniciar / finalizar orden | ❌ | ✅ | ✅ |
| Registrar consumo | ✅ (órdenes asignadas en proceso) | ✅ | ❌ |
| Editar consumo propio pendiente | ✅ | ❌ | ❌ |
| Registrar novedad + evidencia | ✅ | ✅ | ❌ |
| Aprobar / rechazar consumo | ❌ | ✅ (nunca uno propio) | ❌ |
| Ver auditoría | Solo lo propio | ✅ | ✅ |
| Gestionar usuarios, materiales, asignaciones y tolerancia | ❌ | ❌ | ✅ |

Reglas:

- Los permisos se validan **siempre en el Worker** (middleware de Hono). El cliente solo oculta botones.
- Los permisos se cachean en el dispositivo para trabajar offline. El Worker los revalida en cada sincronización. Una operación offline no autorizada se rechaza y se muestra al usuario con su motivo.
- Cada regla de esta tabla tiene al menos una prueba de integración positiva y una negativa.

---

## 4. Base de datos D1 (SQLite)

### Diferencias con PostgreSQL que hay que respetar

- **No hay transacciones interactivas.** La atomicidad se logra con **`db.batch([...])`**: todas las sentencias del lote se aplican juntas o ninguna. Toda escritura de negocio va en **el mismo `batch`** que su registro de auditoría.
- **IDs**: `TEXT` con UUID v7.
  - Para entidades creadas offline los genera el **cliente**. El servidor valida el formato y trata una colisión de clave primaria como `conflicto`, nunca como sobrescritura.
  - En el Worker se generan también como v7.
- **No hay `JSONB`**: usa `TEXT` con `CHECK (json_valid(col))`.
- **Fechas**: `TEXT` ISO-8601 en UTC (`2026-10-29T20:55:00.000Z`). Se muestran en America/Bogota. "Registros del día" significa el día calendario de Bogotá.
- **Booleanos**: `INTEGER` 0/1 con `CHECK (col IN (0,1))`.
- **Foreign keys**: D1 las aplica siempre. Prueba que una FK inválida falla. Si una migración necesita reordenar, usa `PRAGMA defer_foreign_keys = on` dentro de ella.
- **Inmutabilidad**: no hay roles ni `GRANT`, así que se garantiza con **triggers**.
- **Rendimiento**: cada D1 procesa una consulta a la vez. Todas las consultas de rutas frecuentes usan índices, y la paginación es por cursor, nunca con `OFFSET` grande.
- **Límites de D1**:
  - Máximo 100 parámetros enlazados **por sentencia**. Los límites aplican a cada sentencia dentro de un `batch`.
  - En Workers Paid, máximo 1000 consultas por invocación.
  - El tamaño máximo de la base es 10 GB: las fotos **nunca** van en D1, solo su `storage_key` de R2.

### Tablas

Todas incluyen `created_at` y `updated_at` (TEXT, UTC).

- `users` — id, nombre, email (único, normalizado en minúsculas), password_hash (formato autodescriptivo), rol (`supervisor|jefe|admin`), activo, intentos_fallidos (INTEGER), bloqueado_hasta (TEXT nullable)
- `devices` — id, user_id, nombre, user_agent, ultimo_sync_at
- `refresh_tokens` — id, user_id, device_id, token_hash (SHA-256 del token, nunca el token), familia_id, expira_at, revocado_at, reemplazado_por
- `settings` — clave (PK), valor (TEXT JSON), actualizado_por. Contiene `tolerancia_pct`. Los cambios se auditan.
- `materials` — id, codigo (único), nombre, unidad (`kg|g|l|ml|und|m`), costo_unitario_cop (INTEGER, pesos), activo
- `production_orders` — id, codigo (ej. `OP-2026-0587`, único), linea, estado (`planeada|en_proceso|finalizada|cancelada`), fecha_inicio, fecha_fin, creada_por
- `order_supervisors` — order_id, user_id (PK compuesta), asignado_por, activo
- `order_planned_materials` — order_id, material_id, cantidad_planeada (REAL), unidad
- `consumptions` — id, order_id, material_id, cantidad (REAL, > 0), unidad, cantidad_en_unidad_plan (REAL), lote, costo_unitario_cop_snapshot (INTEGER), registrado_por, device_id, client_created_at, server_received_at, estado (`pendiente|aprobado|rechazado`), corrige_a (FK opcional), registro_tardio (0/1), requiere_novedad (0/1), version (INTEGER)
- `incidents` (novedades) — id, consumption_id, tipo (`reproceso|merma|dano|error_registro|otro`), descripcion, registrado_por, client_created_at, server_received_at
- `evidences` — id, incident_id, storage_key, mime, tamano_bytes, sha256, subido (0/1), subido_at
- `validations` — id, consumption_id, decision (`aprobado|rechazado`), motivo (obligatorio si rechaza, con `CHECK`), validado_por, client_created_at, server_received_at
- `sync_mutations` — mutation_id (PK), user_id, device_id, tipo, resultado (`aplicada|rechazada|conflicto`), respuesta_json, procesada_at → **garantiza la idempotencia**
- `audit_log` — **seq INTEGER PRIMARY KEY AUTOINCREMENT**, id (UUID), entidad, entidad_id, accion, actor_id, device_id, datos_antes (TEXT JSON), datos_despues (TEXT JSON), client_at, server_at, alerta_reloj (0/1)

### Reglas de integridad

- **Triggers de inmutabilidad**:
  - En `audit_log`, `BEFORE UPDATE` y `BEFORE DELETE` ejecutan `SELECT RAISE(ABORT, 'audit_log es inmutable')`.
  - Triggers equivalentes impiden `DELETE` en `consumptions`, `incidents`, `validations`, `evidences`, `production_orders` y `users`. Nada se borra; se usan estados.
  - Otro trigger impide cambiar `cantidad`, `unidad` o `material_id` de un consumo cuyo estado ya no es `pendiente`.
- **Los triggers viven en una migración SQL propia**, escrita a mano, no generada por drizzle-kit. Drizzle **no gestiona triggers**: cuando reconstruye una tabla (crear, copiar, borrar), los triggers de esa tabla desaparecen sin aviso. Por eso:
  - Hay una prueba que, después de aplicar **todas** las migraciones, consulta `sqlite_master` y falla si falta cualquier trigger esperado.
  - Toda migración que reconstruya una tabla con triggers debe recrearlos en la misma migración.
- **Auditoría en el mismo batch**: toda escritura de negocio inserta su fila de `audit_log` en el mismo `db.batch()`.
- **La auditoría nunca guarda secretos.** En `datos_antes` y `datos_despues` se excluyen `password_hash`, `token_hash` y cualquier secreto. Una prueba lo verifica.
- **Índices**:
  - `consumptions(order_id, estado)`, `consumptions(registrado_por, created_at)`, `consumptions(corrige_a)`
  - `validations(consumption_id)`
  - `audit_log(entidad, entidad_id)`, `audit_log(actor_id, seq)`
  - `order_supervisors(user_id)`
  - `refresh_tokens(user_id)`, `refresh_tokens(token_hash)`
  - `incidents(consumption_id)`, `evidences(incident_id)`
- `audit_log.seq` es el **cursor de sincronización** de `/sync/pull`. Es válido porque cada D1 aplica las escrituras en serie, así que `seq` sigue el orden de commit. Documenta este razonamiento en un ADR y la advertencia de que no es portable a una base con escrituras concurrentes.

### Seed local

Un script de Node (no de bash) crea 1 admin, 1 jefe, 2 supervisores, 10 materiales (nombres propios de fundición, como arena sílice, resina furánica, ferrosilicio, chatarra de acero, carbón coque) y 2 órdenes.

- Las contraseñas del seed salen de `SEED_PASSWORD` en `.dev.vars`; nunca se escriben en el código.
- El seed **solo** corre contra la base local.

### Backups

- **Time Travel** de D1 (restauración a un punto en el tiempo, 30 días en Workers Paid) es la primera línea.
- **Cron diario** que exporta cada tabla a NDJSON comprimido en R2 (`backups/AAAA-MM-DD/<tabla>.ndjson.gz`):
  - **Paginando por clave primaria en lotes**, para respetar los límites de CPU y memoria. No se usa la exportación nativa de D1, porque bloquea las demás consultas mientras corre.
  - Incluye un `manifest.json` con conteos y sha256 de cada archivo.
- La retención de 90 días se aplica con una **regla de ciclo de vida de R2** sobre el prefijo `backups/`, no borrando con código. El comando para crear la regla va en `docs/despliegue.md`.
- `docs/despliegue.md` explica cómo restaurar, tanto con Time Travel como desde el backup en R2.

---

## 5. Autenticación y sesiones

- **Access token**: JWT de 15 min, guardado **solo en memoria** en el cliente y enviado en el header `Authorization`.
- **Refresh token**: 30 días, en una cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. En D1 se guarda solo su hash.
- **Rotación**: cada refresh revoca el token usado y emite uno nuevo de la misma familia. Si se reutiliza un token ya rotado, se trata como robo: **se revoca toda la familia** y se audita.
- **CSRF**: además de `SameSite=Strict`, toda petición que cambie estado verifica que el header `Origin` sea el propio origen.
- **Protección de fuerza bruta en dos capas**:
  1. **Primer filtro**: el binding de Rate Limiting de Workers, con clave IP + email normalizado, límite 5 y periodo 60 s. Es aproximado y se aplica por ubicación de Cloudflare.
  2. **Garantía**: un contador en D1 (`users.intentos_fallidos`). Tras 5 intentos fallidos consecutivos, la cuenta se bloquea 15 min (`bloqueado_hasta`) y se audita. El mensaje de error no revela si el email existe.
- **Login offline**: solo para usuarios que ya iniciaron sesión con conexión en ese dispositivo.
  - Al hacer login con conexión, el cliente deriva con PBKDF2 en el navegador un **verificador local**: sal propia del dispositivo, distinta de la del servidor. Las iteraciones las fijas en un ADR según el rendimiento medido en tablet.
  - El verificador se guarda en IndexedDB junto con el perfil y los permisos cacheados.
  - El verificador local **nunca** se envía al servidor ni reemplaza la autenticación del servidor. Al recuperar conexión, la sincronización requiere una sesión válida del servidor; si no la hay, se pide la contraseña de nuevo.
- **Tablet compartida**:
  - Tanto el outbox como los datos locales se particionan por `user_id`.
  - Una mutación solo se envía con la sesión de **su autor**.
  - Si el usuario A cierra sesión con pendientes, sus datos se conservan pero no se envían hasta que A vuelva a iniciar sesión. Al entrar B, ve el aviso: "Hay N registros pendientes de <A>".
  - Cerrar sesión borra los datos locales del usuario **solo si no tiene pendientes**; si los tiene, se le advierte.

---

## 6. Protocolo de sincronización offline (parte crítica)

**Principio:** el dispositivo nunca espera al servidor para registrar. Todo se escribe primero en IndexedDB.

### Cliente

1. **Outbox**: cada acción genera una mutación en la tabla local `outbox`:
   `{ mutation_id (UUIDv7), user_id, tipo, entidad_id, payload, client_created_at, intentos, estado: pendiente|enviando|aplicada|rechazada|conflicto, error, siguiente_intento_at }`
2. **UI optimista**: la interfaz lee de las tablas locales y muestra el estado de cada registro: pendiente de sync, sincronizado, aprobado o rechazado (con motivo).
3. **Disparadores del motor de sync**: evento `online`, apertura de la app, cada 60 s si hay pendientes, botón "Sincronizar ahora", y Background Sync donde exista. iOS no tiene Background Sync; los demás disparadores lo cubren.
4. **Envío**: la cola sale **en orden** y en lotes de máximo 25 mutaciones a `POST /api/v1/sync/push`. Reintentos con backoff exponencial y jitter, con un máximo de 5 min entre intentos.
   - Se usa un candado entre pestañas (Web Locks API, con alternativa) para que nunca haya dos envíos simultáneos.
   - Una mutación `rechazada` o en `conflicto` no bloquea a las siguientes, salvo que dependan de ella. Ejemplo: una novedad de un consumo rechazado queda también rechazada con el código `DEPENDENCIA_RECHAZADA`.
5. **Evidencias**: van aparte, con `PUT /api/v1/evidences/:id` y el archivo comprimido. El Worker valida el tipo por **magic bytes** (no solo por el header), calcula el sha256 y lo escribe en R2.
   - La foto se sube solo **después** de que la mutación de la novedad quedó `aplicada`. Si el servidor no conoce la evidencia, responde `EVIDENCIA_DESCONOCIDA` y el cliente reintenta después.
   - El registro del consumo nunca espera a la foto. La subida se reintenta en segundo plano.
6. **Pull**: después del push, `GET /api/v1/sync/pull?cursor=<ultimo_seq>` trae validaciones del jefe, órdenes, asignaciones y catálogos.
7. **Almacenamiento**: al iniciar se llama a `navigator.storage.persist()`. Si no se concede (frecuente en Safari), se muestra un aviso permanente: "Sincroniza al menos una vez al día".
8. **Indicador global**: "En línea · Todo sincronizado" / "Sin conexión · N por sincronizar" / "Sincronizando…".

### Worker

1. **`POST /sync/push` es idempotente por `mutation_id`**:
   - Primero consulta `sync_mutations`. Si la mutación ya existe, devuelve la respuesta guardada sin reaplicar.
   - La **garantía real** la da la base, no esa consulta: el `INSERT` en `sync_mutations` va **dentro del mismo `db.batch()`** que el cambio de negocio y la auditoría.
   - Si un reintento concurrente provoca un conflicto de PK en `sync_mutations`, todo el batch falla sin efectos, se relee la respuesta guardada y se devuelve esa.
2. **Una mutación, un batch**: cada mutación se procesa en su propio `db.batch()`: cambio de negocio + `audit_log` + `sync_mutations`. Revalida permisos y reglas, y guarda `server_received_at`. Un lote de 25 mutaciones no debe superar las 1000 consultas por invocación ni los 100 parámetros por sentencia; hay una prueba de esto.
3. **Respuesta por mutación**:
   - `aplicada`.
   - `rechazada`, con código y mensaje en español.
   - `conflicto`, con la versión del servidor.
4. **`GET /sync/pull`** recorre `audit_log` con `seq > cursor`, filtra lo visible para el usuario y devuelve máximo 200 cambios.
   - **El nuevo cursor es el último `seq` revisado, no el último devuelto.** Si no, un usuario sin cambios visibles pediría lo mismo una y otra vez.
   - Cada consulta revisa como máximo un número acotado de filas (por ejemplo 1000) y responde con `hay_mas`.
   - Cuando a un supervisor se le quita una orden, el pull le envía un evento de **revocación de visibilidad** y el cliente borra esos datos locales, salvo los suyos pendientes.

### Reglas de conflicto

- **Validaciones del jefe**: el servidor manda. Si el supervisor editó offline un consumo que ya fue validado, la edición se rechaza y la UI le ofrece crear un consumo corregido.
- **Edición de un consumo pendiente**: se controla con `version`. Si la versión no coincide, la respuesta es `conflicto` y se muestra la versión del servidor.
- **Registro en una orden ya finalizada o cancelada**: se acepta con `registro_tardio = 1` y queda pendiente de validación del jefe. No se pierden datos de planta.
- **Tolerancia (S7)**: la autoridad es el servidor, porque el cliente offline no ve lo que registraron otros supervisores.
  - Si el servidor calcula que se superó la tolerancia y el consumo no trae novedad, **lo acepta** con `requiere_novedad = 1`, para no perder el dato.
  - El supervisor ve el aviso "Falta justificar la novedad".
  - El jefe **no puede aprobar** el consumo hasta que tenga una novedad.
- **Reloj**: se guardan la hora del dispositivo y la del servidor. Si difieren en más de 10 min, se marca `alerta_reloj = 1` en la auditoría.

---

## 7. API (Hono, JSON, prefijo `/api/v1`)

**Auth**

- `POST /auth/login`
- `POST /auth/refresh` (con rotación)
- `POST /auth/logout`
- `GET /auth/me` (incluye los permisos)

**Catálogos, configuración y órdenes**

- `GET /materials` · `POST /materials` · `PATCH /materials/:id` (admin)
- `GET /settings` · `PATCH /settings/tolerancia` (admin, auditado)
- `GET /users` · `POST /users` · `PATCH /users/:id` (admin; desactivar, nunca borrar)
- `GET /orders?estado=&cursor=` · `GET /orders/:id` (con materiales planeados y consumo vs plan)
- `POST /orders` · `POST /orders/:id/start` · `POST /orders/:id/finish` (jefe/admin)
  - Finalizar exige que no queden consumos pendientes, o una confirmación explícita (`force: true`) que queda en auditoría.
- `PUT /orders/:id/supervisors` (admin)

**Consumos y novedades** (también llegan vía `/sync/push`)

- `GET /orders/:id/consumptions`
- `POST /consumptions` · `PATCH /consumptions/:id`
- `POST /consumptions/:id/incident`
- `PUT /evidences/:id`
  - Solo `image/jpeg`, `image/png` y `image/webp`, verificados por magic bytes. Máximo 5 MB.
  - Clave en R2: `evidencias/<order_id>/<evidence_id>`.
- `GET /evidences/:id`: el Worker verifica permisos y hace streaming desde R2 con `Content-Type` fijo, `X-Content-Type-Options: nosniff` y `Content-Disposition: inline`.

**Validación**

- `GET /validations/queue?orden=&supervisor=&con_novedad=&cursor=`
- `POST /consumptions/:id/approve` · `POST /consumptions/:id/reject` (motivo obligatorio)

**Sync y auditoría**

- `POST /sync/push` · `GET /sync/pull`
- `GET /audit?entidad=&entidad_id=&desde=&hasta=&cursor=` · `GET /orders/:id/audit`

**Reportes**

- `GET /reports/orders/:id/summary`: real vs planeado, costo total en COP (con los costos congelados) y novedades.
- `GET /reports/orders/:id/export.csv`: exporta en UTF-8 con BOM, separador `;` (Excel en español) y neutraliza la inyección de fórmulas (celdas que empiezan con `=`, `+`, `-` o `@`).

**Errores**: formato único `{ code, message, details }`, con mensajes en español. Los códigos se definen en `packages/shared`.

**Cabeceras de seguridad**: el Worker las aplica a todas las respuestas, tanto de la PWA como de la API.

---

## 8. Pantallas (frontend)

**Diseño**: sigue `docs/diseno/README.md`. Allí está la estructura del Figma ("Control de Materia Prima - Mockup") y la identidad visual de Catmetal (colores, tipografía, logo).

**Comunes**

- Login: funciona offline si el usuario ya inició sesión antes en ese dispositivo. Muestra el logo de Catmetal.
- Barra superior: marca, título de la pantalla, orden activa, indicador de conexión y sincronización, y usuario.
- "Estado de sincronización": pendientes, rechazados con motivo, conflictos y el botón "Sincronizar ahora".

**Supervisor** (Figma: "Supervisor · Registro de Consumo")

1. Mis órdenes en proceso.
2. Detalle de orden: planeado vs consumido por material, con barra de progreso.
3. Registrar consumo:
   - Material (con buscador), cantidad (teclado numérico), unidad y lote.
   - Toggle "¿Hay una novedad en este consumo?" con tipo, descripción y foto (cámara).
   - Si el consumo supera el plan más la tolerancia, la novedad es obligatoria.
   - Botón principal: "Guardar registro (se sincroniza al recuperar señal)".
4. Registros del día, con chip de estado: Pendiente de sync / Sincronizado / Validado por jefe / Rechazado / Falta novedad.
5. Trazabilidad de este dispositivo.
6. Consumo rechazado → ver motivo → "Crear corrección".

**Jefe** (Figma: "Jefe · Validación de Consumos")

1. Cola de validación por orden, con filtros, contador de pendientes y la etiqueta "Con novedad".
2. Detalle del consumo: justificación del supervisor, evidencia ampliable y los botones "Validar gasto" y "Rechazar". El motivo es obligatorio para rechazar.
3. Resumen de la orden: materiales consumidos, costo total reportado, novedades abiertas y estado.
4. Línea de tiempo de trazabilidad completa de la orden.
5. Gestión de órdenes: crear, iniciar y finalizar.

**Admin**

- Usuarios (crear, desactivar, cambiar rol), materiales, asignación de supervisores a órdenes y tolerancia.

**UX en planta**: alto contraste (WCAG AA como mínimo), tipografía legible a distancia, confirmación antes de acciones irreversibles y nada que dependa de hover. Debe usarse con guantes: objetivos grandes y bien separados.

---

## 9. Seguridad

- Secretos solo como secrets de Wrangler. `.dev.vars` fuera de git.
- **Cabeceras** desde el Worker:
  - CSP estricta: `default-src 'self'`, sin `unsafe-inline` en scripts, `img-src 'self' blob: data:`, `connect-src 'self'`, `frame-ancestors 'none'`.
  - `X-Content-Type-Options: nosniff`.
  - `Referrer-Policy: strict-origin-when-cross-origin`.
  - `Permissions-Policy` con la cámara solo en el propio origen.
  - HSTS.
- Bucket R2 privado. Las evidencias solo se acceden a través del Worker, con verificación de permisos.
- Validación Zod en **todas** las entradas. Consultas siempre parametrizadas (Drizzle o `prepare().bind()`), nunca concatenación de SQL.
- Ningún dato personal ni token en URLs ni en logs.
- Ley 1581 de 2012 (protección de datos personales): se guardan solo los datos necesarios. Documenta qué datos personales se guardan y para qué en `docs/despliegue.md`.
- Opcional (documentar en la Fase 6): proteger las rutas de admin con Cloudflare Access.
- La revisión de seguridad se hace al cierre de las Fases 2, 4 y 6.

---

## 10. Fases y criterios de aceptación

**Fase 0 — Fundaciones**

- Monorepo pnpm.
- `packages/shared`: tipos, Zod, roles, estados, códigos de error y conversión de unidades con pruebas.
- `wrangler.jsonc` con entornos y bindings (`DB`, `EVIDENCE`, `CONFIG`, `ASSETS`, `LOGIN_LIMITER`).
- ESLint, Prettier y Vitest.
- Workflow de CI.
- `.dev.vars.example` y un script de Node que genera `.dev.vars` con secretos aleatorios.
- README de arranque **para Windows**.
- ADR de versiones.

✔ `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pasan, y `pnpm dev` levanta el Worker local con D1, R2 y KV locales.

**Fase 1 — Base de datos y auth**

- Esquema Drizzle y migraciones en `/migrations`.
- Migración separada de triggers.
- Seed local.
- Login, refresh con rotación y detección de reutilización, logout y me.
- Bloqueo por intentos fallidos y middleware de permisos.

✔ Pruebas (vitest-pool-workers):
- UPDATE y DELETE en `audit_log` fallan, y DELETE falla en las tablas de negocio.
- Todos los triggers existen después de todas las migraciones.
- Las foreign keys están activas.
- Las iteraciones de PBKDF2 son ≤ 100.000.
- El login y la rotación funcionan.
- La reutilización de un refresh revoca su familia.
- El bloqueo se activa tras 5 intentos.
- Cada regla de la sección 3 está probada.
- La auditoría no contiene secretos.

**Fase 2 — API de negocio**

- Órdenes, consumos (con conversión de unidades y costo congelado), novedades, evidencias en R2, validaciones (sin autoaprobación y sin aprobar si `requiere_novedad`), auditoría, reportes y CSV.
- Toda escritura usa `db.batch()` con su auditoría.

✔ Pruebas de integración por endpoint y por permiso.
✔ Prueba de que un fallo a mitad del batch no deja datos parciales.
✔ Evidencias con un mime falso se rechazan.
✔ El CSV neutraliza fórmulas.
✔ Revisión de seguridad.

**Fase 3 — Sincronización**

- Servidor: `/sync/push` idempotente con `sync_mutations` dentro del batch, y `/sync/pull` por `seq` con cursor de revisión y revocación de visibilidad.
- Cliente: Dexie, outbox particionado por usuario, motor de sync con candado y subida de evidencias en segundo plano.

✔ Pruebas:
- Una mutación repetida, también en concurrencia, no duplica.
- Conflicto de versión.
- La edición de un consumo ya validado se rechaza.
- Registro tardío en una orden finalizada.
- Tolerancia superada sin novedad → `requiere_novedad = 1`.
- Un lote de 25 mutaciones no excede los límites de D1.
- El pull avanza el cursor aunque no haya cambios visibles.
- Revocación de visibilidad.

**Fase 4 — PWA supervisor**

- Shell PWA instalable servido por el Worker, login offline, pantallas del supervisor con la identidad de Catmetal e indicador de sync.

✔ E2E con Playwright (Chromium): con la red cortada se registran 3 consumos (uno con foto); al reconectar, los 3 quedan en D1 y la foto en R2.
✔ E2E de tablet compartida: los pendientes de A no se envían con la sesión de B.
✔ Humo en WebKit.
✔ Revisión de seguridad.

**Fase 5 — PWA jefe y admin**

- Cola de validación, aprobar y rechazar, órdenes, resumen, línea de tiempo y administración.

✔ E2E: el supervisor registra → el jefe rechaza → el supervisor ve el motivo y corrige → el jefe aprueba. Todo queda visible en la auditoría.
✔ El jefe no puede aprobar un consumo propio ni uno con `requiere_novedad`.

**Fase 6 — Endurecimiento y despliegue**

- Errores, estados vacíos, accesibilidad, rendimiento en tablet.
- Cron de backup a R2 y cabeceras de seguridad.
- `docs/despliegue.md` con los comandos exactos para:
  - crear D1, R2, KV y la regla de ciclo de vida de R2 de staging y producción;
  - aplicar migraciones remotas;
  - cargar secretos;
  - desplegar;
  - restaurar backups.
- Workflow `deploy-staging.yml` (solo manual).

✔ **Instalabilidad PWA verificada con una prueba automatizada**: manifest válido, Service Worker que controla la página y arranque offline de `start_url`. La categoría PWA ya no existe en Lighthouse, así que esto la reemplaza.
✔ **Lighthouse** con perfil de tablet: Performance, Accessibility y Best Practices ≥ 90.
✔ Prueba del cron de backup contra R2 local.
✔ Checklist de despliegue completo.
✔ Revisión de seguridad final.
**Ningún comando remoto se ejecuta**: todos quedan en `docs/pendientes-humanos.md`.

---

## 11. Definición de terminado (cada tarea)

- Compila sin errores de tipos y pasa lint.
- Tiene pruebas y pasan.
- Respeta los contratos de `packages/shared`.
- No introduce secretos en el código.
- Queda registrada en `docs/progreso.md` y en un commit con formato Conventional Commits.

---

## 12. Preguntas abiertas iniciales (para `docs/preguntas-abiertas.md`)

Cópialas al iniciar y añade las que detectes:

1. S9: ¿qué pasa si solo hay un jefe y él registra consumos? ¿Puede el admin validar en ese caso?
2. S10: ¿cómo se corrige un consumo ya aprobado que resultó erróneo?
3. ¿El jefe puede editar sus propios consumos pendientes? La tabla de permisos dice que no.
4. S11: ¿hay otras conversiones de unidades necesarias, por ejemplo densidades l↔kg para resinas?
5. ¿Cuántas tablets y usuarios hay por turno? ¿Las tablets se comparten entre turnos?
6. ¿Se requiere firma o PIN adicional para que el jefe apruebe?
7. Retención de datos personales y de evidencias, según la Ley 1581.
8. ¿Se deben importar órdenes o materiales desde un ERP existente?

---

## 13. Cambios respecto al prompt original (para la auditoría)

| # | Original | Ahora | Motivo |
|---|---|---|---|
| 1 | PBKDF2 "≥ 100.000 iteraciones" | Exactamente 100.000, con hash autodescriptivo | El runtime de Workers rechaza más de 100.000; el desarrollo local no lo detecta |
| 2 | Revocación de tokens y tolerancia en KV | En D1; KV solo como caché no crítico | KV es eventualmente consistente (60 s o más) |
| 3 | Rate limit de 5/min con el binding | Binding como primer filtro + bloqueo por cuenta en D1 | El binding es aproximado y por ubicación |
| 4 | Triggers sin estrategia de migración | Migración propia + prueba en `sqlite_master` | Drizzle no gestiona triggers y los pierde al reconstruir tablas |
| 5 | Backup "exportar tablas a JSON" | Paginado por PK + ciclo de vida de R2 | Límites de CPU y memoria; el export nativo bloquea la base |
| 6 | Idempotencia consultando `sync_mutations` | `sync_mutations` dentro del batch | Condiciones de carrera en reintentos concurrentes |
| 7 | Cursor = último `seq` devuelto | Último `seq` revisado + revocación de visibilidad | Bucles en el pull y datos huérfanos |
| 8 | Sin reglas de tablet compartida ni de dónde vive el token | Outbox por usuario, access en memoria, verificador local | Autoría correcta y seguridad |
| 9 | Tolerancia validada en el cliente | El servidor es la autoridad, con `requiere_novedad` | El cliente offline no ve a los demás supervisores |
| 10 | Unidades y costo histórico sin definir | S11 y S12 | Reportes correctos |
| 11 | "Lighthouse PWA ≥ 90" | Prueba de instalabilidad + Lighthouse en otras categorías | La categoría PWA ya no existe en Lighthouse |
| 12 | Deploy desde CI en la Fase 6 | Solo `workflow_dispatch` | El equipo hará push; un deploy automático no debe dispararse |
| 13 | React 18 fijo | Versión estable actual, fijada en ADR | React 18 ya no es la versión actual |
| 14 | Una fase por ventana, con push | Sesión única, solo commits locales | Decisión del equipo: auditan y luego hacen el push |
| 15 | Referencia visual solo al Figma | Figma + identidad de Catmetal (`docs/diseno/`) | Petición del cliente |
| 16 | Auditoría con datos completos | Se excluyen secretos y hashes | Seguridad y Ley 1581 |

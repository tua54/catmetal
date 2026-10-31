# Informe final — Control de Materia Prima · Catmetal S.A.S.

Sesión de construcción del 2026-10-29/30, rama `build/v1` (línea base en `main`: `bfa8975`). Tags locales `fase-0` a `fase-6`. **No se hizo ningún push ni se ejecutó ningún comando remoto de Cloudflare.**

## 1. Resumen de lo construido

Sistema completo de registro de consumo de materias primas por orden de producción, 100 % sobre Cloudflare, según `docs/spec.md`:

- **Worker** (`apps/worker`, Hono + TypeScript): API `/api/v1` con autenticación (JWT de 15 min en memoria, refresh rotatorio en cookie `HttpOnly` con detección de reutilización, PBKDF2-SHA256 de 100.000 iteraciones, bloqueo por cuenta en D1 + rate limiting, CSRF por `Origin`), órdenes, materiales, asignaciones, tolerancia, consumos (conversión de unidades, costo congelado, tolerancia con autoridad del servidor, registro tardío, corrección), novedades, evidencias en R2 (magic bytes, sha256, 5 MB), validación del jefe (sin autoaprobación ni aprobación sin novedad requerida), auditoría y línea de tiempo, reportes y CSV seguro, y el **protocolo de sincronización offline** (`/sync/push` idempotente dentro del mismo batch, `/sync/pull` por `audit_log.seq`, `/sync/snapshot`, época de sync para restauraciones). Sirve también la PWA con cabeceras de seguridad en todas las respuestas. Cron diario de backup paginado a un bucket R2 propio con continuaciones, y mantenimiento.
- **Base de datos D1**: esquema Drizzle con 7 migraciones (0000–0006), **34 triggers** de inmutabilidad y reglas de negocio en la base (nada se borra; la validación aplica el estado; versiones; autoría inmutable), auditoría en el mismo `db.batch()` que cada escritura, con `order_id`.
- **PWA** (`apps/web`, React 19 + Vite + Tailwind 4): offline-first con Dexie particionado por usuario (tablet compartida), outbox ordenado, motor de sync con candado entre pestañas, subida de fotos en segundo plano (recomprimidas a JPEG sin EXIF), login offline con verificador local (PBKDF2 600.000) con límites de intentos, bloqueo por inactividad, Service Worker propio (nunca cachea `/api`), instalable. Pantallas del supervisor (registro, órdenes, registros del día con estados, corrección, trazabilidad del dispositivo), del jefe (cola de validación, resumen, línea de tiempo, gestión de órdenes, CSV) y del admin (usuarios, materiales, asignaciones, tolerancia), con la identidad visual de Catmetal.
- **Contratos** (`packages/shared`): tipos, esquemas Zod, permisos, errores en español, unidades, formato es-CO/Bogotá, UUID v7.
- **Calidad**: 1.926 pruebas unitarias e integración (Worker con D1/R2/KV reales locales), 33 E2E Playwright (Chromium + WebKit), axe WCAG 2.1 AA, instalabilidad PWA y Lighthouse con perfil de tablet automatizados; CI (`ci.yml`) y despliegue a staging solo manual (`deploy-staging.yml`).
- **Documentación de operación**: `docs/despliegue.md` (comandos exactos verificados, restauración, Ley 1581, checklist).

Subagentes usados: `general-purpose` (backend, sync del servidor, cron, correcciones), `react-developer` (PWA, capa local, motor de sync, pantallas), `ui-ux-designer` (sistema visual y endurecimiento de la UI), `test-engineer` (matriz de permisos, pruebas transversales, E2E, Lighthouse/axe), `database-specialist` (revisiones del esquema y del protocolo, Fases 1 y 3), `security-reviewer` (revisiones de las Fases 2, 4 y 6), `software-architect` (segunda opinión de las ADR de auth y sync), `documentation-researcher` (APIs y comandos de Cloudflare). No se usaron `mvc-dotnet-developer`, `angular-developer` ni `orchestrator`.

## 2. Estado por fase

| Fase | Estado | Evidencia |
|---|---|---|
| 0 — Fundaciones | Completa | [`docs/evidencia/fase-0.md`](evidencia/fase-0.md) |
| 1 — Base de datos y auth | Completa | [`docs/evidencia/fase-1.md`](evidencia/fase-1.md) |
| 2 — API de negocio | Completa | [`docs/evidencia/fase-2.md`](evidencia/fase-2.md) |
| 3 — Sincronización | Completa | [`docs/evidencia/fase-3.md`](evidencia/fase-3.md) |
| 4 — PWA del supervisor | Completa | [`docs/evidencia/fase-4.md`](evidencia/fase-4.md) |
| 5 — PWA del jefe y del admin | Completa | [`docs/evidencia/fase-5.md`](evidencia/fase-5.md) |
| 6 — Endurecimiento y despliegue | Completa | [`docs/evidencia/fase-6.md`](evidencia/fase-6.md) |

Gates finales (commit `e7d61e4`): `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 214, web 534, worker 1.178; cobertura de líneas worker 97,78 % y shared 100 %), `pnpm format:check`, `pnpm test:e2e` (33/33), `pnpm test:lighthouse` (≥ 90) y `pnpm audit --prod` (sin vulnerabilidades), todos en verde.

## 3. Criterios de aceptación de la spec

| Fase | Criterio (§10) | Estado | Dónde se demuestra |
|---|---|---|---|
| 0 | `pnpm install && lint && typecheck && test` pasan y `pnpm dev` levanta el Worker con D1, R2 y KV locales | Cumplido | `docs/evidencia/fase-0.md`; `apps/worker/test/bindings.test.ts` |
| 1 | UPDATE/DELETE en `audit_log` fallan; DELETE falla en tablas de negocio | Cumplido | `apps/worker/test/integridad-triggers.test.ts` |
| 1 | Todos los triggers existen tras todas las migraciones | Cumplido (34) | `integridad-esquema.test.ts` |
| 1 | Foreign keys activas | Cumplido | `bindings.test.ts`, `integridad-esquema.test.ts` |
| 1 | Iteraciones PBKDF2 ≤ 100.000 | Cumplido | `auth-unidades.test.ts` |
| 1 | Login y rotación funcionan; reutilización revoca la familia | Cumplido | `auth-login.test.ts`, `auth-refresh.test.ts` |
| 1 | Bloqueo tras 5 intentos | Cumplido (incluso con 20 intentos concurrentes) | `auth-login.test.ts`, `fase2-seguridad-correcciones.test.ts` |
| 1 | Cada regla de la §3 probada | Cumplido | `permisos-matriz.test.ts`, `permisos-sesion.test.ts`, `fase2-transversal-matriz.test.ts` |
| 1 | La auditoría no contiene secretos | Cumplido | `auth-*.test.ts`, `usuarios.test.ts`, `fase2-transversal-seguridad.test.ts` |
| 2 | Pruebas de integración por endpoint y por permiso | Cumplido | `fase2-transversal-matriz.test.ts` (todas las rutas × rol, contrastado con `app.routes`) |
| 2 | Un fallo a mitad del batch no deja datos parciales | Cumplido | `fase2-transversal-auditoria.test.ts` |
| 2 | Evidencias con mime falso se rechazan | Cumplido | `fase2-evidencias.test.ts` |
| 2 | El CSV neutraliza fórmulas | Cumplido | `fase2-reportes.test.ts`, `packages/shared/src/reportes.test.ts` |
| 2 | Revisión de seguridad | Cumplido | `docs/auditoria/seguridad-fase-2.md` |
| 3 | Mutación repetida (también concurrente) no duplica | Cumplido | `fase3-push.test.ts`, `fase3-push-concurrencia.test.ts` |
| 3 | Conflicto de versión | Cumplido | `fase3-push.test.ts` |
| 3 | La edición de un consumo validado se rechaza | Cumplido | `fase3-push.test.ts` |
| 3 | Registro tardío en orden finalizada | Cumplido | `fase3-push.test.ts` |
| 3 | Tolerancia superada sin novedad → `requiere_novedad = 1` | Cumplido | `fase3-push.test.ts` |
| 3 | Un lote de 25 no excede los límites de D1 | Cumplido | `fase3-push-limites.test.ts` |
| 3 | El pull avanza el cursor sin cambios visibles | Cumplido | `fase3-pull.test.ts` |
| 3 | Revocación de visibilidad | Cumplido | `fase3-pull.test.ts`; cliente `apps/web/src/sync/revision-fase-3.test.ts` |
| 4 | Shell PWA instalable, login offline, pantallas del supervisor con identidad Catmetal e indicador de sync | Cumplido | `e2e/service-worker.spec.ts`, `e2e/login-offline.spec.ts`, `e2e/pwa-instalabilidad.spec.ts`, pruebas de `apps/web` |
| 4 | E2E Chromium: 3 consumos offline (uno con foto) → al reconectar, 3 en D1 y la foto en R2 | Cumplido | `e2e/registro-offline.spec.ts` |
| 4 | E2E tablet compartida: los pendientes de A no se envían con la sesión de B | Cumplido | `e2e/tablet-compartida.spec.ts` |
| 4 | Humo en WebKit | Cumplido (7 pruebas `@humo`; limitación de cookie `Secure` en localhost documentada) | `e2e/*.spec.ts` |
| 4 | Revisión de seguridad | Cumplido | `docs/auditoria/seguridad-fase-4.md` |
| 5 | E2E: registro → rechazo → motivo y corrección → aprobación, visible en la auditoría | Cumplido | `e2e/fase5-flujo-completo.spec.ts` |
| 5 | El jefe no aprueba un consumo propio ni uno con `requiere_novedad` | Cumplido | `e2e/fase5-restricciones-jefe.spec.ts`; `fase2-validaciones*.test.ts` |
| 6 | Instalabilidad PWA automatizada (manifest, SW que controla, arranque offline de `start_url`) | Cumplido | `e2e/pwa-instalabilidad.spec.ts` |
| 6 | Lighthouse tablet ≥ 90 en Performance, Accessibility y Best Practices | Cumplido (91–98 / 100 / 96–100) | `docs/evidencia/lighthouse/resumen.json` |
| 6 | Prueba del cron de backup contra R2 local | Cumplido | `fase6-cron-*.test.ts` |
| 6 | Checklist de despliegue completo | Cumplido | `docs/despliegue.md` §12 |
| 6 | Revisión de seguridad final | Cumplido | `docs/auditoria/seguridad-fase-6.md` |
| 6 | Ningún comando remoto ejecutado | Cumplido | `docs/pendientes-humanos.md` |

## 4. ADR

| ADR | Decisión |
|---|---|
| 0001 | Versiones: TypeScript 6.0 (no 7, por typescript-eslint), Vitest 4.1, `@cloudflare/vitest-plugin` (sucesor del pool deprecado), Wrangler 4.156, React 19.3, Vite 8 |
| 0002 | Desarrollo con `wrangler dev` + Vite (dos procesos); sin `@cloudflare/vite-plugin` en la v1 |
| 0003 | `@catmetal/shared` se consume como código fuente TypeScript |
| 0004 | El Worker atiende todas las rutas (`run_worker_first: true`) para aplicar cabeceras de seguridad a todo |
| 0005 | `audit_log.seq` como cursor del pull (válido por el escritor único de D1), con reglas de ventana, cupo, visibilidad e hidratación |
| 0006 | Triggers de inmutabilidad en una migración propia, con prueba de `sqlite_master` y prohibición de `REPLACE` |
| 0007 | PBKDF2-SHA256 100.000 con formato autodescriptivo; refresh tokens con HMAC-SHA256 |
| 0008 | Sesiones: rol actual desde D1, rotación atómica con gracia de 30 s, CSRF por `Origin`, bloqueo atómico, dispositivos e `instalacion_id`, autoría en tablet compartida |
| 0009 | Época de sync y contrato robusto de `/sync/push` (sobre laxo, validación por mutación, `payload_json`) |
| 0010 | Integridad reforzada en la base (la validación aplica el estado), `audit_log.order_id`, regla de reconstrucción de tablas |
| 0011 | Adaptación visual: estructura del Figma con la identidad de Catmetal |
| 0012 | Dexie particionado por usuario y verificador de login offline (enmendada por 0017) |
| 0013 | La auditoría de identidades es solo para el admin; sin correo en la auditoría |
| 0014 | Backup diario paginado a R2 (bucket propio) y mantenimiento del cron |
| 0015 | Visibilidad de usuarios, revocación y clasificación de errores del sync |
| 0016 | Época en el push, retención de 30 días, idempotencia por clave natural y backup con continuaciones |
| 0017 | Bloqueo por inactividad (10 min), límites del login offline, retención en la tablet |

## 5. Desviaciones y problemas conocidos

Detalle en [`docs/desviaciones.md`](desviaciones.md):

- **D1** `@cloudflare/vitest-plugin` en lugar del paquete deprecado `@cloudflare/vitest-pool-workers` (misma API).
- **D2** Esquema endurecido respecto a la §4 (columnas, índices y triggers adicionales; ninguno relaja la spec).
- **D3** Diseño desde capturas de baja resolución (sin MCP de Figma).
- **D4** Textos del indicador global ("Sin conexión · Todo sincronizado"; conteo de elementos de la cola).
- **D5** WebKit no envía la cookie `Secure` por `http://localhost`: las E2E offline completas solo corren en Chromium.
- **D6** Gestión de órdenes y administración requieren conexión (la validación del jefe sí tolera cortes).
- **D7** Lighthouse, axe e instalabilidad medidos en un PC de desarrollo; `ci.yml` nunca se ejecutó en GitHub.
- **D8** Tareas adelantadas respecto al orden de fases, en paralelo y con archivos disjuntos.

Problemas conocidos:

- El margen de Performance en Lighthouse es estrecho (91–98) y el TBT varía entre corridas; el JS inicial (~670 kB, 207 kB gzip) incluye Zod y Dexie, que no se pudieron diferir sin rehacer `auth/` y `sync/`.
- `/auth/refresh` sin cookie deja un 401 en la consola del login (Best Practices 96).
- La cola del jefe no se actualiza sola (se refresca al volver, decidir o recargar).
- `pnpm audit` de desarrollo: 1 moderada (`esbuild` antiguo dentro de `drizzle-kit`) y 1 baja (`deepmerge` en el build de la PWA); ninguna llega a producción.
- Las pruebas del rate limiter de Miniflare dependen del minuto del reloj (estabilizadas con espera; ver `apps/worker/test/auth-login.test.ts`).
- Durante la sesión, los hooks de `.claude/` no estuvieron instalados (la configuración seguía en `_mover-a-claude/`); el orquestador cumplió sus reglas voluntariamente.

## 6. Preguntas abiertas que requieren decisión de negocio

Lista completa con el supuesto aplicado en [`docs/preguntas-abiertas.md`](preguntas-abiertas.md) (P1–P24). Las que más importan:

- **P1** ¿El admin puede validar cuando el único jefe registró el consumo? (hoy no: queda pendiente para otro jefe).
- **P2** ¿Cómo se corrige un consumo ya aprobado? (hoy no se puede).
- **P4** ¿Conversiones l↔kg por densidad (resinas)? (hoy solo kg↔g y l↔ml).
- **P7** Retención de datos personales y evidencias (Ley 1581).
- **P8** ¿Importar órdenes o materiales desde un ERP?
- **P18** Cómo escriben los operarios las cantidades ("1.234").
- **P20** ¿Todos los materiales tienen lote?
- **P23** ¿Separación de funciones entre quien registra la novedad y quien aprueba?
- **P24** ¿Aceptar un consumo registrado offline si antes de sincronizar se desasignó al supervisor o se desactivó el material?

## 7. Hallazgos de seguridad abiertos

Ningún hallazgo crítico ni alto abierto. Estado detallado en `docs/auditoria/seguridad-fase-{2,4,6}.md`.

- **F6-01 (medio), parte humana**: el repositorio ya fija las acciones por SHA y endurece el job; falta que una persona use una **cuenta de Cloudflare separada para staging o un token sin alcance sobre producción**, y configure el environment de GitHub con política de ramas y revisores.
- **Riesgos aceptados** (con ADR): PBKDF2 100.000 en el servidor (0007); verificador offline como oráculo de la contraseña si se extrae IndexedDB, mitigado con límites y MDM (0017); integridad del outbox frente a quien controla el dispositivo (0017); `revocar` revela ids posteriores a una desasignación (0017); `instalacion_id` enviado por el cliente (0017); bloqueo de cuenta provocado por un tercero y borrado del verificador (0008/0017); backups con hashes en un bucket privado propio 90 días (0014); backup que no es foto de un instante (0014/0016).
- **Diferido**: Trusted Types (CSP) — justificado en `apps/worker/src/cabeceras.ts`.

## 8. Pendientes humanos

Lista completa y ordenada en [`docs/pendientes-humanos.md`](pendientes-humanos.md). Comandos exactos:

1. Instalar la configuración de Claude Code (si se seguirá usando):
   ```powershell
   New-Item -ItemType Directory -Force .claude\hooks | Out-Null
   Move-Item _mover-a-claude\settings.json .claude\settings.json -Force
   Move-Item _mover-a-claude\hooks\*.mjs .claude\hooks\ -Force
   Remove-Item _mover-a-claude -Recurse -Force
   ```
2. Revisar y, cuando se apruebe, publicar la rama y los tags:
   ```powershell
   git switch build/v1
   git log --oneline main..build/v1
   git tag -l "fase-*"
   git push -u origin main build/v1 --follow-tags
   ```
3. Plan **Workers Paid** en la cuenta de Cloudflare.
4. Crear recursos por entorno (staging; repetir con `prod`/`production`) y copiar los IDs a `apps/worker/wrangler.jsonc`:
   ```powershell
   cd apps\worker
   npx wrangler d1 create mp-staging --location=wnam
   npx wrangler r2 bucket create mp-evidencias-staging
   npx wrangler r2 bucket create mp-backups-staging
   npx wrangler r2 bucket lifecycle add mp-backups-staging backups-90d backups/ --expire-days 90
   npx wrangler kv namespace create CONFIG_staging
   ```
5. Secretos de 32 bytes por entorno:
   ```powershell
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put JWT_SECRET --env staging
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put REFRESH_SECRET --env staging
   ```
6. Migraciones remotas: `npx wrangler d1 migrations apply mp-staging --env staging --remote`.
7. Primer administrador (SQL generado localmente; ver `docs/despliegue.md` §5) y `npx wrangler d1 execute mp-staging --env staging --remote --file="$env:TEMP\catmetal-primer-admin.sql"`.
8. Desplegar: `pnpm --filter @catmetal/web build` y `npx wrangler deploy --env staging` (o el workflow `deploy-staging`); dominio de producción en `env.production.routes`; luego `--env production`.
9. GitHub: environment `staging` protegido (revisores, sin auto-aprobación, solo `main`) con `CLOUDFLARE_API_TOKEN` (cuenta separada o token sin alcance sobre producción) y `CLOUDFLARE_ACCOUNT_ID`.
10. Verificaciones de staging (14 puntos de `docs/auditoria/seguridad-fase-6.md` §6), incluidas las pruebas de humo de D1 y la medición del login offline en la tablet real.
11. Política MDM de las tablets (sin depuración USB, bloqueo de pantalla); logo SVG oficial e íconos de la PWA del cliente; Cloudflare Access sobre todo staging.

## 9. Cómo verificar localmente desde un clon limpio en Windows

Requisitos: Node 24 (o ≥ 22.18), Git for Windows. En PowerShell:

```powershell
git clone <url-del-repositorio> catmetal
cd catmetal
git switch build/v1

# pnpm sin permisos de administrador (si no está en el PATH)
New-Item -ItemType Directory -Force "$env:APPDATA\npm" | Out-Null
corepack enable pnpm --install-directory "$env:APPDATA\npm"

pnpm install --frozen-lockfile
pnpm setup:dev-vars          # genera apps/worker/.dev.vars (no se versiona)
pnpm db:reset:local          # migra y siembra la D1 local (solo local)

# Gates
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check

# E2E y medición (descarga los navegadores la primera vez)
pnpm test:e2e:instalar
pnpm test:e2e
pnpm test:lighthouse

# Seguridad de dependencias
pnpm audit --prod

# Probar la app: http://localhost:5173 (Ctrl+C para detener)
pnpm dev
```

Usuarios del seed local: `admin@catmetal.test`, `jefe@catmetal.test`, `supervisor1@catmetal.test`, `supervisor2@catmetal.test`, con la contraseña `SEED_PASSWORD` de `apps/worker/.dev.vars`. Para probar sin conexión: iniciar sesión con conexión una vez, luego desactivar la red en las herramientas del navegador.

## 10. Mapa de commits (`git log --oneline main..build/v1`, agrupado por fase)

Agrupado por el trailer `Fase:` de cada commit (121 commits hasta el cierre de la Fase 6; el commit de este informe se añade después). Las tareas adelantadas aparecen en la fase a la que pertenecen, no en orden cronológico; el orden cronológico real es el de `git log`.

### Fase 0 (18 commits)

```
efea546 docs: registrar arranque, mapeo de subagentes y preguntas abiertas
4eb340f docs(plan): plan de la fase 0
e8f2849 docs(adr): registrar proceso de desarrollo con wrangler dev y vite
d55386a docs(adr): registrar consumo de shared como código fuente
0df2627 docs: registrar particularidades verificadas de cloudflare, drizzle y hono
6930f77 build: crear monorepo pnpm con typescript, eslint, prettier y vitest
bb3eb38 docs(adr): registrar versiones principales del stack
3d43320 docs: registrar desviación por el renombre del plugin de pruebas de workers
22334cf feat(web): crear esqueleto de la pwa con react, tailwind y tokens de catmetal
23585c9 docs: anotar particularidad de react-router en vitest
338cd74 feat(shared): definir contratos de dominio, permisos, errores, unidades y esquemas zod
b4cb941 docs: agregar preguntas abiertas sobre parseo de cantidades y correcciones
56c718f docs(adr): registrar run_worker_first total para aplicar cabeceras de seguridad
8edd9a7 feat(infra): configurar worker con wrangler, hono, cabeceras y pruebas en el pool de workers
9bd4faf docs: anotar particularidades de wrangler en windows y del pool de pruebas
75387ae ci: agregar workflow de calidad y readme de arranque para windows
4ef958b docs(progreso): cierre de la fase 0
be04929 fix(docs): restaurar el registro de la fase 0 en progreso.md
```

### Fase 1 (19 commits)

```
51ede35 docs(plan): plan de la fase 1
a855e75 docs(adr): registrar audit_log.seq como cursor de sincronización
9e90a60 docs(adr): registrar triggers de inmutabilidad en migración propia
3ddce89 docs(adr): registrar hash pbkdf2 de contraseñas y hmac de refresh tokens
d6487f6 docs(adr): registrar sesiones, csrf, bloqueo y autoría por dispositivo
a9d6c6b docs(adr): registrar época de sync y contrato robusto de push
71f6098 docs: registrar desviación de esquema por endurecimiento de integridad
2070b70 feat(shared): endurecer contrato de sync, fechas y login según adr 0008 y 0009
759bcf7 feat(db): crear esquema drizzle, migraciones y triggers de inmutabilidad
d64e9d9 docs: anotar particularidades de drizzle-kit y migraciones d1
293c6d0 feat(db): agregar seed local idempotente con usuarios, materiales y órdenes
0c214c8 docs(progreso): registrar avance de la fase 1
3b53145 feat(auth): agregar login, refresh con rotación, bloqueo, csrf, permisos y gestión de usuarios
4ba9c95 test(auth): cubrir la matriz de permisos de la §3 con sesiones reales
12e61ca docs(auditoria): guardar revisión del esquema de la fase 1
ac958b9 docs(adr): reforzar integridad en la base y agregar order_id a la auditoría
1f4fba5 docs: agregar preguntas abiertas sobre lote obligatorio y fotos heic
d0419e2 feat(db): reforzar integridad con triggers, índices y order_id en la auditoría
49cde85 docs(progreso): cierre de la fase 1
```

### Fase 2 (15 commits)

```
7e4231c docs(plan): plan de la fase 2
2e2c632 docs(progreso): registrar inicio de la fase 2 y tarea 4.1 adelantada
fb72367 feat(api): agregar comandos de dominio, materiales, settings, órdenes y asignaciones
37395ff docs(progreso): registrar tareas en paralelo de la fase 2 y 3.3 adelantada
8e78583 feat(api): agregar consumos, novedades y evidencias en r2
3b6be3d docs: agregar pregunta sobre supervisor desasignado y notas del runtime de workers
8a69acd feat(api): agregar auditoría, línea de tiempo de la orden y reportes con csv
cd6af3c feat(api): agregar cola de validación, aprobación y rechazo de consumos
89736c7 docs: anotar que meta.changes de d1 cuenta las filas escritas por triggers
ff511f1 docs(auditoria): guardar revisión de seguridad de la fase 2
ba36831 docs(adr): limitar la auditoría de identidades al admin y quitar el correo de la auditoría
a0eff0c test(api): cubrir la matriz endpoint por rol, csrf, auditoría atómica y errores
0685fc4 docs(progreso): registrar avance de la fase 2 y tareas adelantadas de la fase 3
2594d7e fix(seguridad): corregir hallazgos de la revisión de la fase 2
c3c848c docs(progreso): cierre de la fase 2
```

### Fase 3 (19 commits)

```
2d870e4 docs(adr): registrar almacenamiento local con dexie y verificador de login offline
cb69537 feat(sync): crear capa de datos local con dexie particionada por usuario y outbox
63c7916 feat(auth): agregar cliente de sesión de la pwa con token en memoria y login offline
c6a661c feat(shared): definir el contrato de /sync/snapshot
8e24875 docs(plan): plan de la fase 3
6c6096e feat(sync): agregar motor de sincronización del cliente y subida de evidencias
808487d docs(progreso): registrar avance de la fase 3
8388341 feat(sync): agregar push idempotente, pull por seq y snapshot del servidor
d670039 docs(adr): registrar visibilidad de usuarios, revocación y errores del sync
23e1b4f docs(progreso): registrar avance de la fase 3 y tareas adelantadas
9f2366e docs(auditoria): guardar revisión del protocolo de sync y del esquema de la fase 3
33c0a77 docs(adr): agregar época en el push, retención de 30 días y backup con continuaciones
dc92e42 feat(shared): agregar época al sobre del push y subir la retención a 30 días
20db5b3 docs(progreso): registrar revisión del protocolo y correcciones en curso
f01ae99 fix(sync): corregir los hallazgos del cliente de la revisión de la fase 3
2bb5ef5 fix(sync): corregir los hallazgos del servidor de la revisión de la fase 3
2c80de8 fix(auth): estabilizar la prueba del rate limiter frente al cambio de minuto
1a2fbda fix(auth): dar tiempo máximo propio a la prueba del rate limiter
72b0802 docs(progreso): cierre de la fase 3
```

### Fase 4 (20 commits)

```
2c56edf docs(adr): registrar adaptación visual del figma a la identidad de catmetal
6f8ee0a feat(ui): crear componentes base accesibles con la identidad de catmetal
fb4abab docs(plan): plan de la fase 4
a515233 feat(pwa): agregar shell pwa con service worker, login offline, guardas por rol y estado de sync
5e272bb docs: anotar particularidades de vite-plugin-pwa y del service worker
68e513b test(e2e): configurar playwright con servidor local aislado y pruebas de login, sw y login offline
573f3c0 refactor(db): aceptar SEED_PASSWORD por variable de entorno en el seed
1cdaf2b feat(web): agregar pantallas del supervisor para registrar consumos offline
f691638 fix(web): ampliar el tiempo de espera asíncrono de testing library a 5 s
edadc5d docs: anotar que browser-image-compression debe usarse sin web worker
18d3141 feat(web): mostrar registros perdidos en una restauración y envíos atascados
b3cf05f docs(progreso): registrar inicio de la fase 4 y tareas adelantadas de la fase 5
a9681a5 test(e2e): cubrir registro offline con foto, tablet compartida y humo de registro
ee76967 fix(seguridad): desactivar invocation logs y urls públicas no deseadas en producción
b35a145 docs(auditoria): guardar revisión de seguridad de la fase 4
f4bd649 docs(adr): agregar bloqueo por inactividad y límites del login offline, y enmendar la adr 0012
c7b855e fix(seguridad): revocar sesiones ajenas del mismo navegador y fijar no-cache en el shell
c6b442b fix(seguridad): corregir los hallazgos del cliente de la revisión de la fase 4
6147a8f test(e2e): adaptar el login al correo enmascarado de la revisión F4-04
0d7d9ad docs(progreso): cierre de la fase 4
```

### Fase 5 (5 commits)

```
594551b docs(plan): planes de las fases 5 y 6
e14ed95 feat(web): agregar pantallas del jefe para validar consumos y gestionar órdenes
8dddc03 feat(web): agregar pantallas de administración y rutas del jefe y del admin
ad72a97 test(e2e): cubrir el flujo del jefe, sus restricciones y la administración
7e3f6b5 docs(progreso): cierre de la fase 5
```

### Fase 6 (25 commits)

```
b2e0fb8 docs(adr): registrar backup diario paginado a r2 y mantenimiento del cron
46310a1 feat(infra): agregar cron de backup paginado de d1 a r2 y mantenimiento
3b9db17 docs: anotar particularidades de r2 y streams en workerd
77eef0c docs(infra): agregar guía de despliegue, workflow manual de staging y generador del primer admin
3362f4c docs: listar los comandos remotos de despliegue como pendientes humanos
a9814da docs(progreso): registrar inicio de la fase 6
9fcd408 perf(sync): paginar el snapshot por entidad en curso y validaciones por consumo
f449686 fix(shared): desactivar la compilación jit de zod para respetar la csp
9c7e7de test(e2e): verificar instalabilidad de la pwa y medir lighthouse con perfil de tablet
0b44129 docs: registrar desviaciones de diseño, indicador, webkit, conexión y medición
04439b0 feat(web): endurecer errores, estados vacíos, accesibilidad y carga inicial
c999d98 test(e2e): verificar accesibilidad wcag 2.1 aa con axe en las pantallas principales
09dfe37 docs(evidencia): actualizar las puntuaciones de lighthouse tras el endurecimiento
4037645 docs(auditoria): marcar m5 como corregido en la revisión de la fase 3
a5ea9c9 docs: actualizar los scripts y el despliegue en el readme
020f917 docs(auditoria): guardar revisión de seguridad final de la fase 6
a26e580 ci(seguridad): fijar acciones por sha y endurecer el job de despliegue de staging
3c27abb chore(seguridad): ignorar el sql del primer admin y los backups descargados
86a4aac docs(infra): corregir la guía de despliegue según la revisión de seguridad final
dcc0b6b fix(seguridad): separar los backups en su propio bucket, agregar coop y rechazar contraseñas comunes
ac1a924 fix(seguridad): rechazar contraseñas comunes también en el generador del primer admin
51a0bce docs(adr): enmendar backups a bucket propio y aceptar el riesgo f6-06
e7d61e4 fix(seguridad): vaciar la caché al cambiar de usuario, codificar ids y mantener inert como pila
b027d58 docs(evidencia): registrar lighthouse final de la fase 6
7bc38e0 docs(progreso): cierre de la fase 6
```

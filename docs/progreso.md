# Progreso de la sesión

> Después de una compactación de contexto o de un reinicio, **lee este archivo primero** y retoma desde "Siguiente paso".

## Estado actual

- Rama de trabajo: `build/v1` (línea base en `main`: `bfa8975`).
- Fases 0, 1, 2 y 3 cerradas (tags `fase-0` a `fase-3`). Fase en curso: **Fase 4 — PWA del supervisor**.
- Ya confirmadas de la Fase 4 (adelantadas): 4.1 componentes, 4.2 shell PWA/login/estado de sync (más 4.2b perdidos y atascados), 4.3 pantallas del supervisor, 4.4a infraestructura E2E. Adelantada de la Fase 6: 6.1 cron de backup.

## Siguiente paso

Terminar la 4.4b (E2E de 3 consumos offline con foto y tablet compartida, `test-engineer` en curso), luego la revisión de seguridad 4.5 y el cierre de la Fase 4.

## Mapeo de subagentes

Verificado el 2026-10-29 en `~/.claude/agents/` y en la lista de tipos de agente de la sesión. Todos los subagentes del mapeo de `CLAUDE.md` están disponibles; no se creó, editó ni copió ninguno.

| Rol | Subagente | Disponible | Notas |
|---|---|---|---|
| Backend (Worker, Hono, Drizzle/D1, auth, sync servidor) | `general-purpose` | Sí | Herramientas completas. Brief con el rol completo. |
| Revisión de esquema SQL | `database-specialist` | Sí | Orientado a SQL Server/EF Core: brief con bloque de stack; en modo revisión no modifica archivos. |
| Frontend (PWA) | `react-developer` | Sí | |
| Sincronización (cliente) | `react-developer` | Sí | Brief extra detallado. |
| Sistema visual | `ui-ux-designer` | Sí | |
| QA | `test-engineer` | Sí | Orientado a .NET: brief con bloque de stack. |
| Seguridad | `security-reviewer` | Sí | Solo lectura (Read, Glob, Grep, Web). El orquestador guarda el informe. |
| Segunda opinión de arquitectura | `software-architect` | Sí | Solo lectura. |
| Documentación | `documentation-researcher` / `deep-researcher` | Sí | Solo lectura. |

No se usan `mvc-dotnet-developer`, `angular-developer` ni `orchestrator`.

## Prerrequisitos verificados (2026-10-29)

- Node.js v24.18.0, npm 11.16.0, git 2.45.2.windows.1, corepack 0.35.0.
- pnpm no estaba en el `PATH`. `corepack enable` falla sin permisos de administrador (`EPERM` en `C:\Program Files\nodejs`). Se instaló el shim de usuario con `corepack enable pnpm --install-directory %APPDATA%\npm` → pnpm 12.16.1. Ver `docs/notas-plataforma.md`.
- **`.claude/` no estaba instalado**: la configuración y los hooks siguen en `_mover-a-claude/` (paso 0 de `docs/ARRANQUE.md` sin ejecutar). Por la regla 7 el orquestador no crea `.claude/`. Los hooks `guardia.mjs` y `no-parar.mjs` **no están activos** en esta sesión; el orquestador cumple sus reglas de forma voluntaria y lo indica en cada brief. Registrado en `docs/pendientes-humanos.md`.
- El servidor MCP de Figma no está conectado: se trabaja con `docs/diseno/README.md` y las capturas.

## Registro cronológico

### Arranque

- Línea base en `main` (`chore: línea base de orquestación y especificación`), incluye `_mover-a-claude/` porque es la configuración entregada del proyecto.
- Rama `build/v1` creada.

### Fase 0 — Fundaciones (cerrada)

- 0.1 Monorepo y herramientas (general-purpose). Versiones: ADR 0001. pnpm 12 con `allowBuilds` y `minimumReleaseAge`.
- `documentation-researcher` verificó APIs de Cloudflare/Drizzle/Hono: `@cloudflare/vitest-pool-workers` está deprecado → se usa `@cloudflare/vitest-plugin` (desviación D1).
- 0.2 Contratos de `packages/shared` (general-purpose): 115 pruebas, 100 % de líneas.
- 0.4 Esqueleto de la PWA (react-developer), en paralelo con 0.2.
- 0.3 Worker, Wrangler, pruebas en el pool de Workers y `pnpm dev` (general-purpose). ADR 0004: `run_worker_first: true` para aplicar cabeceras a todo.
- 0.5 CI y README (general-purpose).
- `software-architect` revisó por adelantado las ADR de la Fase 1 (cursor, triggers, hashes, sesiones): 4 hallazgos altos incorporados (hidratación de órdenes recién asignadas, sobre laxo en /sync/push, user_id del autor en el sobre, época de sync) → ADR 0009 y ADR 0005/0006/0008 reescritas.
- Decisión menor: `sourcemap: true` en la web se revisa en la Fase 6.
- Evidencia: `docs/evidencia/fase-0.md`.
- Incidente (fase 0): el commit de cierre `4ef958b` dejó este registro con huecos por un error de comillas en bash (sustitución de comandos). Ningún comando dañino se ejecutó (solo falló un `pnpm dev\`). Corregido en el commit siguiente; desde entonces los documentos se editan con las herramientas de edición, no con heredocs.

### Fase 1 — Base de datos y auth (cerrada)

- 1.0 Contratos de shared endurecidos por ADR 0008/0009 (general-purpose).
- 1.1 Esquema Drizzle, migraciones 0000 (generada), 0001 (26 triggers a mano) y 0002 (settings iniciales con `sync_epoca` aleatoria por base) (general-purpose).
- 1.2 Seed local idempotente (general-purpose). Credenciales: `admin@catmetal.test`, `jefe@catmetal.test`, `supervisor1@catmetal.test`, `supervisor2@catmetal.test`, contraseña `SEED_PASSWORD` de `apps/worker/.dev.vars`.
- Decisión menor: en `audit_log`, las claves compuestas usan `entidad_id = '<order_id>:<user_id>'` (`order_supervisors`) y `'<order_id>:<material_id>'` (`order_planned_materials`); `settings` usa su `clave`.
- Decisión menor: el seed usa `ON CONFLICT DO NOTHING` en vez de `INSERT OR IGNORE` para no ocultar violaciones de CHECK.
- 1.3 Auth completa (general-purpose): login, refresh con rotación y ventana de gracia, bloqueo, CSRF, permisos, usuarios.
- 1.4 Matriz de permisos de la §3 (test-engineer): 48 pruebas.
- 1.5 Revisión del esquema (database-specialist): `docs/auditoria/revision-esquema-fase-1.md`.
- 1.7 Aplicación de la revisión (general-purpose): ADR 0010, migraciones 0003–0004, 34 triggers.
- Preguntas nuevas: P20 (lote obligatorio), P21 (fotos HEIC).
- Cierre: gates en verde, 466 pruebas. Evidencia: `docs/evidencia/fase-1.md`.

### Fase 2 — API de negocio (cerrada)

- 2.1 Infraestructura de comandos de dominio, materiales, settings, órdenes y asignaciones (general-purpose), en curso.
- **Tarea adelantada 4.1** (sistema visual y componentes base, `ui-ux-designer`, ADR 0011): se ejecuta en paralelo con la Fase 2 porque solo toca `apps/web/src/components/ui` y no depende del backend. Su commit lleva `Fase: 4`.
- 2.1 confirmada. 4.1 (adelantada) confirmada: 76 pruebas de componentes.
- En paralelo: 2.2 (consumos, novedades, evidencias), 2.4 (auditoría y reportes) y **tarea adelantada 3.3** (capa Dexie + outbox, `react-developer`, ADR 0012; solo toca `apps/web/src/datos`).
- 2.2, 2.3, 2.4 confirmadas (consumos/novedades/evidencias, validaciones, auditoría/reportes). 2.5 (test-engineer): 421 pruebas transversales, sin defectos.
- 2.6 revisión de seguridad: 0 críticos, 0 altos, 1 medio. `docs/auditoria/seguridad-fase-2.md`. ADR 0013 (auditoría de identidades solo para admin; sin correo en la auditoría). Correcciones en la tarea 2.8 (en curso).
- Tareas adelantadas confirmadas: 3.3 (Dexie + outbox) y 3.4 (cliente de auth, Dexie v2 con tabla `candados`).
- Decisión menor (3.4): el login cae al verificador offline solo ante error de red o 5xx del servidor; un rechazo del servidor (credenciales, bloqueo, origen) nunca abre la sesión offline. Se revisará en la seguridad de la Fase 4.
- `pnpm audit --prod`: sin vulnerabilidades conocidas.
- 2.8 correcciones de seguridad confirmadas (`2594d7e`).
- Cierre: 1.428 pruebas en verde; `pnpm audit --prod` sin vulnerabilidades. Evidencia: `docs/evidencia/fase-2.md`.

### Fase 3 — Sincronización (cerrada)

- Adelantadas y confirmadas: 3.3 (Dexie + outbox), 3.4 (cliente de auth), contrato `/sync/snapshot` (orquestador), 3.5 (motor de sync del cliente, `react-developer`).
- Decisión menor (3.5): sin conexión y sin pendientes, el indicador dice "Sin conexión · Todo sincronizado" (en vez de "0 por sincronizar").
- En curso: 3.1–3.2 servidor de sync (`general-purpose`), y **tarea adelantada 4.2** (shell PWA, login, layout, estado de sync; `react-developer`; plan de la Fase 4 ya confirmado).
- 3.1–3.2 servidor de sync confirmado (`8388341`); ADR 0015 (visibilidad de usuarios, revocación, errores).
- Adelantadas confirmadas: 4.2 (shell PWA, login, layout, estado de sync) y 6.1 (cron de backup, ADR 0014). Planes de las Fases 4, 5 y 6 confirmados por adelantado.
- En curso: 3.6 (revisión de protocolo y esquema, `database-specialist`), 4.3 (pantallas del supervisor) y 4.4a (infraestructura E2E, `test-engineer`).
- 3.6 revisión del protocolo (`docs/auditoria/revision-esquema-fase-3.md`): 3 altos. ADR 0016 (época en el push, retención de 30 días, idempotencia por clave natural, backup con continuaciones). Contrato de shared ajustado por el orquestador (`dc92e42`). Pregunta P24.
- 4.4a infraestructura E2E confirmada (18 pruebas, Chromium y WebKit; login offline ~280 ms en Chromium y ~1,5 s en WebKit).
- En curso: 3.8 (correcciones del servidor), 3.9 (correcciones del cliente), 4.3 (pantallas del supervisor).
- Pendiente menor: que `scripts/seed.mjs` acepte `SEED_PASSWORD` por variable de entorno para retirar `scripts/e2e-precarga-seed.mjs`.
- 3.8 (servidor) y 3.9 (cliente) corrigieron los hallazgos de la revisión 3.6. Pruebas inestables corregidas sin tocar aserciones (rate limiter y rutas lazy).
- Cierre: shared 209, worker 1.152, web 374 pruebas; audit sin vulnerabilidades. Evidencia: `docs/evidencia/fase-3.md`.

### Fase 4 — PWA del supervisor (cerrada)

- Adelantadas y confirmadas: 4.1, 4.2 (+4.2b), 4.3, 4.4a. En curso: 4.4b (E2E offline con foto y tablet compartida).
- **Tareas adelantadas de la Fase 5** en paralelo: 5.1–5.2 (pantallas del jefe, `react-developer`) y 5.3 (pantallas de admin, otro `react-developer`), con archivos separados; ambos tocan solo su bloque de `src/rutas/rutas.tsx`.
- 4.4b E2E offline con foto y tablet compartida; 4.5 revisión de seguridad (2 medios); ADR 0017; 4.7 correcciones (cliente `c6b442b`, servidor `c7b855e`); `wrangler.jsonc` sin invocation logs ni URLs públicas en producción.
- Cierre: 1.859 pruebas unitarias/integración y 25 E2E en verde; audit sin vulnerabilidades. Evidencia: `docs/evidencia/fase-4.md`.

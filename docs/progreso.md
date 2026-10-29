# Progreso de la sesión

> Después de una compactación de contexto o de un reinicio, **lee este archivo primero** y retoma desde "Siguiente paso".

## Estado actual

- Rama de trabajo: `build/v1` (línea base en `main`: `bfa8975`).
- Fases 0 y 1 cerradas (tags `fase-0`, `fase-1`). Fase en curso: **Fase 2 — API de negocio**.

## Siguiente paso

Confirmar `docs/plan-fase-2.md` (ya redactado, con los patrones de la ADR 0010) y delegar la tarea 2.1 (infraestructura de comandos de dominio, materiales, settings, órdenes y asignaciones).

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

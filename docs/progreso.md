# Progreso de la sesión

> Después de una compactación de contexto o de un reinicio, **lee este archivo primero** y retoma desde "Siguiente paso".

## Estado actual

- Rama de trabajo: `build/v1` (línea base en `main`: `bfa8975`).
- Fase 0 cerrada (tag `fase-0`). Fase en curso: **Fase 1 — Base de datos y auth**.

## Siguiente paso

Confirmar `docs/plan-fase-1.md` y las ADR 0005–0009, y delegar las tareas 1.0 (contratos de shared) y 1.1 (esquema y triggers) en paralelo.

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

- 0.1 Monorepo y herramientas (general-purpose). Versiones: ADR 0001. pnpm 12 con  y .
-  verificó APIs de Cloudflare/Drizzle/Hono:  está deprecado → se usa  (desviación D1).
- 0.2 Contratos de  (general-purpose): 115 pruebas, 100 % de líneas.
- 0.4 Esqueleto de la PWA (react-developer), en paralelo con 0.2.
- 0.3 Worker, Wrangler, pruebas en el pool de Workers y  (general-purpose). ADR 0004:  para aplicar cabeceras a todo.
- 0.5 CI y README (general-purpose).
-  revisó por adelantado las ADR de la Fase 1 (cursor, triggers, hashes, sesiones): 4 hallazgos altos incorporados (hidratación de órdenes recién asignadas, sobre laxo en /sync/push, user_id del autor en el sobre, época de sync) → ADR 0009 y ADR 0005/0006/0008 reescritas.
- Decisión menor:  en la web se revisa en la Fase 6.
- Evidencia: .

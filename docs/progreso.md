# Progreso de la sesión

> Después de una compactación de contexto o de un reinicio, **lee este archivo primero** y retoma desde "Siguiente paso".

## Estado actual

- Rama de trabajo: `build/v1` (línea base en `main`: `bfa8975`).
- Fase en curso: **Fase 0 — Fundaciones**.

## Siguiente paso

Escribir `docs/plan-fase-0.md`, hacer su commit y delegar la tarea 0.1.

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

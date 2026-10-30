# Evidencia — sesión de correcciones v1.1

## C1. Configuración de Claude Code instalada (commit `5e5cdcf`)

`git ls-files .claude`:

```
.claude/hooks/guardia.mjs
.claude/hooks/no-parar.mjs
.claude/sesion.json
.claude/settings.json
```

`git ls-files _mover-a-claude`: vacío.

Prueba del hook `guardia.mjs`. Se le pasa un JSON por stdin (`node .claude/hooks/guardia.mjs < entrada.json`):

| Entrada | Exit |
|---|---|
| `{"tool_name":"Bash","tool_input":{"command":"git push"}}` | **2** (bloqueado) |
| `git commit` sin `agent_id` (sesión principal) | 0 |
| `git commit` con `agent_type: "orchestrator"` y sin `agent_id` (sesión principal con agente global) | 0 |
| `git commit` con `agent_id` (subagente) | 2 |

Antes del ajuste del equipo (`esSubagente = Boolean(entrada.agent_id)`), la tercera fila daba exit 2 y bloqueaba al orquestador (ver `docs/notas-plataforma.md`).

## Cierre de P1 (después de `ea2b5df`)

| Gate | Resultado |
|---|---|
| `pnpm format:check` | Todos los archivos con el estilo de Prettier |
| `pnpm test:e2e` (Chromium completo y WebKit `@humo`) | **35 pasadas**, 0 fallidas, en 1,8 min |
| `pnpm lint`, `pnpm typecheck` y `pnpm test` | En verde en cada commit de P1, verificado en un worktree limpio con solo el cambio del commit (ver el cuerpo de cada commit) |

Cada ítem de código se verificó en un worktree temporal creado desde HEAD (`git worktree add --detach`), con solo los archivos de ese ítem. Así el commit no dependía del trabajo en curso de otros subagentes en el árbol principal.

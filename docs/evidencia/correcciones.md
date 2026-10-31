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

## Gates finales (sobre `421cf9f`, árbol limpio)

| Comando | Resultado |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 (shared, worker con `wrangler types --check`, web y tsc de la raíz) |
| `pnpm format:check` | exit 0: todos los archivos con el estilo de Prettier |
| `pnpm test` | **2.252 pruebas, 0 fallidas**: shared 265/265 en 12 archivos (líneas 100 %); web 618/618 en 69 archivos; worker 1.369/1.369 en 63 archivos (líneas 98,35 %, sentencias 98,26 %, ramas 91,66 %, funciones 99,27 %) |
| `pnpm test:e2e` | **35 pasadas**, 0 fallidas, en 1,8 min (Chromium completo y WebKit `@humo`) |
| `pnpm audit --prod` | No known vulnerabilities found |
| `pnpm test:lighthouse` | Todas las URLs (supervisor, sincronización, jefe y admin): Performance, Accessibility y Best Practices en **100**, mediana de 3 corridas; umbral de 90 cumplido. Resumen en `docs/evidencia/lighthouse/resumen.json` |

Comparación con la línea base de la auditoría externa (`build/v1`): 1.926 pruebas y 26 E2E de Chromium. Ahora hay 2.252 pruebas y 35 E2E, contando WebKit `@humo`.

## Ensayos locales registrados en los commits

- **M1** (`e8e5a27`): el SQL de desbloqueo de emergencia se aplicó con `wrangler d1 execute DB --local` sobre una D1 limpia, dos veces. Resultado: una sola auditoría, cupos en cero y el correo ausente de `audit_log`.
- **M4 + R-01** (`b89f69f`): el CLI de restauración se probó con un backup sintético de 597 MiB de `audit_log`. El anterior falla con `Cannot create a string longer than 0x1fffffe8 characters`; el nuevo sale con 0 en 9,2 s y un pico de RSS de 288 MiB. De punta a punta con `--local`: la verificación termina sin errores y, al repetirla, aborta con `CHECK constraint failed`.
- **N2** (`25c254a`): con `seed --reset` y dos corridas del seed, `sqlite_sequence` de `audit_log` es 31, igual a `max(seq)`.

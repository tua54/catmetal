# Arranque de la sesión de Claude Code

## 0. Instalar la configuración de Claude Code (una sola vez)

La configuración de permisos y los hooks se entregaron en `_mover-a-claude\`, porque la carpeta `.claude` no admite escritura remota. Muévela antes de lanzar, en PowerShell, desde `C:\catmetal`:

```powershell
New-Item -ItemType Directory -Force .claude\hooks | Out-Null
Move-Item _mover-a-claude\settings.json .claude\settings.json -Force
Move-Item _mover-a-claude\hooks\*.mjs .claude\hooks\ -Force
Remove-Item _mover-a-claude -Recurse -Force
```

Comprueba que el hook funciona antes de lanzar Claude Code (debe imprimir `BLOQUEADO ...` y `exit=2`):

```powershell
'{"tool_name":"Bash","tool_input":{"command":"git push"}}' | node .claude\hooks\guardia.mjs; "exit=$LASTEXITCODE"
```

## 1. Requisitos en la máquina (Windows)

- Node.js LTS (22 o superior) en el `PATH`. Los hooks se ejecutan con `node`.
- pnpm, activado con `corepack enable`.
- Git for Windows. Claude Code usa Git Bash para los hooks; si Git Bash no está, usa PowerShell, y los hooks funcionan igual porque se invocan con `node`.
- Claude Code actualizado (`claude update`).
- Los subagentes del equipo, ya instalados en `~/.claude/agents/`. Este repo no define subagentes.

## 2. Opcional pero recomendado: Figma MCP

Permite que Claude Code lea medidas y estilos exactos del mockup:

```
claude mcp add --transport http figma https://mcp.figma.com/mcp
```

Después, dentro de Claude Code: `/mcp` → `figma` → **Authenticate** → **Allow access**. Si no se configura, Claude Code trabaja con `docs/diseno/README.md` y las capturas.

## 3. Lanzar

```
cd C:\catmetal
claude --permission-mode auto
```

- Si el modo `auto` no está disponible en tu plan o modelo, usa `claude --permission-mode acceptEdits`. Los comandos frecuentes ya están permitidos en `.claude/settings.json`.
- El modo `bypassPermissions` está deshabilitado a propósito en este proyecto.
- Elige el modelo más potente para el orquestador con `/model`.

## 4. Prompt (copiar y pegar)

```
Eres el arquitecto de software y orquestador de este proyecto. Lee completos CLAUDE.md, docs/spec.md y docs/diseno/README.md, y revisa las imágenes de docs/diseno/. Después:

1. Verifica los prerrequisitos (node, pnpm, git) y el estado del repo. Haz el commit de línea base en main y crea la rama build/v1, como indica CLAUDE.md.
2. Revisa qué subagentes tienes disponibles en esta máquina y registra en docs/progreso.md qué subagente cubre cada rol. No crees, edites ni copies subagentes.
3. Crea docs/preguntas-abiertas.md con las preguntas de la sección 12 de la spec, más las que detectes tú.
4. Ejecuta las Fases 0 a 6 completas en esta misma sesión, sin detenerte entre fases, siguiendo el bucle de trabajo de CLAUDE.md. Cuando haya que decidir, decide tú como arquitecto y registra la decisión en un ADR. El equipo revisará todo al final.
5. Haz un commit con Conventional Commits por cada tarea terminada, con los trailers Fase/Tarea/Agente. Nunca hagas push.
6. Al terminar la Fase 6, escribe docs/INFORME-FINAL.md, haz el commit final y termina.

Empieza ahora.
```

## 5. Durante la sesión

- **Ver el avance**: `docs/progreso.md`, y `git log --oneline` en otra terminal.
- **Pausar ordenadamente**: escribe "pausa" en Claude Code. Creará `docs/PAUSA.md` con el estado y se detendrá.
- **Detener de inmediato**: `Esc`. Para lanzar una sesión que sí pueda terminar sin informe final: `set CATMETAL_PERMITIR_PARAR=1` (cmd) o `$env:CATMETAL_PERMITIR_PARAR="1"` (PowerShell) antes de `claude`.
- **Si se agota el límite de uso o se cierra la terminal**: `claude --continue` y escribe "Continúa según docs/progreso.md y CLAUDE.md".
- El hook `no-parar` fuerza como máximo 60 continuaciones por sesión. Es una válvula de seguridad para que no se quede en un bucle.

## 6. Qué está bloqueado (y por quién)

| Acción | Bloqueo |
|---|---|
| `git push`, cambios de remotos, `gh` | Hook `guardia.mjs` + reglas `deny` |
| `--amend`, `rebase`, `reset --hard`, borrar ramas o tags | Hook `guardia.mjs` |
| Commits, add o cambios de rama hechos por subagentes | Hook `guardia.mjs` (detecta `agent_id`) |
| `wrangler deploy/versions/secret/login`, `--remote`, crear o borrar recursos, API de Cloudflare, credenciales | Hook `guardia.mjs` + reglas `deny` |
| Scripts `deploy`, `release`, `publish`, `remote`, `prod`, `staging` | Hook `guardia.mjs` |
| Editar `.claude/` (settings, hooks, agentes) | Hook `guardia.mjs` + reglas `deny` + ruta protegida de Claude Code |
| Terminar antes de `INFORME-FINAL`, `BLOQUEO` o `PAUSA` | Hook `no-parar.mjs` |

## 7. Después de la sesión (equipo)

```
git switch build/v1
git log --oneline main..build/v1
git tag -l "fase-*"
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

Lee `docs/INFORME-FINAL.md`, los ADR, `docs/desviaciones.md`, `docs/auditoria/` y `docs/pendientes-humanos.md`. Cuando lo aprueben, hagan el push:

```
git push -u origin main build/v1 --follow-tags
```

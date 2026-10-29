# Pendientes humanos

Acciones que el orquestador no puede o no debe ejecutar. Cada una lleva el comando exacto cuando aplica.

## Configuración de Claude Code

1. **Instalar `.claude/`** (paso 0 de `docs/ARRANQUE.md`, no se había hecho al lanzar la sesión). Los hooks `guardia.mjs` y `no-parar.mjs` no estuvieron activos durante la sesión; el orquestador cumplió sus reglas de forma voluntaria. En PowerShell, desde `C:\catmetal`:

   ```powershell
   New-Item -ItemType Directory -Force .claude\hooks | Out-Null
   Move-Item _mover-a-claude\settings.json .claude\settings.json -Force
   Move-Item _mover-a-claude\hooks\*.mjs .claude\hooks\ -Force
   Remove-Item _mover-a-claude -Recurse -Force
   ```

   Después, decidir si se versiona `.claude/` y se elimina `_mover-a-claude/` del repo con un commit.

## Identidad visual

2. Pedir al cliente el **logo oficial en SVG** (versión clara y oscura) y los íconos de la PWA (192, 512 y maskable). Mientras tanto se usan recursos provisionales.

## Git

3. Push de la rama y los tags cuando el equipo apruebe:

   ```
   git push -u origin main build/v1 --follow-tags
   ```

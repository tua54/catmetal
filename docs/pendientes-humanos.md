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

## Verificaciones en staging (cuando exista)

4. **Prueba de humo del clasificador de errores de D1** (revisión de la Fase 3, B3). Con la sesión de un supervisor asignado:
   1. `POST /api/v1/sync/push` con un `consumo.crear` y luego otro con un `mutation_id` nuevo, el mismo `payload.id` y otro `client_created_at` → la segunda debe responder `rechazada` `ID_DUPLICADO` (no quedar sin resultado ni registrar `sync_push_transitorio` en Workers Logs).
   2. `npx wrangler d1 execute mp-staging --env staging --remote --command "UPDATE audit_log SET accion = accion WHERE seq = (SELECT MIN(seq) FROM audit_log)"` → debe fallar con `audit_log es inmutable` y no modificar nada.
   3. Anotar los textos exactos de error de staging; si difieren del formato de `apps/worker/src/dominio/errores-d1.ts`, agregarlos como casos de prueba.
5. **Medir el login offline en la tablet real de planta** (ADR 0012): si la derivación del verificador (600.000 iteraciones) supera 2 s, bajar `ITERACIONES_VERIFICADOR` a 310.000. Referencia en E2E: Chromium ~280 ms, WebKit ~1,2–1,8 s en un PC de desarrollo.

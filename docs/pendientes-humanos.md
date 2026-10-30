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

## Despliegue (todo remoto; ninguno se ejecutó en la sesión)

Los comandos exactos, en orden, están en `docs/despliegue.md` (secciones 2 a 6). Resumen:

6. Activar el plan **Workers Paid** en la cuenta de Cloudflare.
7. Crear recursos por entorno (staging y producción): `npx wrangler d1 create mp-staging`, `npx wrangler r2 bucket create mp-evidencias-staging`, `npx wrangler r2 bucket create mp-backups-staging`, `npx wrangler r2 bucket lifecycle add mp-backups-staging backups-90d backups/ --expire-days 90`, `npx wrangler kv namespace create CONFIG_staging` (ídem `mp-prod`, `mp-evidencias-prod`, `mp-backups-prod`, `CONFIG_production`), y copiar los IDs a `apps/worker/wrangler.jsonc` (marcadores `REEMPLAZAR_CON_…`) con un commit.
8. Dominio de producción en `env.production.routes` (y opcionalmente de staging).
9. Secretos de 32 bytes: `npx wrangler secret put JWT_SECRET --env <entorno>` y `npx wrangler secret put REFRESH_SECRET --env <entorno>`.
10. Migraciones: `npx wrangler d1 migrations apply mp-staging --env staging --remote` (ídem `mp-prod --env production`).
11. Primer admin: `node scripts/crear-admin-sql.mjs …` (local) y `npx wrangler d1 execute mp-staging --env staging --remote --file=…`.
12. Desplegar: `pnpm --filter @catmetal/web build` y `npx wrangler deploy --env staging` (o el workflow `deploy-staging`), y luego `--env production`.
13. GitHub: environment `staging` protegido con revisores y secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
14. Política MDM de las tablets: sin depuración USB y con bloqueo de pantalla del sistema (ADR 0017).
15. Opcional: Cloudflare Access para `/admin*` y `/api/v1/users*` (probar en staging).
16. Revisión de seguridad final (F6-01): usar una cuenta de Cloudflare separada para staging o un token de CI sin alcance sobre producción; environment `staging` en GitHub con política de ramas (solo `main`), revisores y sin auto-aprobación.
17. Revisar las 14 verificaciones de staging de `docs/auditoria/seguridad-fase-6.md` (sección 6) antes de producción.

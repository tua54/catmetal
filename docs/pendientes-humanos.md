# Pendientes humanos

Acciones que el orquestador no puede o no debe ejecutar. Cada una lleva el comando exacto cuando aplica.

## Configuración de Claude Code

Ninguno. `.claude/` quedó instalado y versionado (C1, `5e5cdcf`); el ajuste de `guardia.mjs` para la sesión principal con agente global lo hizo el equipo.

## Identidad visual

2. Pedir al cliente el **logo oficial en SVG** (versión clara y oscura) y los íconos de la PWA (192, 512 y maskable). Mientras tanto se usan recursos provisionales.

## Git

3. Push de la rama y los tags cuando el equipo apruebe:

   ```
   git push -u origin main build/v1 fix/auditoria-v1 --follow-tags
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

## Verificaciones en tablet real (correcciones v1.1)

- **Duración del reemplazo del snapshot (M5, ADR 0022).** Medir en la tablet de planta, en Chromium y en Safari, cuánto tarda `completarSnapshot` con la partición de un jefe (decenas de miles de consumos). En fake-indexeddb, 10.000 consumos tardan 3,3-4,9 s, pero esa implementación es O(n) por actualización y no representa al navegador. Si supera unos 3 s, hay que optimizar el recálculo.

## Verificaciones en staging (correcciones v1.1)

- **D1 remota (M3/M4)**: en un ensayo de restauración en staging, verificar que exista `octet_length`, el límite de 100 KB por sentencia, el tope de 5 términos por `UNION ALL`, si `wrangler d1 execute --file` es atómico y que `PRAGMA foreign_key_check` funcione. Los resultados van a `docs/notas-plataforma.md`.
- **Rate limit de `/sync/push` (ADR 0020, D.4)**: evaluar un binding de Rate Limiting por usuario para el push.

## Verificaciones en staging (correcciones v1.2)

- **Marca de escritura (A1, ADR 0028)**:
  1. Aplicar `migrations/0009_marca_de_escritura.sql` en la D1 de staging (`pnpm` / `wrangler d1 migrations apply` del entorno, sección 4 de `docs/despliegue.md`) y comprobar con `PRAGMA table_info(<tabla>)` que las 11 tablas tienen `escritura_id` y que `sqlite_master` conserva todos los triggers.
  2. Repetir contra staging la prueba de B4: 5 subidas simultáneas de la misma foto deben dejar **una** fila `evidencia.subida`. Y dos ediciones concurrentes del mismo consumo con la misma `version`: una responde 200, otra 409, y queda **una** fila `consumo.editar`.
  3. Ejecutar las consultas de detección de `docs/despliegue.md` §9.5 sobre la base de staging (creada con la v1.0/v1.1) y registrar el resultado.
  4. Confirmar que los batches de D1 remota son atómicos y serializables (premisa de las ADR 0010 y 0028), con el punto 2.

## Seguridad (revisión de las correcciones v1.1)

- **S-08 (anterior a la v1.1)**: `mp_refresh` se lee con `getCookie` (una sola aparición) y solo se borra la del host. Un subdominio hermano de `catmetal.com` podría plantar otra con `Domain=` para forzar un cierre de sesión o fijar una sesión. Mitigación recomendada: no delegar subdominios de `catmetal.com` a terceros, o servir la app desde un dominio propio. Si no, aplicar la misma lectura robusta de `mp_dispositivo` (ADR 0018) a `mp_refresh` en una versión futura.
- **Crecimiento de `audit_log` (S-01, ADR 0018)**: los bloqueos de login se auditan todos (spec §5 d), como máximo unas 5 filas por cuenta cada 15 min si hay un ataque sostenido. Conviene una alerta en Workers Logs si `tamano_base` o el conteo diario de `audit_log` crecen más de lo esperado.

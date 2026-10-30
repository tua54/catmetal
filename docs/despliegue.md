# Guía de despliegue — Control de Materia Prima · Catmetal

> **Ningún comando de esta guía se ejecutó durante la construcción.** Todos los comandos remotos los ejecuta una persona del equipo con credenciales de la cuenta de Cloudflare. Los comandos se verificaron contra la documentación oficial de Cloudflare y el código de Wrangler 4.156.0 (2026-10-29). Se ejecutan desde `apps/worker` salvo que se indique otra cosa; en Windows funcionan igual en PowerShell y en cmd.

## 1. Requisitos

- **Plan Workers Paid** (obligatorio): D1 de hasta 10 GB, Time Travel de 30 días (7 en Free), 1000 consultas D1 por invocación, CPU de cron de hasta 15 min con intervalo ≥ 1 h. Referencias: https://developers.cloudflare.com/workers/platform/limits/ y https://developers.cloudflare.com/d1/platform/limits/
- Una zona (dominio) activa en Cloudflare para producción (y opcionalmente para staging).
- Node 22+ y pnpm (ver `README.md`), `pnpm install` hecho en el repositorio.
- Iniciar sesión en Wrangler con una cuenta autorizada: `npx wrangler login` (o variables `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`).

Entornos (`apps/worker/wrangler.jsonc`): nivel superior = desarrollo local; `env.staging` → Worker `catmetal-mp-staging`; `env.production` → Worker `catmetal-mp-production`. Los bindings, `vars` y `secrets.required` se repiten por entorno (no se heredan); `assets`, `triggers` (crons) y `observability` sí se heredan.

## 2. Crear los recursos (una vez por entorno)

Ejemplo para **staging**; para **producción** cambie `staging` por `prod`/`production` en nombres y `--env`.

```powershell
# D1 (responda "No" si ofrece añadirlo al wrangler.jsonc: se copia a mano en env.staging)
npx wrangler d1 create mp-staging --location=wnam
# → copie el "database_id" a env.staging.d1_databases[0].database_id (reemplaza REEMPLAZAR_CON_ID_D1_STAGING)

# R2 (privado; evidencias en evidencias/, backups en backups/)
npx wrangler r2 bucket create mp-evidencias-staging

# Regla de ciclo de vida: los backups expiran a los 90 días (spec §4). Las subidas multipart
# incompletas ya se abortan a los 7 días por la regla por defecto del bucket.
npx wrangler r2 bucket lifecycle add mp-evidencias-staging backups-90d backups/ --expire-days 90
npx wrangler r2 bucket lifecycle list mp-evidencias-staging

# KV (solo caché opcional)
npx wrangler kv namespace create CONFIG_staging
# → copie el "id" a env.staging.kv_namespaces[0].id (reemplaza REEMPLAZAR_CON_ID_KV_STAGING)
```

- **Rate limiting**: no se crea nada en la cuenta; basta el `namespace_id` único del `wrangler.jsonc` (1002 staging, 1003 producción).
- **Dominio de producción**: en `env.production` descomente `routes` y ponga el dominio (`{ "pattern": "mp.catmetal.com", "custom_domain": true }`). Producción tiene `workers_dev: false` y `preview_urls: false`. Staging se publica en `catmetal-mp-staging.<subdominio>.workers.dev` hasta que se le asigne un dominio propio (en ese caso, añadir su `routes` en `env.staging` y poner `workers_dev: false`).
- Confirme los cambios del `wrangler.jsonc` con un commit (solo IDs y dominio; nunca secretos).

## 3. Secretos (por entorno)

Genere cada secreto con 32 bytes aleatorios (regla H-07: al menos 43 caracteres y distintos entre sí; el Worker responde 500 si no se cumple):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put JWT_SECRET --env staging
npx wrangler secret put REFRESH_SECRET --env staging
npx wrangler secret list --env staging
```

- `secret put` crea y despliega una versión nueva del Worker al instante.
- Rotar `REFRESH_SECRET` cierra todas las sesiones (todos vuelven a iniciar sesión con conexión); rotar `JWT_SECRET` invalida los access tokens vigentes (15 min).
- Nunca guarde los valores en archivos versionados. `SEED_PASSWORD` es solo para desarrollo local.

## 4. Migraciones de la base

```powershell
npx wrangler d1 migrations list mp-staging --env staging --remote
npx wrangler d1 migrations apply mp-staging --env staging --remote
```

- Aplica en orden las migraciones de `/migrations` (0000 esquema, 0001 y 0004 triggers, 0002 configuración inicial con `tolerancia_pct = 5` y una `sync_epoca` aleatoria, 0003, 0005 y 0006 índices).
- Pide confirmación; antes toma un backup automático. Si una migración falla, se revierte y queda aplicada la última exitosa.
- No ejecute `drizzle-kit migrate` ni `push` (irían por HTTP sin el control de `wrangler`).

## 5. Primer administrador

El seed de desarrollo no se usa en staging ni producción. El primer admin se crea con un SQL generado **localmente**:

```powershell
$env:ADMIN_PASSWORD = '<contraseña de al menos 10 caracteres>'
node ../../scripts/crear-admin-sql.mjs --email admin@catmetal.com --nombre "Nombre Apellido" --salida .\primer-admin.sql
Remove-Item Env:ADMIN_PASSWORD
npx wrangler d1 execute mp-staging --env staging --remote --file=.\primer-admin.sql
Remove-Item .\primer-admin.sql
```

El archivo contiene el hash de la contraseña: no lo versione y bórrelo. Desde la app, el admin crea los demás usuarios, materiales y asignaciones.

## 6. Desplegar

```powershell
pnpm --filter @catmetal/web build
npx wrangler deploy --env staging
```

- O desde GitHub Actions: workflow **`deploy-staging`** (solo `workflow_dispatch`, con el environment protegido `staging`). Configure en GitHub: Settings → Environments → `staging` con revisores obligatorios y los secretos `CLOUDFLARE_API_TOKEN` (permisos de cuenta: Workers Scripts, D1, Workers R2 Storage y Workers KV Storage en edición, Account Settings lectura; de zona: Workers Routes si usa `routes`) y `CLOUDFLARE_ACCOUNT_ID`.
- **Producción** no tiene workflow automático: se despliega a mano con `npx wrangler deploy --env production` tras validar staging.

### Verificación después de desplegar

1. `GET https://<host>/api/v1/health` → `{"ok":true,"entorno":"staging",…}` con cabeceras CSP, HSTS, `nosniff`.
2. Iniciar sesión con el admin, crear un supervisor y un jefe, una orden con materiales planeados, asignar el supervisor.
3. Desde una tablet: instalar la PWA, registrar un consumo con conexión y otro sin conexión (modo avión) con foto; reconectar y comprobar en la cola del jefe.
4. Pruebas de humo de `docs/pendientes-humanos.md` (clasificador de errores de D1, inmutabilidad de `audit_log`).
5. Medir el login offline en la tablet real (ADR 0012/0017).

## 7. Observabilidad

- Workers Logs habilitado con `invocation_logs: false` (las trazas automáticas podrían incluir cabeceras sensibles); quedan los logs estructurados del Worker (`console.log(JSON.stringify(...))`) sin datos personales ni secretos. Retención de Workers Logs: 7 días (Paid).
- Alertas a revisar en los logs: `backup_incompleto_del_dia`, `backup_fallido`, `secretos_invalidos`, `sync_mutation_no_registrada`, `sync_push_transitorio`, `error_no_controlado`.

## 8. Backups

- **Primera línea: Time Travel de D1** (30 días en Paid), sin configuración.
- **Backup diario a R2** (cron `0 8 * * *` = 03:00 Bogotá, con continuaciones `0 9-13 * * *`): cada tabla en NDJSON comprimido en `backups/AAAA-MM-DD/<tabla>.ndjson.gz` + `manifest.json` (conteos, bytes, sha256, época, `seq_inicial`, `seq_final`, última migración). Un día sin `manifest.json` es un backup **incompleto** (log `backup_incompleto_del_dia`). Retención: 90 días por la regla de ciclo de vida (sección 2). ADR 0014 y 0016.
- El backup contiene datos personales y hashes de contraseñas: el bucket es privado y solo el Worker y las personas autorizadas acceden.

## 9. Restaurar

### 9.1 Con Time Travel (preferido)

```powershell
npx wrangler d1 time-travel info mp-prod --env production                     # anote el bookmark ACTUAL (para deshacer)
npx wrangler d1 time-travel info mp-prod --env production --timestamp=2026-11-02T13:00:00Z
npx wrangler d1 time-travel restore mp-prod --env production --timestamp=2026-11-02T13:00:00Z
# Deshacer: npx wrangler d1 time-travel restore mp-prod --env production --bookmark=<bookmark anterior>
```

- Sobrescribe la base en su lugar y cancela las consultas en curso (avise a planta; mejor fuera de turno). Límite: 10 restauraciones cada 10 minutos.
- **No restaure a un punto anterior a 30 días** (la retención de mutaciones en las tablets, ADR 0016): lo registrado entre ese punto y la retención de la tablet se perdería en ambos lados.
- **Después de restaurar, cambie la época de sync** para que todas las tablets reenvíen lo que el servidor perdió (ADR 0009/0016):

```powershell
npx wrangler d1 execute mp-prod --env production --remote --command "UPDATE settings SET valor = json_quote(lower(hex(randomblob(16)))), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE clave = 'sync_epoca'; INSERT INTO audit_log (id, entidad, entidad_id, accion, actor_id, device_id, datos_antes, datos_despues, client_at, server_at, alerta_reloj, created_at, updated_at) SELECT lower(hex(randomblob(16))), 'settings', 'sync_epoca', 'settings.epoca_restauracion', NULL, NULL, NULL, json_object('clave', clave, 'valor', json(valor)), NULL, updated_at, 0, updated_at, updated_at FROM settings WHERE clave = 'sync_epoca'"
```

  (El valor solo debe ser distinto del anterior; el trigger `settings_valores_validos` exige un texto JSON. El comando escribe también su fila de auditoría. Probado contra una D1 local con todas las migraciones.)

- Verifique después la coherencia (sección 9.3) y reconcilie las evidencias (sección 9.4).

### 9.2 Desde el backup en R2 (si Time Travel no alcanza)

Procedimiento (revisión de esquema H9 y M2; ADR 0014):

1. Elija una fecha con `manifest.json` (sin manifest, el backup está incompleto).
2. Descargue el prefijo (por cada archivo del manifest):
   ```powershell
   npx wrangler r2 object get mp-evidencias-prod/backups/2026-11-02/manifest.json --file .\restaurar\manifest.json --remote
   npx wrangler r2 object get mp-evidencias-prod/backups/2026-11-02/consumptions.ndjson.gz --file .\restaurar\consumptions.ndjson.gz --remote
   ```
3. Verifique `bytes` y `sha256` de cada archivo contra el manifest. Descomprima con `gunzip`/`zcat` o `zlib` de Node (leen los archivos de varios miembros gzip; `DecompressionStream` de workerd no).
4. Cree una D1 vacía (`wrangler d1 create`) y aplique las migraciones hasta `ultima_migracion` del manifest.
5. Guarde el SQL de todos los triggers (`SELECT sql FROM sqlite_master WHERE type = 'trigger'`) y elimínelos (`DROP TRIGGER …`).
6. Vacíe `settings` y `audit_log`, que la migración 0002 deja sembradas.
7. Cargue las tablas en el **orden inverso** al del manifest (`users`, …, `audit_log`) con `PRAGMA defer_foreign_keys = on` en cada lote, con los valores tal cual (incluido `seq`).
8. Vuelva a crear los triggers con el SQL guardado.
9. Verifique conteos contra el manifest y ejecute `PRAGMA foreign_key_check`.
10. Cambie `settings.sync_epoca` (sección 9.1).
11. Apunte el binding del entorno a la base nueva (`database_id` en `wrangler.jsonc`), despliegue y verifique (sección 9.3).

### 9.3 Verificaciones después de restaurar

```sql
-- Consumos decididos sin su validación (no deberían existir)
SELECT c.id FROM consumptions c WHERE c.estado <> 'pendiente'
  AND NOT EXISTS (SELECT 1 FROM validations v WHERE v.consumption_id = c.id);
-- Consumos sin auditoría (posibles en un backup de R2: el backup no es una foto de un instante)
SELECT c.id FROM consumptions c
  WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.entidad = 'consumptions' AND a.entidad_id = c.id);
```

Las tablets reenvían lo que tengan; el servidor reconoce por **clave natural** (mismo autor, orden, material y hora del cliente) lo que ya existe sin su registro de sincronización (ADR 0016).

### 9.4 Reconciliar evidencias

R2 no se restaura con D1: tras una restauración puede haber evidencias con `subido = 0` cuyo objeto sí está en R2. Liste los candidatos y, para cada uno, compruebe el objeto (`wrangler r2 object get … --remote`) y su sha256; si coincide, la tablet lo resubirá (idempotente) o puede marcarse manualmente con un `UPDATE evidences SET subido = 1, subido_at = …` acompañado de su fila de auditoría.

```sql
SELECT id, storage_key, sha256 FROM evidences WHERE subido = 0;
```

## 10. Datos personales (Ley 1581 de 2012)

| Dato | Dónde | Para qué | Retención |
|---|---|---|---|
| Nombre, correo, rol, hash de contraseña (PBKDF2) | D1 `users` | Autenticación y trazabilidad | Mientras exista la cuenta (se desactiva, no se borra) |
| Nombre de dispositivo, navegador (`user_agent` truncado), `instalacion_id` | D1 `devices` | "Desde qué dispositivo" (spec §1) | Indefinida (trazabilidad) |
| Autoría y hora de cada acción (sin correo) | D1 `audit_log` | Trazabilidad completa | Inmutable, indefinida |
| Fotos de evidencia (JPEG recomprimido, sin EXIF/GPS) | R2 `evidencias/` | Justificar novedades | Indefinida (pregunta abierta P7) |
| Backups (todas las tablas) | R2 `backups/` | Recuperación | 90 días |
| IP | No se guarda (solo clave efímera del rate limiter) | — | — |
| En la tablet: perfil (nombre, correo, permisos, verificador), datos de la operación | IndexedDB | Trabajo sin conexión | 30 días sin acceso y sin pendientes (ADR 0017) |

Pendiente del cliente (P7): política de retención de evidencias y de datos personales, y procedimiento de rectificación/supresión (la auditoría es inmutable por diseño; no copia correos).

## 11. Cloudflare Access para administración (opcional)

Para añadir una capa de identidad corporativa delante de la administración: Zero Trust → Access → Applications → Self-hosted, con el dominio de producción y rutas `/admin*` y `/api/v1/users*` (y opcionalmente `/api/v1/materials`, `/api/v1/settings*`), política Allow para el grupo de administradores. Requiere dominio propio (no `workers.dev`). **Probar primero en staging**: las llamadas `fetch` de la PWA que reciban la redirección de Access fallan, por lo que conviene limitar la regla a las rutas de admin y verificar que el supervisor y el jefe no se ven afectados.

## 12. Checklist de despliegue

- [ ] Plan Workers Paid activo en la cuenta.
- [ ] D1, R2 (con regla de 90 días en `backups/`) y KV creados para staging y producción; IDs copiados al `wrangler.jsonc` y confirmados en git.
- [ ] Dominio de producción en `env.production.routes` (y de staging, si aplica).
- [ ] Secretos `JWT_SECRET` y `REFRESH_SECRET` de 32 bytes cargados en cada entorno.
- [ ] Migraciones aplicadas (`migrations list` sin pendientes).
- [ ] Primer administrador creado; archivo SQL borrado.
- [ ] Environment `staging` protegido en GitHub con revisores y secretos `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`.
- [ ] Despliegue de staging y verificación de la sección 6 (incluidas pruebas de humo y medición en tablet).
- [ ] Primer backup diario con `manifest.json` revisado en R2 al día siguiente.
- [ ] Logs revisados: sin `secretos_invalidos` ni `backup_incompleto_del_dia`.
- [ ] Logo SVG oficial e íconos de la PWA del cliente (pendiente humano).
- [ ] Política MDM de las tablets (sin depuración USB, bloqueo de pantalla del sistema; ADR 0017).
- [ ] Despliegue a producción y repetición de la verificación.

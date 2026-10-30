# Guía de despliegue — Control de Materia Prima · Catmetal

> **Ningún comando de esta guía se ejecutó durante la construcción.** Todos los comandos remotos los ejecuta una persona del equipo con credenciales de la cuenta de Cloudflare. Los comandos se verificaron contra la documentación oficial de Cloudflare y el código de Wrangler 4.156.0 (2026-10-29). Se ejecutan desde `apps/worker` salvo que se indique otra cosa; en Windows funcionan igual en PowerShell y en cmd.

## 1. Requisitos

- **Plan Workers Paid** (obligatorio): D1 de hasta 10 GB, Time Travel de 30 días (7 en Free), 1000 consultas D1 por invocación, CPU de cron de hasta 15 min con intervalo ≥ 1 h. Referencias: https://developers.cloudflare.com/workers/platform/limits/ y https://developers.cloudflare.com/d1/platform/limits/
- Una zona (dominio) activa en Cloudflare para producción (y opcionalmente para staging).
- Node 24 o superior y pnpm (ver `README.md`), `pnpm install` hecho en el repositorio.
- Iniciar sesión en Wrangler con una cuenta autorizada: `npx wrangler login` (o variables `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`).

Entornos (`apps/worker/wrangler.jsonc`): nivel superior = desarrollo local; `env.staging` → Worker `catmetal-mp-staging`; `env.production` → Worker `catmetal-mp-production`. Los bindings, `vars` y `secrets.required` se repiten por entorno (no se heredan); `assets`, `triggers` (crons) y `observability` sí se heredan.

## 2. Crear los recursos (una vez por entorno)

Ejemplo para **staging**; para **producción** cambie `staging` por `prod`/`production` en nombres y `--env`.

```powershell
# D1 (responda "No" si ofrece añadirlo al wrangler.jsonc: se copia a mano en env.staging)
npx wrangler d1 create mp-staging --location=wnam
# → copie el "database_id" a env.staging.d1_databases[0].database_id (reemplaza REEMPLAZAR_CON_ID_D1_STAGING)

# R2 privado para las evidencias (fotos)
npx wrangler r2 bucket create mp-evidencias-staging

# R2 privado y SEPARADO para los backups (contienen hashes y datos personales; F6-08)
npx wrangler r2 bucket create mp-backups-staging
# Regla de ciclo de vida: los backups expiran a los 90 días (spec §4). Las subidas multipart
# incompletas ya se abortan a los 7 días por la regla por defecto del bucket.
npx wrangler r2 bucket lifecycle add mp-backups-staging backups-90d backups/ --expire-days 90
npx wrangler r2 bucket lifecycle list mp-backups-staging

# KV (solo caché opcional)
npx wrangler kv namespace create CONFIG_staging
# → copie el "id" a env.staging.kv_namespaces[0].id (reemplaza REEMPLAZAR_CON_ID_KV_STAGING)
```

- **Rate limiting**: no se crea nada en la cuenta; basta el `namespace_id` único del `wrangler.jsonc` (1002 staging, 1003 producción).
- **Dominio de producción**: en `env.production` descomente `routes` y ponga el dominio (`{ "pattern": "mp.catmetal.com", "custom_domain": true }`). Producción tiene `workers_dev: false` y `preview_urls: false`. Staging se publica en `catmetal-mp-staging.<subdominio>.workers.dev` hasta que se le asigne un dominio propio (en ese caso, añadir su `routes` en `env.staging` y poner `workers_dev: false`).
- Confirme los cambios del `wrangler.jsonc` con un commit (solo IDs y dominio; nunca secretos).

## 3. Secretos (por entorno)

Genere cada secreto con 32 bytes aleatorios (regla H-07: al menos 43 caracteres y distintos entre sí; el Worker responde 500 si no se cumple):

El valor se genera y se pasa por tubería, sin mostrarlo en pantalla (revisión de seguridad F6-03):

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put JWT_SECRET --env staging
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put REFRESH_SECRET --env staging
npx wrangler secret list --env staging
```

- `secret put` crea y despliega una versión nueva del Worker al instante.
- Rotar `REFRESH_SECRET` cierra todas las sesiones (todos vuelven a iniciar sesión con conexión); rotar `JWT_SECRET` invalida los access tokens vigentes (15 min).
- **Rotar `REFRESH_SECRET` también hace que todos los dispositivos dejen de ser conocidos** (ADR 0018, enmienda 2): la firma de la cookie `mp_dispositivo` usa una clave derivada de ese secreto. Hasta su próximo login correcto con contraseña, cada tablet cuenta como origen desconocido y queda sujeta al tope global `g` de su cuenta.
  - **Cuándo**: ante sospecha de filtración del secreto, después de una restauración por incidente de seguridad (§9.2) o como mantenimiento planificado. **Nunca durante un ataque de adivinanza de contraseñas en curso** (muchos `login_cupos.bloqueado` en la auditoría): quitaría a los usuarios legítimos la protección de su dispositivo conocido.
  - **Cómo mitigarlo**: avise antes a planta (todos inician sesión otra vez, con conexión, y conviene hacerlo de forma escalonada) y tenga a mano el desbloqueo del admin (`PATCH /users/:id` con `desbloquear`) y el de emergencia (§5.1).
  - Desde la v1.2, un refresh exitoso renueva o emite la cookie, así que una tablet con sesión viva la recupera sola. Tras una rotación eso no ocurre, porque la rotación cierra las sesiones.
- Nunca guarde los valores en archivos versionados. `SEED_PASSWORD` es solo para desarrollo local.

## 4. Migraciones de la base

```powershell
npx wrangler d1 migrations list mp-staging --env staging --remote
npx wrangler d1 migrations apply mp-staging --env staging --remote
```

- Aplica en orden las migraciones de `/migrations` (0000 esquema, 0001 y 0004 triggers, 0002 configuración inicial con `tolerancia_pct = 5` y una `sync_epoca` aleatoria, 0003, 0005 y 0006 índices, 0007 cupos de login, 0008 settings válidos en INSERT, 0009 marca de escritura `escritura_id`).
- **La 0009 (v1.2, ADR 0028) se aplica antes de desplegar el Worker v1.2**: ese Worker escribe `escritura_id` y fallaría con `no such column` sobre una base sin ella. El workflow de staging ya aplica las migraciones antes del `deploy`. Aplique la migración y despliegue seguidos: en el intervalo, el cron de backup de la v1.1 exportaría la columna nueva (inocuo: la restauración la ignora).
- Pide confirmación; antes toma un backup automático. Si una migración falla, se revierte y queda aplicada la última exitosa.
- No ejecute `drizzle-kit migrate` ni `push` (irían por HTTP sin el control de `wrangler`).

## 5. Primer administrador

El seed de desarrollo no se usa en staging ni producción. El primer admin se crea con un SQL generado **localmente**:

```powershell
# Contraseña con entrada oculta: no queda en pantalla ni en el historial de PowerShell (F6-03).
$s = Read-Host -AsSecureString 'Contraseña del primer admin (mínimo 10 caracteres)'
$env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
# Sin --salida, el SQL se escribe en la carpeta temporal del sistema, FUERA del repositorio.
node ../../scripts/crear-admin-sql.mjs --email admin@catmetal.com --nombre "Nombre Apellido"
Remove-Item Env:ADMIN_PASSWORD; Remove-Variable s
npx wrangler d1 execute mp-staging --env staging --remote --file="$env:TEMP\catmetal-primer-admin.sql"
Remove-Item "$env:TEMP\catmetal-primer-admin.sql"
```

El archivo contiene el hash de la contraseña: nunca lo guarde dentro del repositorio (por si acaso, `primer-admin.sql` y `*-primer-admin.sql` están en `.gitignore`) y bórrelo tras aplicarlo. La contraseña no puede estar en la lista de contraseñas comunes. Desde la app, el admin crea los demás usuarios, materiales y asignaciones.

### 5.1 Desbloqueo de emergencia del login (ADR 0018)

Úselo cuando ningún admin puede entrar, por ejemplo porque todos sus orígenes quedaron con el cupo de login agotado. Antes, intente entrar desde la tablet o el PC donde esa persona ya inició sesión (dispositivo conocido): los fallos de otros orígenes no afectan su cupo.

El script **no** se conecta a Cloudflare: solo escribe un archivo `.sql` local. Ese archivo:

- reinicia todos los cupos de `login_cupos` del usuario (dispositivos, orígenes y el tope global) y las columnas heredadas `users.intentos_fallidos` y `bloqueado_hasta`;
- inserta su fila de auditoría `login_cupos.desbloqueo_emergencia`, sin el correo;
- no usa `DELETE` y no hace nada si el correo no existe;
- es idempotente: aplicarlo dos veces no cambia nada más;
- desde la v1.2 fija una marca de escritura nueva en `users` (N2, ADR 0028). **Genere el archivo en el momento de usarlo**: uno generado con una versión anterior no la fija, y uno de la v1.2 necesita la migración 0009 aplicada.

Desde `apps/worker`:

```powershell
# Sin --salida, el SQL se escribe en la carpeta temporal del sistema, FUERA del repositorio.
node ../../scripts/desbloqueo-emergencia-sql.mjs --email admin@catmetal.com
# Ensayo opcional contra la base local:
npx wrangler d1 execute DB --local --file="$env:TEMP\catmetal-desbloqueo-emergencia.sql"
# Staging (producción: mp-prod --env production):
npx wrangler d1 execute mp-staging --env staging --remote --file="$env:TEMP\catmetal-desbloqueo-emergencia.sql"
Remove-Item "$env:TEMP\catmetal-desbloqueo-emergencia.sql"
```

En Linux o macOS, el archivo queda en `$(node -p "require('os').tmpdir()")/catmetal-desbloqueo-emergencia.sql`, o donde indique `--salida`. **El archivo contiene el correo en claro (S-07): bórrelo apenas lo aplique**, como hace el último comando de arriba. Después, la persona entra con su contraseña desde cualquier dispositivo. Si el ataque continúa, conviene que entre desde un dispositivo conocido.

## 6. Desplegar

```powershell
pnpm --filter @catmetal/web build
npx wrangler deploy --env staging
```

- O desde GitHub Actions: workflow **`deploy-staging`** (solo `workflow_dispatch`, acciones fijadas por SHA, con el environment protegido `staging`). **Revisión de seguridad F6-01**:
  - Use una **cuenta de Cloudflare separada para staging** o, si no es posible, un token que **no alcance producción** (verifique en la consola qué recursos cubre; un token de cuenta con edición de Workers/D1/R2 alcanza todos los de la cuenta).
  - Token mínimo y con caducidad: permisos de cuenta Workers Scripts, D1, Workers R2 Storage y Workers KV Storage (edición), Account Settings (lectura); de zona, Workers Routes solo si usa `routes`.
  - GitHub: Settings → Environments → `staging` con revisores obligatorios, sin auto-aprobación y política de ramas de despliegue (solo `main`); secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` solo en ese environment.
- **Producción** no tiene workflow automático: se despliega a mano con `npx wrangler deploy --env production` tras validar staging.
- **Versión mínima del cliente (B5, ADR 0026).** `VERSION_MINIMA_CLIENTE` (`vars` de `wrangler.jsonc`) vale `"1"` y no bloquea a nadie. **No la suba a 2 o más** hasta confirmar que todas las tablets corren una versión que manda `X-Version-Cliente` (la v1.1 completa). Si no, todas reciben 426 y dejan de sincronizar; los pendientes se conservan, pero no salen (S-12). Un valor mal escrito vale 1 y no bloquea.
- **Primer despliegue de la v1.1 sobre una base con sesiones (B1).** Las familias de refresh vencen ahora a los 30 días del login con contraseña, aunque se hayan rotado. Las familias que ya tengan más de 30 días piden la contraseña en su siguiente refresco, en un inicio de sesión masivo que ocurre una sola vez. El outbox de las tablets no se pierde: las mutaciones esperan a la nueva sesión. Conviene avisar a los supervisores antes de desplegar.
- **Primer despliegue de la v1.2 (A6, ADR 0029).** El token de página del snapshot pasa a la versión 3, ligada al usuario y al rol. Una descarga de snapshot que esté a medias en una tablet se rechaza una vez y vuelve a empezar desde cero, sin tocar el outbox ni los datos vivos. Los clientes v1.1 ya lo manejan así.
- **Orden en la v1.2**: aplique la migración 0009 (§4) y despliegue el Worker inmediatamente después.

### Verificación después de desplegar

1. `GET https://<host>/api/v1/health` → `{"ok":true,"entorno":"staging",…}` con cabeceras CSP, HSTS, `nosniff`.
2. Iniciar sesión con el admin, crear un supervisor y un jefe, una orden con materiales planeados, asignar el supervisor.
3. Desde una tablet: instalar la PWA, registrar un consumo con conexión y otro sin conexión (modo avión) con foto; reconectar y comprobar en la cola del jefe.
4. Pruebas de humo de `docs/pendientes-humanos.md` (clasificador de errores de D1, inmutabilidad de `audit_log`).
5. Medir el login offline en la tablet real (ADR 0012/0017).

## 7. Observabilidad

- Workers Logs habilitado con `invocation_logs: false` (las trazas automáticas podrían incluir cabeceras sensibles); quedan los logs estructurados del Worker (`console.log(JSON.stringify(...))`) sin datos personales ni secretos. Retención de Workers Logs: 7 días (Paid).
- Alertas a revisar en los logs: `backup_incompleto_del_dia`, `backup_fallido`, `backup_tabla_incompleta`, `backup_parcial`, `secretos_invalidos`, `sync_mutation_no_registrada`, `sync_push_transitorio`, `error_no_controlado`.
  - `backup_tabla_incompleta` (con `tabla`, `intentos` y `motivo`): una tabla falló `MAX_INTENTOS_TABLA` = 3 veces seguidas sin avanzar y el backup siguió con las demás (ADR 0020).
  - `backup_parcial` (con `tablas_incompletas`, separadas por coma): el backup del día terminó, pero sin esas tablas. Solo es restaurable si las incompletas son `sync_mutations` o `refresh_tokens` (sección 9.2). `login_cupos` nunca aparece: no se exporta (S-06). Investigue el `motivo` el mismo día.
  - `backup_no_restaurable` (con `tablas`): un backup `parcial` con alguna tabla incompleta que la restauración no admite. Ese día solo se puede restaurar con Time Travel. Es urgente (revisión de esquema R-03).
  - `backup_sin_octet_length` (aviso): D1 no tiene `octet_length`. El backup midió las filas con `length(CAST(col AS BLOB))` y siguió normalmente; anótelo en `docs/notas-plataforma.md`.

## 8. Backups

- **Primera línea: Time Travel de D1** (30 días en Paid), sin configuración.
- **Backup diario a R2**, en el bucket propio `mp-backups-*` (binding `BACKUPS`), separado de las evidencias (cron `0 8 * * *` = 03:00 Bogotá, con continuaciones `0 9-13 * * *`): cada tabla en NDJSON comprimido en `backups/AAAA-MM-DD/<tabla>.ndjson.gz` + `manifest.json`. Retención: 90 días por la regla de ciclo de vida (sección 2). ADR 0014, 0016, 0020 y 0021.
  - El manifest (`formato: 2`) trae `estado` (`completo` o `parcial`), la marca de corte `corte` (`seq` = `MAX(audit_log.seq)` al empezar y la hora), `seq_final`, la época, la última migración y, por tabla, su `estado` (`completa` con conteo, bytes, sha256 y `segmentos_gzip`, o `incompleta` con `motivo` e `intentos`).
  - `audit_log` se exporta **al final** y hasta `seq_final`: así el backup permite reconstruir el estado exacto en el corte (sección 9.2).
  - Cada página se acota a 2000 filas **y** a 4 MiB (medidos en SQL con `octet_length`), y se escribe al compresor por partes: una tabla con filas grandes ya no agota la memoria del Worker (ADR 0020).
  - Un día sin `manifest.json` es un backup **sin terminar** (log `backup_incompleto_del_dia`). Un manifest `parcial` es un backup terminado sin alguna tabla (log `backup_parcial`).
  - Riesgo vigilado: `audit_log` es la tabla más grande y va al final de la ventana. Si no termina antes de las 13:00 UTC, el día queda sin manifest. Revise `backup_resumen` (operaciones y tabla en curso) si el tamaño de la base crece mucho.
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

Procedimiento (ADR 0021, que reemplaza el de la revisión de esquema H9). La base restaurada queda **exactamente como estaba en el corte** del backup (`manifest.corte`): lo que se escribió durante la ventana del backup se pierde en el servidor, igual que todo lo posterior. Las tablets lo reenvían tras el cambio de época, y lo hecho por REST queda listado en el informe para rehacerlo.

1. **Elija la fecha.** El `manifest.json` debe tener `formato: 2` y `estado: 'completo'`, o `estado: 'parcial'` con solo `sync_mutations` o `refresh_tokens` incompletas (`INCOMPLETAS_ADMITIDAS` de `scripts/restauracion-nucleo.mjs`). `login_cupos` no se exporta desde S-06, así que nunca figura entre las incompletas. Sin manifest, el backup está sin terminar. Los backups de `formato: 1` no se restauran con el script.
2. **Descargue** el manifest y cada archivo que lista en una carpeta **fuera del repositorio**, porque el backup contiene hashes y datos personales (F6-03). Por ejemplo, `$env:TEMP\catmetal-restaurar\<fecha>`; bórrela al terminar. Son comandos remotos: los ejecuta el equipo humano.
   ```powershell
   New-Item -ItemType Directory -Force "$env:TEMP\catmetal-restaurar\2026-11-02" | Out-Null
   npx wrangler r2 object get mp-backups-prod/backups/2026-11-02/manifest.json --file "$env:TEMP\catmetal-restaurar\2026-11-02\manifest.json" --remote
   npx wrangler r2 object get mp-backups-prod/backups/2026-11-02/consumptions.ndjson.gz --file "$env:TEMP\catmetal-restaurar\2026-11-02\consumptions.ndjson.gz" --remote
   # … un comando por cada archivo de "tablas" del manifest
   ```
3. **Ponga el repositorio en la revisión** cuya última migración sea `ultima_migracion` del manifest (por ejemplo, `git worktree add <carpeta> <tag>`), y trabaje desde ahí en los pasos 4 a 8.
4. **Cree una D1 nueva y aplique las migraciones** (`wrangler d1 create …` y `wrangler d1 migrations apply … --remote`; lo hace el equipo humano). La base debe quedar recién migrada: el script se niega a importar sobre una base con datos.
5. **Genere el SQL** (Node 24; solo lee archivos y no se conecta a nada):
   ```powershell
   node scripts/restaurar-backup.mjs --backup "$env:TEMP\catmetal-restaurar\2026-11-02" --salida "$env:TEMP\catmetal-restaurar\salida"
   ```
   - El script comprueba `bytes` y `sha256` de cada archivo. Luego lee cada NDJSON **en streaming** (descomprime línea a línea, también los gzip de varios miembros), reconcilia al corte y escribe el SQL sentencia a sentencia. No arma ninguna tabla en memoria, así que los backups grandes caben (revisión de esquema R-01).
   - Escribe:
     - `restauracion.sql`;
     - `verificacion.sql`, que **aborta sola** si una verificación falla;
     - `verificacion-detalle.sql`, las mismas consultas legibles;
     - `post-restauracion.sql`;
     - `informe-restauracion.json`.

     Se niega a escribir dentro del repositorio. Si falla, no deja un `restauracion.sql` a medias.
   - Códigos de salida: 0 correcto; 1 uso o E/S; 2 backup no íntegro o no admitido; 3 filas sin ninguna auditoría en el origen. Con 3, revise la lista. `--conservar-sin-auditoria` las conserva tal cual y la verificación las excluye; nunca se descartan en silencio.
   - `--omitir-sync-mutations` restaura sin ninguna fila de `sync_mutations`, igual que si la tabla hubiera quedado incompleta. Es seguro (ADR 0021, 4.1) y es la salida inmediata si esa tabla es enorme o está dañada. Los rechazos guardados se pierden y el informe lo indica.
   - Las respuestas guardadas de mutaciones no aplicadas que no caben en una sentencia se recortan a `resultado` y `code` (R-10).
6. **Revise el informe** antes de seguir:
   - `revisar_seguridad`: usuarios creados o modificados después del corte. Los creados no se restauran. Los modificados conservan su valor más reciente (una desactivación, un bloqueo o una contraseña nueva se mantienen); confirme que es lo deseado.
   - `cambios_tras_el_corte`: lo que se escribió en la ventana del backup y no está en la base restaurada.
   - `rechazos_tras_el_corte`: mutaciones rechazadas o en conflicto después del corte. El cliente no las reenvía solo; avise a su autor para que rehaga lo que corresponda.
7. **Importe** `restauracion.sql`. El archivo:
   - comprueba con una guardia que la base está recién migrada, con la misma última migración y exactamente los triggers de las migraciones;
   - borra los triggers, inserta los datos (padres primero, sin ningún `DELETE`), recrea los triggers con el mismo SQL y quita la guardia.

   Si falla a mitad, **descarte la base y vuelva al paso 4**. La atomicidad de `--file` en remoto no está verificada (R-06). En local sí lo es. Una base con un fallo a mitad puede quedar sin triggers.
   ```powershell
   npx wrangler d1 execute <base-nueva> --remote --file "$env:TEMP\catmetal-restaurar\salida\restauracion.sql"
   ```
8. **Verifique.** `verificacion.sql` revisa:
   - consumos decididos sin su validación;
   - filas sin auditoría y filas distintas de su última auditoría;
   - la auditoría hasta el corte y `sqlite_sequence`;
   - mutaciones aplicadas sin efecto;
   - FK (`pragma_foreign_key_check`), triggers y conteos.

   Cada verificación es un `INSERT … SELECT NOT EXISTS (…)` en una tabla con `CHECK (ok = 1)`. Si alguna encuentra filas, **el archivo aborta** con `CHECK constraint failed: ok = 1`, sin depender de que `--file` muestre filas (en remoto puede no hacerlo, R-02). Si termina sin errores, todo está bien.

   Si aborta, no siga y descarte la base. Para saber qué falló, ejecute en local (o una por una con `--command`) las consultas de `verificacion-detalle.sql`: cada una debe devolver 0 filas.
   ```powershell
   npx wrangler d1 execute <base-nueva> --remote --file "$env:TEMP\catmetal-restaurar\salida\verificacion.sql"
   ```
9. **Cambie la época** con `post-restauracion.sql`, que equivale al comando de la sección 9.1 y escribe su auditoría:
   ```powershell
   npx wrangler d1 execute <base-nueva> --remote --file "$env:TEMP\catmetal-restaurar\salida\post-restauracion.sql"
   ```
10. **Aplique las migraciones posteriores** a `ultima_migracion`, si las hay, ya desde la rama actual.
11. **Ponga la base en servicio.** Apunte el binding del entorno a la base nueva (`database_id` en `wrangler.jsonc`), despliegue y verifique (secciones 9.3 y 9.4).
    - **Avise a planta: todos deben iniciar sesión otra vez con conexión**, porque `refresh_tokens` no se restaura. Los cupos de login (`login_cupos`) tampoco se respaldan (S-06): la base restaurada empieza sin cupos ni bloqueos. El inicio de sesión sin conexión de la tablet y su cola de pendientes no se ven afectados: lo pendiente se envía después de ese inicio de sesión.
12. **Rehaga** lo que el informe lista como hecho por REST en la ventana (por ejemplo, las decisiones del jefe y los cambios de usuarios) y revise los rechazos.
    - **Seguridad (S-04):** `users` vuelve a su valor exportado. Una desactivación, una baja de rol o un restablecimiento de contraseña hechos **después** de exportar `users` y antes del desastre no aparecen en `revisar_seguridad`. Reaplíquelos desde la base dañada (Time Travel de solo lectura) o desde Workers Logs.
    - Si la restauración se debe a un incidente de seguridad, **rote `JWT_SECRET` y `REFRESH_SECRET`** (sección 3) antes de reabrir. Eso invalida las sesiones y las cookies de dispositivo `mp_dispositivo` (ADR 0018), que dependen de `REFRESH_SECRET`.
13. **Borre** la carpeta temporal.

**Ensayo en local** (autorizado; no toca nada remoto). Con dos carpetas de estado local:
- aplique las migraciones y el seed en la de origen (`wrangler d1 migrations apply DB --local --persist-to <origen>` y `node scripts/seed.mjs --persist-to <origen>`);
- genere un backup (cron local o exportación equivalente);
- haga los pasos 4 a 9 con `--local --persist-to <destino>` en lugar de `--remote`.

La evidencia del ensayo de la v1.1 está en `docs/evidencia/correcciones.md`.

**Mantenimiento del procedimiento:**
- R-07: una migración futura que agregue una clave a `settings` debe recrear antes el trigger `settings_insercion_valida` (migración 0008), que solo admite las claves conocidas. Además, debe actualizar en `scripts/restauracion-nucleo.mjs` las claves que la guardia espera de una base recién migrada (`CLAVES_SETTINGS_SEMBRADAS`).
- Si una migración agrega una tabla, hay que sumarla a `TABLAS_BACKUP` y a `TABLAS` del núcleo de la restauración (lo comprueban las pruebas).

### 9.3 Verificaciones después de restaurar

- Después de una restauración desde R2, `verificacion.sql` (paso 8 de la sección 9.2) ya cubre la coherencia entre tablas.
- Después de Time Travel (sección 9.1), compruebe al menos esto:

```sql
-- Consumos decididos sin su validación (no deberían existir)
SELECT c.id FROM consumptions c WHERE c.estado <> 'pendiente'
  AND NOT EXISTS (SELECT 1 FROM validations v WHERE v.consumption_id = c.id AND v.decision = c.estado);
-- Consumos sin auditoría
SELECT c.id FROM consumptions c
  WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.entidad = 'consumptions' AND a.entidad_id = c.id);
```

Las tablets reenvían lo que tengan; el servidor reconoce por **clave natural** (mismo autor, orden, material y hora del cliente) lo que ya existe sin su registro de sincronización (ADR 0016).

### 9.4 Reconciliar evidencias

R2 no se restaura con D1: tras una restauración puede haber evidencias con `subido = 0` cuyo objeto sí está en R2. Liste los candidatos y, para cada uno, compruebe el objeto (`wrangler r2 object get … --remote`) y su sha256; si coincide, la tablet lo resubirá (idempotente) o puede marcarse manualmente con un `UPDATE evidences SET subido = 1, subido_at = …` acompañado de su fila de auditoría.

```sql
SELECT id, storage_key, sha256 FROM evidences WHERE subido = 0;
```

Fuera de una restauración pasa lo mismo cuando una subida no llega a confirmarse en D1: el Worker nunca borra el objeto (ADR 0024) y registra el aviso `evidencia_no_confirmada` con el `evidencia_id` en Workers Logs. Queda como máximo un objeto por evidencia, que se reconcilia con este mismo procedimiento.

### 9.5 Detectar filas de auditoría duplicadas o espurias (ADR 0028)

Hasta la v1.1, una petición concurrente que **perdía** (su escritura no cambiaba filas) podía dejar igual su fila de auditoría si calculaba el mismo `ahora` que la ganadora, o si la condición no usaba la hora (validaciones). Desde la v1.2 la auditoría se condiciona a una marca de escritura y eso ya no ocurre. En una base creada antes de la v1.2 (staging, o producción si se desplegó la v1.0 o la v1.1), estas consultas listan los candidatos. Deben devolver 0 filas. Son de solo lectura, pero recorren `audit_log` completa (no hay índice por `accion`): en una base grande pueden topar el tiempo máximo de consulta de D1. En ese caso, córralas sobre una copia restaurada en local (sección 9.2) o por rangos de `seq` (`AND seq BETWEEN ? AND ?`). Guárdelas en `deteccion-auditoria.sql` y ejecútelas con `wrangler d1 execute <base> --env <entorno> --file=deteccion-auditoria.sql` contra la base remota del entorno.

```sql
-- 1. Acciones que ocurren una sola vez por entidad, con más de una fila (sea cual sea server_at).
SELECT entidad, entidad_id, accion, COUNT(*) AS filas, MIN(seq) AS primera, MAX(seq) AS ultima
FROM audit_log
WHERE accion IN ('consumo.crear', 'novedad.crear', 'evidencia.crear', 'evidencia.subida',
                 'validacion.crear', 'consumo.aprobar', 'consumo.rechazar', 'orden.crear',
                 'orden.iniciar', 'orden.finalizar', 'material.crear', 'usuario.crear',
                 'asignacion.crear')
GROUP BY entidad, entidad_id, accion
HAVING COUNT(*) > 1;

-- 2. Dos ediciones del mismo consumo que dicen haber dejado la misma version.
SELECT entidad_id, json_extract(datos_despues, '$.version') AS version, COUNT(*) AS filas
FROM audit_log
WHERE accion = 'consumo.editar'
GROUP BY entidad_id, version
HAVING COUNT(*) > 1;

-- 3. Resto de acciones: filas idénticas en entidad, acción, hora y datos (la del perdedor).
SELECT entidad, entidad_id, accion, server_at, COUNT(*) AS filas
FROM audit_log
GROUP BY entidad, entidad_id, accion, server_at, datos_despues
HAVING COUNT(*) > 1;
```

Si aparece algún candidato:

- **No lo borre ni lo edite**: `audit_log` es inmutable (triggers) y la regla 5 lo prohíbe. La fila de negocio (`consumptions`, `evidences`…) es la verdad del estado.
- En cada grupo, la fila con el `seq` menor es la de la escritura que aplicó; las siguientes con los mismos datos son del perdedor. Compárelas con el estado actual de la fila de negocio.
- Registre el hallazgo (fecha, consultas, `seq` afectados y conclusión) en el registro de incidentes del equipo, para que quien lea esa auditoría sepa qué filas no corresponden a una acción.

## 10. Datos personales (Ley 1581 de 2012)

| Dato | Dónde | Para qué | Retención |
|---|---|---|---|
| Nombre, correo, rol, hash de contraseña (PBKDF2) | D1 `users` | Autenticación y trazabilidad | Mientras exista la cuenta (se desactiva, no se borra) |
| Nombre de dispositivo, navegador (`user_agent` truncado), `instalacion_id` | D1 `devices` | "Desde qué dispositivo" (spec §1) | Indefinida (trazabilidad) |
| Autoría y hora de cada acción (sin correo) | D1 `audit_log` | Trazabilidad completa | Inmutable, indefinida |
| Fotos de evidencia (JPEG recomprimido, sin EXIF/GPS) | R2 `evidencias/` | Justificar novedades | Indefinida (pregunta abierta P7) |
| Backups (todas las tablas, incluidos hashes) | R2 `mp-backups-*`, prefijo `backups/` | Recuperación | 90 días |
| IP | No se guarda (solo clave efímera del rate limiter) | — | — |
| En la tablet: perfil (nombre, correo, permisos, verificador), datos de la operación | IndexedDB | Trabajo sin conexión | 30 días sin acceso y sin pendientes (ADR 0017) |

Pendiente del cliente (P7): política de retención de evidencias y de datos personales, y procedimiento de rectificación/supresión (la auditoría es inmutable por diseño; no copia correos).

## 11. Cloudflare Access para administración (opcional)

Revisada tras la revisión de seguridad final (F6-02). La autorización real está en el servidor (`requierePermiso('admin.gestionar')`); Access es una capa adicional de identidad corporativa (Zero Trust → Access → Applications → Self-hosted, política Allow para el grupo correspondiente):

- **Staging**: proteja **todo** el Worker de staging con Access (también funciona sobre `workers.dev`) mientras esté publicado, para que no sea accesible por cualquiera.
- **Producción**: si se desea, proteja solo `/api/v1/users*` (gestión de usuarios). **No** proteja `/admin*`: la PWA instalada sirve el shell desde el Service Worker y el enrutado es del cliente, así que esa regla no protege nada. **No** proteja `/api/v1/materials` ni `/api/v1/settings*`: el supervisor y el jefe los consultan con GET y dejarían de funcionar.
- Pruebe primero en staging: una llamada `fetch` de la PWA que reciba la redirección de Access falla.

## 12. Checklist de despliegue

- [ ] Plan Workers Paid activo en la cuenta.
- [ ] D1, R2 de evidencias, R2 de backups (con regla de 90 días en `backups/`) y KV creados para staging y producción; IDs copiados al `wrangler.jsonc` y confirmados en git.
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

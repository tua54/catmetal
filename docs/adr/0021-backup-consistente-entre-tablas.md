# ADR 0021 — Backup consistente entre tablas: marca de corte, auditoría al final y restauración reconciliada

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem M4)
- Enmendado por: la enmienda S-06 de la ADR 0018 (revisión de seguridad de las correcciones). `login_cupos` ya no se exporta ni se restaura: donde esta ADR la nombra como tabla del backup o como operativa incompleta admitida, rige la enmienda.
- Enmienda:
  - ADR 0014: orden de exportación ("hijos antes que padres" deja de aplicar a `audit_log`) y procedimiento de restauración de H9.
  - ADR 0016, punto 4: significado de `seq_final`.
  - `docs/despliegue.md`, §9.2 y §9.3.
- Depende de la ADR 0020, de la que toma el `formato: 2` del manifest, el estado `parcial`, el contador de intentos por tabla y `login_cupos` en `TABLAS_BACKUP`.
- Segunda opinión: software-architect, 2026-10-30, aprobar con cambios (incorporados)

## Contexto

El backup de R2 no es una foto de un instante (ADR 0014). Recorre las tablas a lo largo de varias invocaciones del cron (de 08:00 a 13:00 UTC) mientras la planta sigue escribiendo. El orden actual, en `apps/worker/src/cron/tablas.ts`, es `audit_log → sync_mutations → validations → evidences → incidents → consumptions → … → users`. La auditoría externa (M4) encontró dos defectos.

**1. Consumo decidido sin validación.**

- La aprobación es un único `db.batch()` (`apps/worker/src/dominio/validaciones.ts`):
  - `INSERT validations`;
  - el trigger `validations_aplica_decision`, que hace `UPDATE consumptions SET estado, version + 1`;
  - dos filas de `audit_log`.
- Si el jefe aprueba después de que se exportó `validations` y antes de que se exporte `consumptions`, el backup tiene el consumo `aprobado` sin su validación.
- Restaurado así, el reenvío del jefe recibe `CONSUMO_NO_PENDIENTE`.

**2. Filas sin su auditoría.** `audit_log` se exporta primero, así que todo lo que se escribió después queda sin auditoría.

Ningún orden fijo de tablas resuelve los dos problemas a la vez:

- "Estado decidido ⇒ hecho que lo causa" exige exportar `consumptions` antes que `validations`.
- "Hijo ⇒ padre" (las FK) exige exportar `validations` antes que `consumptions`.
- "Aplicada ⇒ efecto" exige exportar `sync_mutations` antes que las tablas de negocio. Una `sync_mutations` aplicada sin su efecto es pérdida silenciosa: el reenvío devolvería la respuesta guardada.

D1 no ofrece una lectura de foto sin bloquear la base.

Esta decisión se apoya en lo que sí garantiza el sistema:

- **P1.** Toda escritura de negocio inserta su fila de `audit_log` en el mismo `db.batch()` (spec §4 y regla 5).
  - D1 serializa las escrituras y cada batch es atómico.
  - Por eso todas las filas de auditoría de un batch quedan del mismo lado de cualquier `MAX(seq)` que se lea en otra consulta.
- **P2.** `audit_log.seq` es AUTOINCREMENT, creciente y sin saltos (triggers `audit_log_seq_creciente` y `audit_log_seq_sin_saltos`). El orden de `seq` es el orden de commit.
- **P3.** Nada se borra (triggers `_no_delete`). La única excepción es la purga de `refresh_tokens` vencidos.
- **P4.** Las imágenes `datos_antes` y `datos_despues` siguen la lista blanca `COLUMNAS_AUDITABLES` (`apps/worker/src/auditoria/auditar.ts`):
  - **Fila completa**: `consumptions`, `validations`, `incidents`, `materials`, `production_orders`, `order_supervisors`, `order_planned_materials` y `settings`.
  - **`evidences`**: fila completa salvo `storage_key`, que es inmutable por `evidences_inmutable`.
  - **Parcial**: `users` (sin `email` ni `password_hash`), `devices`, `refresh_tokens` y `login_cupos`.
- **P5.** Las lecturas del backup van a la base primaria.
  - El código no usa la Sessions API de D1 ni réplicas de lectura (`withSession`): no aparece en `apps/worker/src` ni en `wrangler.jsonc`.
  - Si algún día se activan las réplicas, el lema de cobertura (punto 2) deja de valer. El backup tendría que seguir leyendo de la primaria, o esta ADR tendría que revisarse. La prueba de cobertura de tablas lo recuerda con un comentario.

Escrituras **sin** auditoría propia, o con auditoría que no describe la fila (verificadas en el código):

| Escritura | Dónde |
|---|---|
| `devices.ultimo_sync_at` | `sync/push.ts`, `marcarSincronizado` |
| `UPDATE devices` de `instalacion_id`, `nombre` y `user_agent` en el login de un dispositivo conocido | `auth/sesiones.ts:211-227` |
| Reinicio de `users.intentos_fallidos` y `bloqueado_hasta` en un login correcto. Solo audita `usuario.desbloqueado`, sin `datos_antes`, y solo si había bloqueo. | `auth/sesiones.ts:253-258` |
| Revocaciones de `refresh_tokens` que no auditan el id del propio token revocado | `auth/sesiones.ts:143-146`, `273-278`, `361-364`, `464-467` |
| Rotación: la auditoría tiene `entidad_id` = token nuevo, mientras `datos_antes` describe el token presentado | `auth/sesiones.ts:369-373` |
| `login_cupos` (M1): técnica; solo audita el bloqueo | `auth/cupos.ts` |
| Filas de `sync_mutations` | — |

Restricción de SQLite y D1: no se pueden desactivar los triggers, solo borrarlos (`DROP TRIGGER`) y volver a crearlos. Varios de ellos impiden por diseño **insertar** un estado ya alcanzado:

- `consumptions_insercion_valida` exige `pendiente` y `version 1`.
- `validations_validador_jefe` exige un jefe activo hoy.
- `evidences_insercion_valida` exige `subido = 0`.
- `consumptions_corrige_rechazado` exige que el original esté rechazado.
- `audit_log_no_delete` impide vaciar las semillas de la migración 0002.

## Opciones consideradas

1. **Reordenar las tablas y reparar hacia adelante.**
   - Deja FK colgando y `sync_mutations` aplicadas sin efecto.
   - Reparar hacia adelante exige reconstruir filas desde imágenes incompletas, lo que es imposible para `users` y `evidences`.
2. **`audit_log` al final y restaurar "hasta el final del backup".** Tiene el mismo problema de las filas que habría que inventar.
3. **Marca de corte al inicio, `audit_log` al final y restauración al estado exacto del corte (elegida).**
   - Lo creado después del corte se excluye.
   - Lo modificado después del corte se revierte con su primera imagen `datos_antes` posterior al corte, solo en las tablas con imagen completa.
   - Excluir no necesita datos. Revertir solo necesita una imagen que la auditoría sí tiene.
4. **Reproducir la auditoría (event sourcing).** Las imágenes son parciales y la auditoría no es un log de comandos.
5. **Importar con los triggers activos.** Obliga a fabricar historia: `UPDATE` sintéticos de versión, reactivar jefes, orden topológico de correcciones y una base sin 0002. Cualquier trigger futuro lo rompería.

## Decisión

Se adopta la opción 3. **Un backup restaurado representa exactamente el estado de las tablas de negocio en el corte `C`.**

- Lo escrito después del corte se trata igual que lo escrito después de un backup terminado: el servidor lo pierde.
- Las tablets reenvían sus mutaciones aplicadas tras el cambio de época (ADR 0009 y 0016).
- Lo hecho por REST y los rechazos posteriores al corte quedan en el informe, para revisarlos o rehacerlos.
- **`refresh_tokens` no se restaura** (decisión del orquestador): después de una restauración desde R2, todos los usuarios deben iniciar sesión otra vez en línea.
  - El login offline de la tablet y su outbox no se ven afectados. Las mutaciones pendientes esperan a la nueva sesión.
  - Esto elimina las excepciones de rotación, purga y revocación de tokens.

### 1. Marca de corte (en `apps/worker/src/cron/backup.ts`)

- `iniciarProgreso` toma `corte_at = new Date().toISOString()` **inmediatamente antes** del batch que lee `MAX(seq)`, la época y la última migración.
- `C` es el `MAX(audit_log.seq)` de ese batch, que hoy es `seq_inicial`.
- `ProgresoBackup` (`formato: 2`) gana dos campos:
  - `corte_at: string`;
  - `seq_final: number | null`, que vale `null` hasta que empieza `audit_log`.
- Un `progreso.json` de `formato: 1` se descarta: se empieza de nuevo y se registra un `aviso`.

### 2. Orden de exportación y filtros (en `apps/worker/src/cron/tablas.ts`)

```
sync_mutations, validations, evidences, incidents, consumptions, order_planned_materials,
order_supervisors, refresh_tokens, login_cupos, devices, settings, production_orders, materials,
users, audit_log
```

- `refresh_tokens` se sigue exportando: la cobertura del backup no cambia. El script lo ignora al restaurar.
- **`audit_log` va al final.**
  - Al empezar esa tabla, si `seq_final === null`, se lee `seq_final = COALESCE(MAX(seq), 0)` y se persiste en el guardado de inicio de intento de la ADR 0020.
  - Cada página lleva `AND seq <= ?seq_final`.
  - `TablaBackup` gana `acotadaPorSeqFinal?: true`, solo para `audit_log`.
- **Lema de cobertura** (bajo P1, P2 y P5):
  - Toda versión de una fila de negocio presente en el backup la escribió un batch confirmado antes de leer su tabla.
  - Por lo tanto, también antes de leer `seq_final`.
  - Sus filas de auditoría tienen `seq ≤ seq_final` y están en el archivo.
  - Las únicas excepciones son las escrituras sin auditoría de la tabla del Contexto.
- El archivo de `audit_log` contiene exactamente los `seq` de `1` a `seq_final`, sin saltos. El script lo comprueba.
- Se quita la consulta `MAX(seq)` del final.

### 3. Manifest (`formato: 2`; campos de la ADR 0020 más estos)

```jsonc
{
  "formato": 2, "estado": "completo",
  "fecha": "AAAA-MM-DD", "generado_at": "...", "epoca": "...",
  "ultima_migracion": "0007_login_cupos.sql",
  "corte": { "seq": 1234, "at": "2026-11-02T08:00:00.123Z" },
  "seq_inicial": 1234,   // = corte.seq (compatibilidad con la ADR 0016)
  "seq_final": 1301,     // MAX(seq) al empezar audit_log
  "tablas": [ /* en orden de exportación, con estado completa|incompleta */ ]
}
```

### 4. Reconciliación (núcleo puro, `scripts/restauracion-nucleo.mjs`)

#### Definiciones

- `C = corte.seq`, `S = seq_final` y `A` = las filas de `audit_log` del archivo.
- `clave(T, fila)` sigue la convención de `entidad_id` de `auditar.ts`:
  - `id` en las tablas con id propio;
  - `order_id:user_id` en `order_supervisors`;
  - `order_id:material_id` en `order_planned_materials`;
  - `clave` en `settings`.
- Clases de tablas:
  - **Revertibles** (imagen completa, P4): `consumptions`, `validations`, `incidents`, `evidences` (salvo `storage_key`), `materials`, `production_orders`, `order_supervisors`, `order_planned_materials` y `settings`.
  - **Auditadas de último valor**: `users` y `devices`. Se excluyen si se crearon después del corte; si no, se conserva su valor exportado, que es el más reciente.
  - **Operativas**: `sync_mutations` y `login_cupos`. Tienen reglas propias, no participan en el código de salida 3 y quedan fuera de V3 y V10.
  - **No restaurada**: `refresh_tokens`.
- `pre(T, k)` significa que existe una fila de `A` con `seq ≤ C`, `entidad = T` y `entidad_id = k`.
- `post(T, k)` son las filas de `A` de esa entidad con `C < seq ≤ S`, ordenadas por `seq`.

#### 4.1. Comprobaciones previas: si alguna falla, el script se niega a restaurar

- `formato !== 2`. Los backups de `formato: 1` no tienen garantía de corte.
  - Supuesto: la v1 no llegó a producción, así que no existen backups de `formato: 1` que restaurar. Lo registra el orquestador en `docs/preguntas-abiertas.md`.
- `estado = 'parcial'` con alguna tabla `incompleta` que no sea operativa ni `refresh_tokens`. En ese caso hay que usar otro día.
  - Si la incompleta es `sync_mutations`, se restaura sin sus filas. Es seguro porque las aplicadas se reenvían y se reconocen por clave natural (ADR 0016). El costo son los rechazos guardados (ver 4.3).
  - Si la incompleta es `login_cupos`, se restaura vacía: los cupos empiezan de cero.
  - Las dos situaciones quedan en el informe.
- `A` no es exactamente `1..S`, o `C > S`.
- Una fila de una tabla revertible o de último valor con `¬pre ∧ post = ∅`, es decir, sin ninguna auditoría en el origen.
  - Es un defecto del origen, no del backup. Sale con código 3 y la lista de claves.
  - Con `--conservar-sin-auditoria` esas filas se conservan, se listan y V3 excluye exactamente esas claves. Nunca se descartan en silencio.

#### 4.2. Tablas revertibles y de último valor

Por cada fila exportada `r` de la tabla `T` con clave `k`:

| Caso | Acción |
|---|---|
| `pre ∧ post = ∅` | Se importa tal cual. |
| `¬pre ∧ post ≠ ∅` | **Se excluye**: la fila se creó después del corte. Cuenta en `excluidas`. |
| `pre ∧ post ≠ ∅`, tabla revertible | **Se revierte** columna por columna (ver abajo). Cuenta en `revertidas`. |
| `pre ∧ post ≠ ∅`, tabla de último valor | Se importa tal cual y cuenta en `conservadas_mas_recientes`. Si la tabla es `users`, se lista en `revisar_seguridad`. |

Reversión de cada columna `x`, en las tablas revertibles:

- **Nunca se revierten las columnas de la PK o de la clave**, ni `storage_key`.
- Si alguna fila de `post` trae `datos_antes` como objeto con la clave `x`, el valor es el de la **primera** de ellas. Si no, se conserva `r[x]`.
- Conversiones:
  - un booleano de la auditoría pasa a `1`/`0` (según `COLUMNAS_BOOLEANAS` de `auditar.ts`);
  - `settings.valor` pasa a `JSON.stringify(v)`, porque la auditoría guarda el JSON parseado;
  - las claves de la imagen que no son columnas se ignoran (`force`, `pendientes`).

Por qué las tablas de último valor conservan su valor más reciente:

- `users` y `devices` no tienen imagen completa (P4) y reciben escrituras sin `datos_antes`.
- Revertir a medias produciría filas que nunca existieron.
- Conservar el valor más reciente es además lo más restrictivo para la seguridad: una desactivación, un bloqueo o una contraseña cambiados después del corte se mantienen.
- `revisar_seguridad` lista los usuarios con cambios posteriores al corte, con `accion`, `actor_id` y `server_at`, para que alguien revise si el estado conservado es el deseado.

#### 4.3. Tablas operativas

**`sync_mutations` aplicada.** Se conserva **solo si su efecto existe** en el estado restaurado, según `respuesta_json.servidor` (`plan.respuesta` de `push.ts`):

| Tipo | Se conserva si |
|---|---|
| `consumo.crear` | `servidor.id` está en los consumos restaurados |
| `consumo.editar` | la versión restaurada de `servidor.id` es ≥ `servidor.version` |
| `novedad.crear` | `servidor.id` está en las novedades restauradas |
| `consumo.aprobar` y `consumo.rechazar` | `servidor.validacion.id` está en las validaciones restauradas |

Si el tipo o la forma son inesperados, se descarta.

- Descartar es seguro: el cliente reenvía sus aplicadas tras el cambio de época (`reencolarAplicadas`, `apps/web/src/datos/entidades.ts:436-478`), y el servidor las reaplica o las reconoce por clave natural.
- Conservar una aplicada sin su efecto no es seguro: el reenvío recibiría `aplicada` sin que el dato exista.

**`sync_mutations` no aplicada** (`rechazada` o `conflicto`):

- Se conserva si `procesada_at < corte.at − 15 min`. Si no, se descarta.
- **Descartarla no es "siempre seguro".** El cliente solo reencola las `aplicada` (`entidades.ts:436-478`, `aplicar-cambios.ts:238-253`).
  - Un rechazo o un conflicto que el cliente ya recibió no se reenvía.
  - Si la causa del rechazo desapareció con la restauración (por ejemplo, una edición en `CONFLICTO` porque el jefe aprobó después del corte, aprobación que ahora se revirtió), la edición no vuelve sola.
- Descartar sí es seguro para una respuesta que el cliente **no** recibió: sigue pendiente en su outbox y se vuelve a evaluar contra el estado restaurado.
- Todas las no aplicadas descartadas van al informe como `rechazos_tras_el_corte` (`mutation_id`, `user_id`, `tipo`, `code`), para que los supervisores revisen y rehagan lo que haga falta.
  - El orquestador lo registra en `docs/preguntas-abiertas.md`: un reenvío automático desde el cliente queda fuera del alcance.
- El margen de 15 minutos cubre el tiempo entre el `ahora` de la petición y su commit.

**Reglas comunes a `sync_mutations`:**

- Se descarta toda fila cuyo `user_id` o `device_id` quedó excluido.
- Si la sentencia de una fila no aplicada supera `MAX_BYTES_SENTENCIA` (punto 5), su `payload_json` se reemplaza por el JSON reducido de la ADR 0020 y la fila cuenta en `recortadas`. En cualquier otra tabla, una fila que no cabe es un error.

**`login_cupos`:** se importa tal cual, salvo las filas de usuarios excluidos.

#### 4.4. `audit_log` y `refresh_tokens`

- `audit_log`: se importan solo las filas con `seq ≤ C`. Las de `C < seq ≤ S` van al informe como `cambios_tras_el_corte`.
- `refresh_tokens`: no se importa ninguna fila.
  - Las filas de auditoría de sesión siguen en `audit_log`. No hay FK hacia `refresh_tokens`, y `reemplazado_por` no tiene FK (`apps/worker/src/db/schema.ts:173-177`).
  - Todos los usuarios inician sesión de nuevo en línea. `docs/despliegue.md` lo avisa (paso 10 de §9.2).

#### 4.5. Clausura de FK

- Una fila conservada de una tabla revertible o de último valor existía en `C` (`pre`). Por las FK, sus padres también existían en `C`, tienen auditoría `≤ C` (P1) y están en su archivo (P3). Por lo tanto también se conservan.
- Las operativas se filtran por usuario y dispositivo excluidos.
- V7 lo comprueba de todos modos.

#### 4.6. Informe (`informe-restauracion.json`, fuera del repositorio)

El informe tiene estos campos:

- `fecha`, `corte` y `seq_final`.
- Por tabla: `exportadas`, `importadas`, `excluidas`, `revertidas`, `conservadas_mas_recientes`, `recortadas` y `sin_auditoria_conservadas`.
- Para `sync_mutations`: `aplicadas_conservadas`, `aplicadas_sin_efecto_descartadas`, `no_aplicadas_conservadas`, `no_aplicadas_descartadas` y `tabla_omitida`.
- `refresh_tokens_omitidos`: el conteo.
- `cambios_tras_el_corte`: `seq`, `entidad`, `entidad_id`, `accion`, `actor_id` y `server_at`, sin `datos_*`.
- `rechazos_tras_el_corte`.
- `revisar_seguridad`.

La consola muestra un resumen.

### 5. SQL de restauración y triggers

API del núcleo. Es puro (sin `node:*`) y sus tipos van en `scripts/restauracion-nucleo.d.mts`:

```ts
planificarRestauracion(e: {
  manifest; filas: Record<string, Fila[]>; triggers: { nombre: string; sql: string }[];
  conservarSinAuditoria?: boolean;
}): { restauracion: string[]; verificacion: { nombre: string; sql: string }[];
      postRestauracion: string[]; informe: InformeRestauracion }   // lanza ErrorRestauracion { codigo, detalle }
triggersDeMigraciones(archivos: { nombre: string; contenido: string }[], hasta: string): { nombre; sql }[]
```

`triggersDeMigraciones` arma la lista de triggers esperados a partir de las migraciones:

1. Toma los `.sql` cuyo nombre es ≤ `hasta`, en orden.
2. Divide cada archivo por `--> statement-breakpoint`.
3. En cada trozo quita las líneas iniciales en blanco o que son comentarios `--`, recorta los espacios y quita el `;` final.
4. Aplica `CREATE TRIGGER` y `DROP TRIGGER [IF EXISTS]` y devuelve los triggers vigentes, en orden de creación.

`restauracion.sql` lleva estas sentencias, en este orden exacto:

1. `PRAGMA defer_foreign_keys = on;`
2. **Guardia**, antes de cualquier `DROP TRIGGER`.
   - Se crea `CREATE TABLE _restauracion_guardia (ok INTEGER NOT NULL CHECK (ok = 1));`.
   - Después, un `WITH esperados(n, s) AS (VALUES …) INSERT INTO _restauracion_guardia SELECT <condición>`. La condición vale 1 solo si se cumplen **todas** estas:
     - `users`, `devices`, `consumptions`, `refresh_tokens` y `login_cupos` están vacías;
     - no hay ninguna fila de `audit_log` con `accion <> 'seed'`;
     - la última migración de `d1_migrations` es `manifest.ultima_migracion`;
     - **los triggers de la base son exactamente los esperados**: el mismo número que `esperados`, y ninguno de `esperados` falta en `sqlite_master` con el mismo `name` y el mismo `sql`.
   - Si alguna falla, el CHECK aborta la ejecución antes de tocar nada.
3. `DROP TRIGGER IF EXISTS <nombre>;` por cada trigger.
4. Los datos, padres primero:
   - Orden de tablas: `users`, `materials`, `production_orders`, `settings`, `devices`, `login_cupos`, `order_supervisors`, `order_planned_materials`, `consumptions`, `incidents`, `evidences`, `validations`, `sync_mutations`, `audit_log`.
     - `consumptions` va en orden topológico por `corrige_a` y después por `id`.
     - `audit_log` va por `seq`.
   - Cada `INSERT` lleva varias filas, con un máximo de 100 filas o `MAX_BYTES_SENTENCIA = 90 000` bytes. El límite de D1 por sentencia (documentado en 100 KB) se verifica y se anota en `docs/notas-plataforma.md`.
   - Formato de los literales:
     - cadenas entre `'…'`, con la `'` duplicada;
     - números tal cual (se rechazan `NaN` e `Infinity`);
     - `NULL`.
   - `settings` y `audit_log` usan `ON CONFLICT (<pk>) DO UPDATE SET <cada columna> = excluded.<columna>`, por las semillas de 0002 (seq 1 y 2, con ids fijos). No hay ningún `DELETE`.
5. `CREATE TRIGGER …` con el SQL exacto de `triggers`, en su orden.
6. `DROP TABLE _restauracion_guardia;`

Los triggers solo se borran **dentro de este archivo**, sobre una base recién migrada y fuera de servicio (lo comprueba la guardia), y se recrean en el mismo archivo. V8 lo comprueba después.

- Ningún código ni ninguna base en servicio borra triggers para **desactivarlos**: la regla 5 se mantiene. La única migración que hace `DROP TRIGGER` es `migrations/0008_settings_insert_validos.sql` (B7): borra `settings_valores_validos` y lo recrea **en la misma migración**, con un criterio más estricto (agrega el tope de 100 y se suma `settings_insercion_valida` para los INSERT). Es un reemplazo que solo endurece, no deja la tabla sin protección al terminar la migración, y la prueba `correcciones-b7-settings-insert.test.ts` con la lista de `sqlite_master` de `integridad-esquema.test.ts` lo verifica. Corregido en v1.2 (A9): la frase original decía que ninguna migración borraba triggers.
- Si la ejecución falla a mitad, se descarta la base y se crea otra.
- Mientras tanto siguen activos los CHECK, los NOT NULL, los UNIQUE y las FK. Las invariantes entre tablas se comprueban como invariantes de estado (punto 6).

`post-restauracion.sql` corre después de la verificación, con los triggers ya activos. Contiene el cambio de `settings.sync_epoca` con su fila de auditoría (el comando de §9.1), que queda con `seq = C + 1`.

### 6. Verificación (`verificacion.sql`: cada consulta debe devolver 0 filas)

| Id | Devuelve una fila por cada |
|---|---|
| V1 | Consumo con `estado <> 'pendiente'` sin una validación con `decision = estado`. |
| V2 | Validación cuyo consumo tiene `estado <> decision`. |
| V3 | Fila de una tabla revertible o de último valor sin ninguna auditoría `(entidad, clave)`. Usa el índice `audit_log_entidad_entidad_id` y excluye solo las claves aceptadas con `--conservar-sin-auditoria`. No incluye las operativas. |
| V4 | **Por cada tabla revertible**: fila cuya última auditoría con `seq ≤ C` y `datos_despues` no nulo no coincide con la fila restaurada. Se compara cada columna de la lista blanca presente en la imagen (`json_type(datos_despues, '$.<col>') IS NOT NULL`), salvo `storage_key`. Las booleanas se comparan contra `json_extract`, que devuelve 1/0, y `settings.valor` con `json_extract(valor, '$')`. El núcleo genera una consulta por tabla a partir de las mismas listas de columnas. |
| V5 | `MAX(seq) <> C` o `COUNT(*) <> C` en `audit_log`. |
| V6 | `sync_mutations` aplicada sin su efecto (reglas de 4.3 en SQL). |
| V7 | Violación de FK: `PRAGMA foreign_key_check`, que va en una consulta aparte. |
| V8 | Diferencia entre los triggers de `sqlite_master` (nombre y `sql`) y los esperados, o `_restauracion_guardia` todavía existe. |
| V9 | Tabla cuyo conteo no coincide con `importadas` del informe. `refresh_tokens` debe tener 0. |
| V10 | Auditoría con `seq ≤ C` de una entidad que no existe, en las tablas revertibles y de último valor. Excluye `refresh_tokens` y las operativas. |

### 7. CLI (`scripts/restaurar-backup.mjs`, Node 24, solo E/S)

```
node scripts/restaurar-backup.mjs --backup <carpeta> --salida <carpeta fuera del repo> \
  [--migraciones migrations] [--conservar-sin-auditoria]
```

Pasos:

1. Lee el manifest.
2. Por cada tabla `completa`, comprueba `bytes` y `sha256` (`node:crypto`) y la descomprime con `zlib.gunzipSync`, que soporta varios miembros gzip.
3. Lee el NDJSON y las migraciones.
4. Llama al núcleo.
5. Escribe `restauracion.sql`, `verificacion.sql`, `post-restauracion.sql` e `informe-restauracion.json`.

Se niega a escribir dentro del repositorio (F6-03).

Códigos de salida:

| Código | Significado |
|---|---|
| 0 | Correcto |
| 1 | Uso o E/S |
| 2 | Integridad o backup no admitido |
| 3 | Filas sin auditoría en el origen |

Ante falta de memoria con tablas grandes: `--max-old-space-size`.

### 8. Procedimiento (`docs/despliegue.md` §9.2, que reemplaza los pasos 4 a 9 actuales)

1. Elija un manifest con `formato: 2` y `estado: 'completo'`, o `parcial` cuyas tablas incompletas sean solo `sync_mutations`, `login_cupos` o `refresh_tokens`.
2. Descárguelo con sus archivos en `$env:TEMP\catmetal-restaurar\<fecha>`.
3. Ponga el repositorio en la revisión cuya última migración sea `ultima_migracion`.
4. Cree la D1 nueva y aplique las migraciones. Lo hace el equipo humano.
5. Ejecute el CLI y revise `revisar_seguridad`, `cambios_tras_el_corte` y `rechazos_tras_el_corte`.
6. Ejecute `restauracion.sql`.
7. Ejecute `verificacion.sql` y `PRAGMA foreign_key_check`. Todo debe salir vacío.
8. Ejecute `post-restauracion.sql`.
9. Aplique las migraciones posteriores.
10. Apunte el binding, despliegue y haga las verificaciones de §9.3 y §9.4.
    - Avise a planta que **todos deben iniciar sesión otra vez en línea**.
    - Lo pendiente en las tablets se envía después de ese inicio de sesión.
11. Rehaga lo que el informe lista como hecho por REST en la ventana del backup y revise los rechazos.
12. Borre la carpeta temporal.

Ensayo en local con `--local` (autorizado); la evidencia va en `docs/evidencia/correcciones.md`.

### 9. Prueba de regresión (`apps/worker/test/fase6-restauracion.test.ts`, nueva)

**Configuración.**

- Una segunda D1 local, `DB_RESTAURADA` (`miniflare.d1Databases` en `apps/worker/vitest.config.mjs`), con su tipo en `apps/worker/test/env.d.ts`.
- Se le aplican las migraciones con `applyD1Migrations`.
- D1 y R2 locales reales, sin mocks.

**Escenario**, sobre `env.DB`, usando la API real (`SELF.fetch` y los helpers de las fases 2 y 3):

1. Sembrar supervisor, jefe, admin, una orden `en_proceso`, materiales, los consumos pendientes `A` y `B`, y el consumo `D`, aprobado antes del corte.
2. Primera invocación con presupuesto mínimo: toma el corte y se pausa sin exportar nada.
3. Después del corte y antes de que se exporte `sync_mutations`, el supervisor crea el consumo `E` por `/sync/push`.
4. Continuaciones con `tamanoPagina` 1 y presupuestos mínimos (con `leerProgreso`), hasta que `validations` esté terminada y `consumptions` no.
5. **El jefe aprueba `B` por REST.** El supervisor edita `A`, que pasa a la versión 2. Además, una edición de `D` (ya decidido) queda en `CONFLICTO` y se guarda como no aplicada.
6. Continuaciones hasta que exista el manifest.

**Restauración.**

1. Comprobar que `triggersDeMigraciones` (sobre los `migrations/*.sql` de `env.TEST_ARCHIVOS_FUENTE`) devuelve exactamente los triggers de `DB_RESTAURADA` recién migrada.
2. Llamar a `planificarRestauracion`.
3. Ejecutar `restauracion` en `DB_RESTAURADA`.

**Aserciones.**

- V1 a V10 vacías.
- `B` queda `pendiente`, versión 1, sin validación.
- `A` queda en la versión 1.
- `E` y su fila de `sync_mutations` no existen.
- `refresh_tokens` tiene 0 filas.
- `MAX(audit_log.seq) = C`.
- El informe:
  - lista `A`, `B` y `E` en `cambios_tras_el_corte`;
  - lista el conflicto de `D` en `rechazos_tras_el_corte`.
- Después de `postRestauracion`, los triggers están activos:
  - `UPDATE audit_log` falla con "inmutable";
  - un consumo insertado como `aprobado` falla con "nace pendiente";
  - una validación nueva de `B` pasa y deja `B` aprobado.

**Falla hoy.** La primera versión de la prueba restaura con el §9.2 actual: todo tal cual, con los triggers borrados y recreados. V1 devuelve `B`, y V3 y V4 también devuelven filas. Se pega esa salida. Después, la prueba usa `planificarRestauracion`.

**Pruebas del núcleo:**

- Rechaza `formato: 1`.
- Rechaza un parcial con `consumptions` incompleta.
- Un parcial con `sync_mutations` incompleta da V1 a V10 vacías, sin filas de sync y con el informe.
- Un parcial con `login_cupos` incompleta queda vacía.
- Rechaza un salto de `seq`.
- Una fila sin auditoría sale con código 3, y con la opción se conserva.
- Revierte `evidences.subido`.
- Un `users.activo` cambiado después del corte conserva su valor más reciente y aparece en `revisar_seguridad`.
- Las columnas de la PK nunca se revierten.
- Las filas de `login_cupos` de usuarios excluidos se descartan.
- Un `payload_json` de 64 KiB lleno de `'` se recorta para que quepa en una sentencia.
- Ida y vuelta de literales con `'`, `\`, saltos de línea, emojis y sustitutos sueltos.

## Consecuencias

- Un backup de R2 restaurado es una foto exacta, en el corte, de las tablas revertibles. `users` y `devices` conservan su valor más reciente, con su auditoría hasta el corte. Las invariantes entre tablas se comprueban con SQL.
- Lo escrito en la ventana del backup (de 08:00 a 13:00 UTC como máximo) se pierde en el servidor, igual que todo lo posterior a un backup.
  - Las tablets reenvían sus aplicadas.
  - Lo hecho por REST y los rechazos quedan en el informe.
  - No hay pérdida silenciosa, pero los rechazos posteriores al corte necesitan revisión humana.
- **Todos deben volver a iniciar sesión en línea** después de una restauración desde R2. Esto no afecta el login offline ni el outbox.
- Los triggers se borran y recrean solo en el archivo de restauración, con guardia antes y verificación después. Hay que contarlo a `database-specialist` y a `security-reviewer`.
- Cambia el orden de exportación: `audit_log` va al final y `login_cupos` entra en la lista. También cambia el significado de `seq_final`.
- **Riesgo registrado.** `audit_log`, la tabla más grande, se exporta al final de la ventana. Si no termina antes de las 13:00 UTC, el día queda sin manifest (`backup_incompleto_del_dia`).
  - Mitigación: sus filas son pequeñas, así que la ventana adaptativa llega a 2000 filas por página. Unas 950 consultas por invocación cubren ~1,9 millones de filas, y quedan hasta seis invocaciones.
  - Se vigila con el log `backup_resumen`.
- Riesgo de P5: activar réplicas de lectura de D1 invalidaría el lema de cobertura.
- El script queda fuera de `apps/worker/src`, así que no cuenta para la cobertura. Su núcleo se prueba en workerd; el CLI, con el ensayo local.

## Cómo revertir

- Backup: volver `audit_log` al principio, quitar el filtro de `seq_final`, volver al `MAX(seq)` final y a `formato: 1`.
- Restauración: borrar `scripts/restauracion-nucleo.mjs`, `scripts/restauracion-nucleo.d.mts` y `scripts/restaurar-backup.mjs`, volver §9.2 y §9.3 de `docs/despliegue.md` a su versión anterior y quitar `DB_RESTAURADA` de la configuración de pruebas.

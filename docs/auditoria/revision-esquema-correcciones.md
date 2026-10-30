# Revisión de esquema y base de datos: correcciones v1.1 (M3, M4, B7)

- Revisor: `database-specialist`, en modo de solo lectura. Lo encargó el orquestador según `CLAUDE.md` (bucle de trabajo, punto 4).
- Fecha: 2026-10-30.
- Rama: `fix/auditoria-v1`. Commits revisados: `88c6afb` (M3 y M4) y `231ad15` (B7).
- No se modificaron archivos ni se ejecutaron pruebas o migraciones. El revisor leyó código, `git diff` y `git log`, y ejecutó un script de Node de solo lectura que llama a `triggersDeMigraciones`.

## Resumen (veredicto)

**Aprobado con cambios.**

Está bien:

- La consulta de página acotada por bytes es correcta en SQLite: el orden de enlace de los parámetros, la detección del fin de tabla, la comparación de PK compuestas como valores de fila y una cota real de memoria de 4 MiB más una fila.
- La reconciliación al corte es coherente con P1 a P5.
- B7 solo endurece y no bloquea ningún camino legítimo.
- No se debilitó ningún trigger de inmutabilidad ni se agregó un `DELETE` de negocio.

Hay que corregir:

- **Un alto (R-01)**: el CLI de restauración no escala. Un cliente autenticado, con `sync_mutations`, o el simple crecimiento de `audit_log`, pueden dejar inutilizables todos los backups siguientes.
- **Dos medios** de operación remota:
  - R-02: la verificación remota del paso 8 puede no mostrar filas.
  - R-03: si `octet_length` no existe en la D1 remota, el backup falla todos los días sin respaldo.

## Hallazgos

| Id | Sev. | Ítem | Archivo:línea | Descripción | Recomendación |
|---|---|---|---|---|---|
| R-01 | **alto** | M4 | `scripts/restaurar-backup.mjs:117-118`; `scripts/restauracion-nucleo.mjs:1046-1047`; `restaurar-backup.mjs:175-183` | Cada tabla se descomprime en **un solo string** (`gunzipSync(bytes).toString('utf8')`), y `restauracion.sql` también se arma en un solo string (`archivoSql`). En Node 24, `buffer.constants.MAX_STRING_LENGTH` = 536 870 888 (verificado: v24.18.0). Por encima, `ERR_STRING_TOO_LONG` hace salir el CLI con código 1, y `--max-old-space-size` no ayuda. Estimación, en orden de magnitud y sin medir: bastan unas 30 000 mutaciones rechazadas de unos 17 KiB, unas 8 000 filas antiguas de 64 KiB, o un `audit_log` de unas 350 000 filas de ~1,5 KB. Como nada se borra, **todos los días siguientes** quedan sin restaurar desde R2 y solo queda Time Travel. | Leer el NDJSON en streaming (`zlib.createGunzip()` + `readline`) y escribir el SQL con `fs.createWriteStream`. Guardar en memoria solo los índices de auditoría que hacen falta, no las filas completas de `audit_log` ni de `sync_mutations`. Mitigación inmediata: `--omitir-sync-mutations`, con la semántica de una tabla `incompleta` admitida (ADR 0021, 4.1). Agregar una prueba con un NDJSON sintético de muchas líneas. |
| R-02 | medio | M4 (runbook) | `docs/despliegue.md` §9.2, paso 8; `restaurar-backup.mjs:179-183` | El paso 8 corre `verificacion.sql` con `wrangler d1 execute --remote --json --file`. Desde Wrangler 3.57, `--file` en remoto usa la API de importación, que devuelve metadatos y no las filas de cada `SELECT`. La fuente es un tracker (workers-sdk #6088), así que **no está verificado**. Si es así, la condición "0 filas" no se puede observar. | Hacer que la verificación **falle sola**: con el patrón de la guardia, `INSERT INTO _verificacion (ok) SELECT NOT EXISTS (<Vn>)` sobre una tabla con `CHECK (ok = 1)`. Otra opción es correr cada consulta con `--command`. Agregarlo al ensayo de staging. |
| R-03 | medio | M3 | `apps/worker/src/cron/backup.ts:568-570`; `cron/ejecutar.ts:330-333` | `octet_length` se usa sin respaldo en tiempo de ejecución, y su presencia en la D1 remota está "por confirmar". Si falta, cada tabla queda `incompleta` y el resultado es un manifest `parcial` **sin archivos**, todos los días, sin el log `backup_incompleto_del_dia`. | Confirmarlo en staging. Además, una de dos: un respaldo automático a `length(CAST(col AS BLOB))` cuando el error sea "no such function", o un log `backup_no_restaurable` cuando alguna tabla incompleta no esté en `INCOMPLETAS_ADMITIDAS`. |
| R-04 | bajo | M4 | `restauracion-nucleo.mjs:735-743` | La reversión toma, para cada columna, la primera imagen posterior al corte que tenga esa columna, no estrictamente la de `post[0]`. Con un `datos_antes` NULL se usaría una imagen posterior. V4 lo detectaría y bloquearía la restauración. Hoy todas las actualizaciones de tablas revertibles auditan `antes` completo. | Usar solo `post[0]` y lanzar `INTEGRIDAD` si falta una columna revertible. |
| R-05 | bajo | M4 | `restauracion-nucleo.mjs:893-907` | La guardia exige vacías solo algunas tablas. Si una importación falla después de los `DROP TRIGGER`, la base queda sin triggers. | Exigir también vacías `sync_mutations`, `materials`, `production_orders`, `order_*`, `incidents`, `evidences` y `validations`, y que `settings` tenga exactamente las claves de 0002. |
| R-06 | bajo | M4 | `docs/notas-plataforma.md:92` | La atomicidad de `--file` en remoto no está verificada (en local, sí lo es). Hoy no afecta: el orden de importación respeta todas las FK. | Mantener la regla "si falla, descartar la base" y comprobar V8 en staging tras un fallo provocado. |
| R-07 | info | B7 | `migrations/0008_settings_insert_validos.sql:29-39` | Con una clave conocida y un `valor` que no es JSON, `json_type` lanza "malformed JSON" en lugar de `RAISE`. Aborta igual, pero el CHECK `settings_valor_json` ya no se alcanza en ese caso. No queda bloqueado ningún camino legítimo. Una migración futura que agregue una clave nueva tiene que recrear antes `settings_insercion_valida`. | Documentarlo. Si se quiere un mensaje uniforme, anteponer `json_valid(NEW.valor) = 0 OR`. |
| R-08 | info | B7 | 0008 | No se revisan las filas existentes: una `tolerancia_pct > 100` escrita antes por SQL directo seguiría ahí (por la API no se podía). | Opcional: una consulta de comprobación en el runbook. |
| R-09 | info | M4 (rendimiento) | `restauracion-nucleo.mjs:1018-1023` | V10 en `order_supervisors` y `order_planned_materials` compara `r.a \|\| ':' \|\| r.b = a.entidad_id` sin índice: O(auditorías × filas). Las tablas son pequeñas. | Si crecen, partir `entidad_id` y buscar por la PK. |
| R-10 | info | M3 | `push.ts:244-256`; `0000_esquema_inicial.sql:231` | `respuesta_json` no tiene CHECK de longitud. En la práctica está acotada, pero la restauración solo recorta `payload_json`, así que una `respuesta_json` de más de ~90 KB la haría fallar. | Opcional: un CHECK `length(respuesta_json) <= 8192` en una migración futura, o el mismo recorte en la restauración. |

## Verificaciones realizadas

1. **Página por bytes** (`backup.ts:543-594`, `682-717`).
   - El orden de enlace de los parámetros es correcto. La primera fila entra siempre: la página es menor que `max` más una fila.
   - Un CTE vacío da 0 filas y marca el fin de tabla.
   - Fin de tabla con `n == total < L`. El caso `n == total == L` pide otra página, que puede llegar vacía.
   - Las comparaciones de valores de fila en las PK compuestas son válidas.
   - Peor caso: L ≤ 2000 filas medidas más n ≤ L filas leídas completas.
   - No hay columnas BLOB.
   - **No se verificó** que `octet_length` evite leer las páginas de desbordamiento.
2. **Aislamiento y orden del backup.**
   - El intento se persiste antes de exportar, y el parcial no se pierde.
   - `seq_final` se lee una sola vez, después de las demás tablas, y se persiste antes de exportar `audit_log`.
3. **`triggersDeMigraciones`** (script de solo lectura).
   - Devuelve 35 triggers. `settings_valores_validos` queda con la **última** definición, la de 0008, porque se hace `delete` y luego `set`.
   - El `VALUES` de la guardia mide unos 10 KB, menos que 100 KB.
4. **Literales del SQL.** Se duplica `'`. Un texto con NUL va como `CAST(X'…' AS TEXT)`. Se rechazan `NaN` e `Infinity`. El tope es de 90 000 bytes por fila y por sentencia.
5. **`sqlite_sequence`.** Los `seq` explícitos de 1 a C dejan la secuencia en C. `V5_secuencia_de_auditoria` lo comprueba, y `post-restauracion.sql` no usa `ON CONFLICT`, así que no repite N2.
6. **FK y orden de importación.** Se contrastaron con todas las `REFERENCES` de 0000 y 0007. Lo excluido no tiene hijos conservados.
7. **Clases de tablas.** Un consumo decidido no puede quedar sin su validación (mismo batch y mismo lado de C, comprobado por V1 y V2). Toda fila revertible o de último valor queda cubierta por V3, o el script sale con código 3.
8. **Triggers y `DELETE`.** 0008 conserva los predicados de 0004 y solo agrega `> 100`. Los únicos `DELETE` son las purgas de `refresh_tokens` y `login_cupos`, que son tablas técnicas.
9. **Índices.** Cubren V3, V4 y la purga de `login_cupos`. `sync_mutations_no_aplicadas_consumo` sigue sirviendo, porque el JSON reducido conserva `$.payload.id`.

## Fuera de alcance o no verificado

- El comportamiento de la D1 remota: `octet_length`, funciones de ventana, el límite de 100 KB, la atomicidad de `--file`, si `--file` devuelve resultados y la lectura de `sqlite_sequence`. Queda para el ensayo en staging de `docs/pendientes-humanos.md`.
- La lógica de cupos de M1 y la concurrencia del arriendo de `progreso.json`.

Fuentes externas citadas por el revisor: workers-sdk #6088 y #11087 (trackers), [D1: importar y exportar datos](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [D1: sentencias SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

## Estado de los hallazgos (orquestador)

Se completa al corregir; ver la sección siguiente.

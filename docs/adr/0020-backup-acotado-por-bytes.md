# ADR 0020 — Backup acotado por bytes, aislamiento de tablas que fallan y recorte de las mutaciones rechazadas

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem M3)
- Enmienda:
  - ADR 0014: la paginación de 500 filas y la regla "manifest solo si el backup está completo".
  - ADR 0016, punto 4: la página de 2000 filas medida con filas de ~6 KB.
  - El `payload_json` de las mutaciones no aplicadas de `apps/worker/src/sync/push.ts` (ADR 0009).
- Relacionada: ADR 0021 (consistencia entre tablas). Cambia el orden de exportación y el formato del manifest, que esta ADR también toca. Las dos comparten el `formato: 2` del manifest y se implementan en ese orden: primero esta y después la 0021.
- Segunda opinión: software-architect, 2026-10-30, aprobar con cambios (incorporados)

## Contexto

La auditoría externa (M3, `docs/correcciones-v1.1.md`) mostró que un cliente autenticado puede hacer fallar el backup **todos los días**:

- `apps/worker/src/cron/backup.ts` pagina con `SELECT *` de `TAMANO_PAGINA = 2000` filas, sin mirar cuánto pesan. `ndjson()` arma toda la página en un solo `string` y después en un solo `Uint8Array`.
- `apps/worker/src/sync/push.ts` (`payloadJson`, `guardarRespuesta`) guarda hasta 64 KiB de `sync_mutations.payload_json` por cada mutación **rechazada**.
  - Unas 80 peticiones de 25 mutaciones inválidas de ~63 KB bastan para que una página de `sync_mutations` pese ~128 MB.
  - En memoria es varias veces eso: el resultado de D1 en UTF-16, el `string` del NDJSON y sus bytes. El límite de un isolate es 128 MB.
- Cuando el Worker se queda sin memoria, la invocación muere sin pasar por el `catch`.
  - `progreso.json` sigue apuntando a la misma tabla, y la siguiente continuación repite la misma página y vuelve a morir.
  - `sync_mutations` es la **segunda** tabla del orden actual, así que las tablas siguientes nunca se respaldan.
  - A las 13:00 UTC solo queda el log `backup_incompleto_del_dia`, y así todos los días.
- Un error que sí se captura (por ejemplo, una red de D1 que se cae) reinicia la tabla desde cero en la siguiente invocación y vuelve a lanzar. No hay tope de reintentos por tabla.

Límites de la plataforma que aplican, ya documentados en `docs/notas-plataforma.md` y en las ADR 0014 y 0016:

- 128 MB de memoria por isolate.
- 1000 consultas a D1 por invocación; el código usa 950.
- Seis invocaciones por día, de 08:00 a 13:00 UTC.
- Partes de multipart de R2 de 5 MiB exactos.
- Tamaño máximo de fila de D1: ~2 MB.

## Opciones consideradas

### A. Cómo acotar la página

1. **Bajar `TAMANO_PAGINA`** (por ejemplo, a 200). No acota nada: 200 filas de 2 MB siguen siendo 400 MB. Además, multiplica por 10 las consultas de las tablas de filas pequeñas.
2. **Página adaptativa en JS**: se lee una página y, si pesó mucho, la siguiente se pide más pequeña. La primera página grande ya reventó la memoria.
3. **Dos consultas por página**: una sonda de PK y tamaño, y después los datos hasta el corte. Funciona, pero gasta el doble de consultas de D1 por página.
4. **Una sola consulta con el corte por bytes calculado en SQL**: una CTE que suma el tamaño en una subconsulta que solo lleva la PK. El Worker nunca recibe más que el límite. Se combina con una ventana de medición adaptativa (ver Decisión 1) para que SQLite tampoco lea de más.

### B. Cómo escribir sin acumular

1. Mantener `ndjson(filas)`.
2. **Codificar fila por fila** y escribir al `CompressionStream` en trozos de hasta 1 MiB, con contrapresión.

### C. Una tabla que falla siempre

1. Dejarlo como está.
2. **Contar los intentos sin avance por tabla.** El contador se persiste *antes* de cada intento. Al llegar al tope, la tabla queda `incompleta` y el backup sigue con las demás.
3. Saltar la tabla al primer fallo. Demasiado agresivo ante errores transitorios de D1.

### D. Tope de crecimiento de `sync_mutations` rechazadas

1. No hacer nada.
2. **Recortar `payload_json`** de las mutaciones no aplicadas que superen un umbral. Se conserva lo que el servidor consulta.
3. **Tope por usuario y día** de filas rechazadas guardadas.
4. **Rate limiting** de `/sync/push` con un binding nuevo.

## Decisión

### 1. Página acotada por filas **y** por bytes (A.4, con A.3 como respaldo)

**Constantes** en `apps/worker/src/cron/backup.ts`:

- `TAMANO_PAGINA = 2000` se mantiene; la prueba de la ADR 0016 sigue esperando 2000.
- `MAX_BYTES_PAGINA = 4 * 1024 * 1024` (4 MiB, medidos en SQL).
- `MIN_FILAS_MEDICION = 64`.
- Se pueden inyectar en las pruebas por `OpcionesBackup`: `tamanoPagina` (ya existe), `maxBytesPagina` (nueva).

**Columnas por tabla.** `TablaBackup` (`apps/worker/src/cron/tablas.ts`) gana `columnas: readonly string[]`, con **todas** las columnas de la tabla.

- La prueba "pagina por la clave primaria exacta" (`fase6-cron-backup.test.ts:46-58`) se amplía para comprobar que `columnas` coincide exactamente con `pragma_table_info(tabla)`.
- **`login_cupos`** (migración `0007_login_cupos.sql`, ítem M1) entra en `TABLAS_BACKUP`:
  - `pk: ['user_id', 'origen']`.
  - `columnas: ['user_id', 'origen', 'fallos', 'ventana_inicio', 'bloqueado_hasta', 'reserva_id', 'created_at', 'updated_at']`.
  - Va entre `refresh_tokens` y `devices`: es hija de `users`, así que va antes.
  - Sin ella falla la prueba de cobertura `fase6-cron-backup.test.ts:34-44`.

**Tamaño estimado de una fila**, en bytes: la suma por columna de `COALESCE(octet_length(<col>), 0)`, más una constante por tabla calculada en JS: `Σ (longitud(nombre) + 6)`.

- `octet_length` (SQLite ≥ 3.43) devuelve los bytes de un texto o un blob. SQLite puede responderlo con la cabecera del registro, sin leer el contenido de las páginas de desbordamiento.
- `length(CAST(col AS BLOB))`, en cambio, obliga a leer el valor completo.
- **Se verifica en la fase 2**, y el resultado queda en `docs/notas-plataforma.md`:
  1. `SELECT sqlite_version(), octet_length('ñ')` en la D1 local de workerd. Lo esperado es una versión ≥ 3.43 y `2`.
  2. Que `octet_length` está disponible en D1. Se revisa la documentación oficial de D1 sobre funciones SQL compatibles. No se puede probar contra la D1 remota.
  3. Si no está disponible, se usa `length(CAST(col AS BLOB))`. La lectura de más que eso provoca queda acotada por la ventana adaptativa, que se aplica en ambos casos.

**Ventana de medición adaptativa.** La subconsulta `tam` no mide siempre 2000 filas. Mide `L` filas, con `L` entre `MIN_FILAS_MEDICION` y `TAMANO_PAGINA`:

- Valor inicial de cada tabla: `L = MIN_FILAS_MEDICION`. Se persiste en `TablaEnCurso.filas_medicion`, así una continuación sigue con el último valor.
- Después de cada página con `n` filas devueltas:
  - Si se cortó por bytes (`__bk_n < __bk_total`): `L = clamp(2·n, MIN_FILAS_MEDICION, TAMANO_PAGINA)`.
  - Si no: `L = min(2·L, TAMANO_PAGINA)`.
- Con filas pequeñas, la ventana llega a 2000 en cinco páginas. Con filas de 64 KiB queda en ~128 filas. Por página, SQLite lee como mucho ~2 páginas de datos.
  - Con 2500 filas de 64 KiB son ~40 páginas de ~8 MB leídos cada una, en lugar de ~128 MB cada una.

**Sentencia de página** (`sentenciaPagina`), con forma fija. Para una PK simple `pk`:

```sql
WITH tam AS (
  SELECT pk, (<expresión de tamaño> + <constante>) AS b
  FROM <tabla> WHERE <condición de cursor> ORDER BY pk LIMIT ?L
), acum AS (
  SELECT pk, SUM(b) OVER (ORDER BY pk ROWS UNBOUNDED PRECEDING) - b AS antes,
         COUNT(*) OVER () AS total
  FROM tam
), corte AS (
  SELECT pk FROM acum WHERE antes < ?maxBytes ORDER BY pk DESC LIMIT 1
)
SELECT t.*, (SELECT total FROM acum LIMIT 1) AS __bk_total,
       (SELECT COUNT(*) FROM acum WHERE antes < ?maxBytes) AS __bk_n
FROM <tabla> AS t
WHERE <condición de cursor> AND t.pk <= (SELECT pk FROM corte)
ORDER BY pk
```

- PK compuestas: se usa la comparación de filas, `(a, b) <= (SELECT a, b FROM corte)`, con `ORDER BY a DESC, b DESC` en `corte`.
- `antes < maxBytes` incluye siempre la primera fila, así que una fila más grande que el límite no bloquea la tabla.
- Las tablas temporales del CTE solo guardan PK y enteros.
- Antes de serializar se quitan `__bk_total` y `__bk_n`. La prueba comprueba que ninguna columna real empieza por `__bk_`.

**Fin de tabla y avance:**

- La tabla termina si la página llega vacía, o si `__bk_n === __bk_total` y `__bk_total < L`. En ese caso no quedan más filas tras el cursor, sea cual sea `L`.
- Si `__bk_n === __bk_total === L`, puede haber más filas: el cursor avanza a la última fila devuelta y `L` crece.
- Si `__bk_n < __bk_total`, quedan filas: el cursor avanza a la última fila devuelta.

**Respaldo:** si D1 rechazara la CTE con funciones de ventana, se usa A.3 y se anota en `docs/notas-plataforma.md`.

**Presupuesto de memoria**, en el peor caso:

- Página: 4 MiB medidos, más una fila de ~2 MB.
- El escape JSON la multiplica hasta ×2, y el UTF-16 de JS otro ×2.
- A eso se suma el trozo en curso (1 MiB) y la parte de R2 (5 MiB).
- Total: **< 40 MiB**.

### 2. Escritura por partes (B.2)

- `ndjson(filas)` se reemplaza por un bucle:
  1. Cada fila se codifica con `TextEncoder` (`JSON.stringify(fila) + "\n"`) y se agrega a un trozo.
  2. Cuando el trozo llega a `TAMANO_TROZO_BYTES = 1 MiB`, se hace `await escritor.write(trozo)`.
  3. Al final de la página se escribe el resto.
- Los bytes descomprimidos son idénticos a los de hoy.

### 3. Aislamiento de una tabla que falla de forma persistente (C.2)

**Estado nuevo.** Constante `MAX_INTENTOS_TABLA = 3`. `ProgresoBackup` gana dos campos:

- `intentos: Record<string, number>`.
- `incompletas: { tabla: string; motivo: string; intentos: number }[]`.

`motivo` es `describirError(error)` (`cron/ejecutar.ts`, truncado a 300 caracteres y sin datos personales). Puede moverse a un módulo común. Si el último intento murió sin un error capturado, `motivo` vale `'invocación interrumpida sin error capturado'`.

**Algoritmo por tabla:**

1. Si `intentos[tabla] >= MAX_INTENTOS_TABLA`:
   - La tabla se marca `incompleta` y se agrega a `incompletas` y a `terminadas`.
   - `en_curso` pasa a `null`, se guarda el progreso y se registra `registrar('error', 'backup_tabla_incompleta', { fecha, tabla, intentos, motivo })`.
   - Se sigue con la tabla siguiente **en la misma invocación**.
2. Si no, `intentos[tabla] += 1` y **se guarda `progreso.json` antes de exportar** (una operación de R2 por tabla e invocación). Así cuenta también una muerte por memoria o por CPU.
3. Si la tabla termina: se borra `intentos[tabla]`.
4. Si la tabla se pausa:
   - Si el cursor avanzó en este intento: `intentos[tabla] = 0`.
   - Si no avanzó: se restaura el valor anterior.
5. Si hay un error capturado:
   - La tabla se reinicia desde cero, como hoy (`en_curso = null`, subida abandonada), y se guarda el motivo.
   - Si `intentos < MAX`, se guarda el progreso y se lanza el error (se registra `backup_fallido`, como hoy).
   - Si no, se aplica el paso 1 en la misma invocación.

**Manifest (`formato: 2`).**

- Nivel global: `estado: 'completo' | 'parcial'`.
- Cada entrada de `tablas`: `estado: 'completa' | 'incompleta'`. Una incompleta es `{ tabla, estado: 'incompleta', motivo, intentos }`, sin archivo, conteo ni hash.
- El manifest se escribe cuando **todas** las tablas están `completa` o `incompleta`.
- Un día sin manifest sigue siendo un backup sin terminar. El log `backup_incompleto_del_dia` de las 13:00 UTC no cambia.

**`ResultadoBackup`** gana su propio estado:

```ts
{ estado: 'parcial'; fecha; tablas; filas; bytes; operaciones; tablas_incompletas: string[] }
```

- `ejecutarCron` lo registra como `registrar('error', 'backup_parcial', { fecha, tablas_incompletas })`.
- `ResultadoCron.backup` admite `'parcial'`.
- En la última continuación del día, `'parcial'` cuenta como terminado: no se registra `backup_incompleto_del_dia`.
- El manifest existe, así que el día no se reintenta.

**Restaurar un parcial:** lo decide la ADR 0021. Solo se admite si todas las tablas incompletas son `sync_mutations`, `login_cupos` o `refresh_tokens`. Las dos primeras son operativas; la tercera no se restaura.

**Alertas:** `docs/despliegue.md` §7 suma `backup_tabla_incompleta` y `backup_parcial`.

### 4. Recorte de `payload_json` de las mutaciones no aplicadas (D.2; no se implementa D.3)

**Constante** nueva en `push.ts`: `MAX_PAYLOAD_NO_APLICADA_BYTES = 16 * 1024`.

**`payloadJson(mutacion)`:**

- Si la mutación serializada mide 16 KiB o menos, se guarda entera.
- Si mide más, se guarda este JSON reducido:

  ```json
  { "recortado": true, "motivo": "supera 16 KiB", "tamano_bytes": <n>,
    "tipo": "<tipoDeclarado>",
    "payload": { "id": "<solo si es UUID v7>", "consumption_id": "<solo si es UUID v7>" } }
  ```

  Reemplaza al marcador `{ omitido, motivo, tamano_bytes }` que hoy se usa por encima de 64 KiB.
- Se omite toda clave de `payload` que no sea un UUID v7.
- Se conserva `json_extract(payload_json, '$.payload.id')`. Lo usan `CONSULTA_CREACION_NO_APLICADA` y el índice de la migración 0006.

**Por qué no se pierden datos de planta.** Solo se recorta lo que **no se aplicó**, y la mutación sigue en el outbox del cliente. El recorte solo quita la copia forense del servidor.

Una mutación válida, en su forma normalizada, mide menos de 16 KiB. En el peor caso de escape JSON:

- El esquema (`textoSchema`, `tieneCaracteresDeControl` en `packages/shared/src/esquemas.ts`) rechaza los caracteres de control salvo `\n` y `\t`, que se escapan a 2 bytes. `"` y `\` también se escapan a 2 bytes.
- Lo más caro son los **sustitutos UTF-16 sueltos**. El esquema no los rechaza, y `JSON.stringify` los escapa como `\udXXX`: 6 bytes por unidad.
- La descripción admite 2000 unidades, así que como mucho 12 000 bytes. Con el resto de los campos y 5 evidencias, la mutación queda por debajo de 16 KiB.

**Prueba.** Construye la mutación válida más grande de cada tipo: cada campo de texto al máximo de unidades, todas sustitutos sueltos (el peor escape). Comprueba que `mutacionSchema` la acepta y que `tamanoSerializado` ≤ `MAX_PAYLOAD_NO_APLICADA_BYTES`.

**Límite conocido.** Un cliente puede agregar espacios alrededor de los textos. `trim` los quita antes de validar el largo, así que una mutación "válida" en crudo podría pasar de 16 KiB. Si se rechaza o entra en conflicto, se recorta. No es dato de planta (el servidor lo descarta al normalizar). Queda documentado en el comentario de `payloadJson`.

**Efecto.** Cada fila rechazada pesa como mucho ~17 KiB, en lugar de 64 KiB.

**Tope por usuario y día (D.3): evaluado y no se implementa.**

- La caída del backup ya la resuelven los puntos 1 a 3.
- El crecimiento es lineal y visible en el log `tamano_base`.
- Un tope rompe la detección de `DEPENDENCIA_RECHAZADA` y exige un número de negocio que la spec no define.
- La recomendación D.4 (binding de Rate Limiting para `/sync/push`) queda en `docs/pendientes-humanos.md`.

### 5. Instrumentación inyectable (sin `Proxy` sobre D1)

`OpcionesBackup` gana dos ganchos, como `tamanoPagina`, que solo usan las pruebas:

- **`observarPagina?: (info: { tabla: string; filas: number; bytesNdjson: number; filasMedicion: number }) => void`**
  - Se llama una vez por página, después de serializarla.
  - `bytesNdjson` son los bytes UTF-8 del NDJSON de la página, es decir, lo que la página ocupó en memoria del Worker.
- **`fallarEn?: (tabla: string) => void`**
  - Se llama al empezar cada página. Si lanza, simula un fallo de esa tabla.
  - La D1 y el R2 siguen siendo los reales.

**La cota de memoria se prueba con el medidor, no con el runtime.** workerd en local (Miniflare y el pool de Vitest) no aplica el límite de 128 MB de producción. Por eso una página enorme no revienta en las pruebas. La prueba falla porque `observarPagina` registra una página por encima de la cota, no por falta de memoria. Se dice así en el comentario de la prueba.

### 6. Pruebas

**Nuevas** (deben fallar con el código actual):

- `apps/worker/test/fase6-cron-bytes.test.ts`, carga grande:
  - Siembra 2500 filas de `sync_mutations` con `payload_json` de ~64 KiB, con usuario y dispositivo reales, en lotes.
  - Ejecuta el backup con `observarPagina`.
  - Comprueba:
    - El estado es `'completo'`.
    - `verificarBackupCompleto` pasa: conteos y sha256.
    - Ninguna página supera `2 · MAX_BYTES_PAGINA + 2 MB` de `bytesNdjson`.
    - En `sync_mutations`, `filasMedicion` nunca pasa de 256: la ventana adaptativa no mide 2000 filas de 64 KiB.
  - Tiempo de espera: 180 s.
  - Hoy falla: una página de 2000 × 64 KiB registra ~128 MiB.
- La misma prueba, con un `maxBytesPagina` pequeño: una fila más grande que el límite sale sola en su página.
- Tabla que falla siempre: `fallarEn` lanza para `sync_mutations`.
  - Comprueba `MAX_INTENTOS_TABLA` intentos.
  - `sync_mutations` queda `incompleta` con `motivo`, y las demás tablas `completa` (verificación por tabla).
  - El manifest queda `parcial` y el resultado tiene `estado: 'parcial'`.
  - Se registran los logs `backup_tabla_incompleta` y `backup_parcial`.
- Muerte sin `catch`: con un `progreso.json` con `intentos: { sync_mutations: 3 }`, la tabla queda `incompleta` sin tocarse y las demás terminan.
- Recorte en push:
  - Un rechazo de 20 KiB se guarda reducido, con `$.payload.id`.
  - Uno de 10 KiB se guarda entero.
- La mutación válida más grande con el peor escape mide ≤ 16 KiB.

**Cambios de contrato deliberados en pruebas existentes.** Se explican en el mensaje del commit:

| Prueba | Antes | Después |
|---|---|---|
| `fase6-cron-backup.test.ts:129` | `manifest.formato` es `1` | Es `2`. Además se comprueba `estado: 'completo'` y el estado de cada tabla, y `corte`/`seq_final` (ADR 0021). |
| `fase6-cron-backup.test.ts:60-75` | Orden "hijos antes que padres" | Orden nuevo: `login_cupos` entre `refresh_tokens` y `devices`, y `audit_log` al final (ADR 0021). Cambia el nombre de la prueba. |
| `fase6-cron-backup.test.ts:34-44` | Cobertura de tablas | Sin cambios en la prueba. Pasa porque se agrega `login_cupos`. |
| `fase6-cron-backup.test.ts:46-58` | Compara la PK | Compara también `columnas`. |
| `fase6-cron-helpers.ts:106` (`verificarBackupCompleto`) | Exige un archivo por cada tabla de `TABLAS_BACKUP` | Exige `estado: 'completo'`. Gana una variante que admite tablas `incompleta` listadas, para la prueba del parcial. |
| `fase6-cron-helpers.ts:73-91` (`leerTabla`) | Recibe la entrada del manifest | El tipo de la entrada pasa a ser la unión completa/incompleta: solo acepta entradas `completa`. |
| `fase6-cron-continuacion.test.ts:61-73` | Constantes | Se agregan `MAX_BYTES_PAGINA`, `MIN_FILAS_MEDICION` y `MAX_INTENTOS_TABLA`. |
| `fase6-cron-continuacion.test.ts:93-115` | `seq_final` = `MAX(seq)` al terminar | `seq_final` = `MAX(seq)` al **empezar** `audit_log` (ADR 0021). |
| `fase6-cron-backup.test.ts:291-311` | La tabla en curso que falla se reinicia y la siguiente completa | Se mantiene. Comprueba además el contador `intentos`. |
| `fase6-cron-mantenimiento.test.ts` y las pruebas de `ResultadoCron` (`toEqual({ backup: … })`) | — | Sin cambios, salvo si el tipo nuevo `'parcial'` obliga a ampliar alguna unión. |
| `fase3-push.test.ts:293` | Marcador `omitido: true` | JSON reducido `recortado: true`, con `payload.id`. |

## Consecuencias

- El backup ya no depende del tamaño de las filas.
  - La memoria del Worker queda acotada por la página.
  - Lo que lee SQLite queda acotado por la ventana adaptativa, y por `octet_length` si D1 lo tiene.
  - Una tabla patológica queda `incompleta` como mucho a la tercera invocación, y las demás se respaldan.
- **Costo en D1:** una consulta por página. Las tablas de filas pequeñas tardan cinco páginas en llegar a 2000 filas, unas pocas consultas más por tabla. Las tablas de filas grandes hacen más páginas, pero pequeñas.
- **Costo en R2:** una operación más por tabla e invocación, unas 15 por día.
- **El manifest pasa a `formato: 2`**, obligatorio para el script de restauración de la ADR 0021.
- **`payload_json` de las no aplicadas** de más de 16 KiB solo conserva el resumen.
- **Un backup `parcial` tiene manifest.** El script de la ADR 0021 mira `estado` antes de restaurar.

## Cómo revertir

- **Página por bytes:** quitar la CTE, la ventana adaptativa y los ganchos, y volver a `ndjson(filas)`. No hay datos persistidos que migrar.
- **Aislamiento:** quitar `intentos` e `incompletas`, y volver a lanzar siempre. Un `progreso.json` nuevo se lee ignorando los campos de más.
- **Recorte:** volver a 64 KiB y al marcador `omitido`. Las filas ya recortadas no se reconstruyen, pero no contenían datos aplicados.

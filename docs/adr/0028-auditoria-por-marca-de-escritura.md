# ADR 0028 — La auditoría se condiciona a una marca de escritura

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.2 (ítem A1)
- Enmienda: ADR 0010 (integridad y orden en la auditoría), el patrón "sentencia principal + cadena condicional" de `apps/worker/src/dominio/plan.ts` y la ADR 0021 (columnas del backup). Generaliza el `reserva_id` de la ADR 0018.
- Segunda opinión: `software-architect`, 2026-10-30, "aprobar con cambios". Todos los cambios pedidos (R1 a R8 y las enmiendas 1 a 11 de su informe) están incorporados abajo.

## Contexto

Toda escritura de negocio inserta su fila de `audit_log` en el mismo `db.batch()` (spec §4, ADR 0010). Cuando la escritura es condicional (la sentencia principal lleva en su `WHERE` lo que el comando leyó), la auditoría y las sentencias dependientes se escriben con `INSERT … SELECT … WHERE <condición>`, para que nada quede escrito si la principal no aplicó.

Hoy esa condición compara el **estado final** del registro, casi siempre con una hora igual a `ctx.ahora` (`updated_at`, `subido_at`, `server_received_at`, `revocado_at`…), o con valores (`version`, `nombre`, `costo`…). En Workers la hora se congela durante cada petición y tiene resolución de milisegundos. Dos peticiones concurrentes pueden calcular el mismo `ahora` y escribir los mismos valores:

1. A aplica su UPDATE y su auditoría.
2. B (mismo `ahora`, mismo estado leído) no cambia filas, pero ve el registro "como ella lo habría dejado" y **escribe igual su auditoría**.
3. El batch de B se confirma. Después `ejecutarPlan` ve `changes = 0` y responde conflicto o idempotente, pero la fila falsa ya está en `audit_log`, que es inmutable.

El CI del PR #1 lo mostró: 5 subidas simultáneas de la misma foto dejaron 3 filas `evidencia.subida`. El caso grave es la edición concurrente de un consumo con la misma `version`: el perdedor recibe `CONFLICTO` pero la auditoría dice que también editó.

**El defecto no depende solo del mismo milisegundo.** Algunas condiciones no usan la hora: la de las validaciones (`dominio/validaciones.ts`) compara `id` y `validado_por`, y el `id` lo manda el cliente. Dos validaciones concurrentes de la misma mutación con horas distintas también auditan de más.

El mismo defecto afecta a todo lo que el batch condiciona igual que la auditoría: la fila `sync_mutations` como `aplicada` del push (`condicionAplicada` en `sync/push.ts`), las filas hijas y las lecturas de verificación `filasEsperadas` (B11), que deciden la respuesta.

Hay un precedente correcto: los cupos de login (ADR 0018) generan un `reserva_id` aleatorio por petición, lo fijan en la sentencia principal y condicionan la auditoría a `reserva_id = ?`. Ninguna otra petición puede producir ese valor.

## Opciones consideradas

1. **(a) `changes()` de SQLite justo después de la principal.** Sin migración. Se descarta:
   - depende de que D1 ejecute las sentencias del batch en la misma conexión, en orden y sin sentencias internas entre ellas. No está documentado como garantía, y solo se puede comprobar en staging;
   - `changes()` se refiere solo a la sentencia **inmediatamente anterior**: la segunda dependiente tendría que encadenarse sobre la anterior, y cualquier sentencia intercalada rompe la cadena en silencio;
   - D1 cuenta en `meta.changes` las filas de los triggers y `changes()` no (`docs/notas-plataforma.md`);
   - no se puede comprobar con una prueba estática que la sentencia anterior sea la correcta.
2. **(b) Marca de escritura única en la fila escrita.** Columna `escritura_id TEXT` (anulable) agregada con `ALTER TABLE … ADD COLUMN`. La principal la fija con un UUID v7 nuevo, y toda auditoría y dependiente comprueba `escritura_id = ?`. Solo el batch que escribió ese valor lo encuentra.
3. **(c) Auditoría previa con el mismo predicado que la principal.** La auditoría va antes de la principal y se condiciona al estado previo. Es correcta porque los batches de D1 son serializables, y el código ya la usa en cuatro sitios (`auth/sesiones.ts` y `auth/cupos.ts`). Pero obliga a duplicar exactamente el `WHERE` de cada principal: si los dos predicados se separan, el defecto vuelve sin que nada lo detecte.
4. **(d) Auditoría primero y principal encadenada al id de la auditoría** (`… AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`). Sin migración, pero si los predicados se separan falla en la peor dirección: queda una auditoría sin cambio.
5. **(e) Índice `UNIQUE` en `audit_log`** (por ejemplo, entidad, id, acción y hora). No cubre las condiciones que no usan la hora (validaciones) ni las acciones que pueden repetirse legítimamente, y convertiría una carrera en un error del batch.

## Decisión

Se adopta la **opción (b)**, con una definición general de "marca".

1. **Qué es una marca.** Un valor que **solo** la sentencia principal de este batch puede haber escrito en la fila. Se admiten cuatro, creados únicamente por constructores de `auditoria/auditar.ts`:
   - `porMarca(tabla, clave, escrituraId)`: la columna `escritura_id` nueva, con un UUID v7 generado por el servidor;
   - `porPkNueva(tabla, clave)`: una clave primaria **generada por el servidor** en esa misma sentencia (por ejemplo, el `nuevoId` de `emitirSucesor` en `auth/sesiones.ts`). Un id que manda el cliente (consumos, novedades, validaciones) **nunca** es una marca;
   - `porReserva(userId, origen, reservaId)`: el `reserva_id` de `login_cupos` (ADR 0018);
   - `porAuditoria(auditoriaId)`: la existencia de una fila de auditoría de este mismo batch, con su UUID v7, para encadenar dependientes.
   El rehash de la contraseña puede usar `porMarca`; su `password_hash` lleva sal aleatoria, pero se unifica con el mecanismo general.
2. **Esquema.** Migración `0009_marca_de_escritura.sql`, escrita a mano, solo con `ALTER TABLE <tabla> ADD COLUMN escritura_id TEXT;` (precedente: `0003`). Tablas: `users`, `refresh_tokens`, `settings`, `materials`, `production_orders`, `order_supervisors`, `order_planned_materials`, `consumptions`, `incidents`, `evidences` y `validations`. No se agrega a `devices` (su escritura auditada es incondicional) ni a `login_cupos` (ya tiene `reserva_id`). No toca triggers ni reconstruye tablas. El esquema de Drizzle se actualiza igual (`esquema-vs-migraciones.test.ts`).
   - Los triggers de UPDATE listan columnas concretas, así que no bloquean `escritura_id` en las escrituras permitidas y siguen bloqueando todo lo demás. `validations` e `incidents` la fijan solo en el `INSERT`.
   - El trigger `validations_aplica_decision` actualiza `consumptions` sin fijar su marca. Por eso las auditorías de aprobar y rechazar, y la lectura B11, se condicionan a `validations.escritura_id`. `consumptions.escritura_id` es la marca de la última escritura **directa**, no de la última escritura.
   - Las filas anteriores a la migración quedan con `NULL`. Ninguna condición compara con `NULL`, porque cada marca es nueva.
3. **Una marca por sentencia principal auditada.** No basta una por petición (`/sync/push` ejecuta varios planes en la misma petición) ni una por plan (el login escribe `users` dos veces en el mismo batch: rehash y desbloqueo). **Regla de orden**: la auditoría y las dependientes de una principal van después de ella y antes de cualquier otra sentencia del batch que reescriba la marca de esa misma fila.
4. **Auditorías con estado previo.** Se convierten al mecanismo; no quedan excepciones:
   - el desbloqueo heredado en el login (`users`) pasa a un UPDATE propio, `WHERE id = ? AND bloqueado_hasta IS NOT NULL`, que fija la marca; `intentos_fallidos` va en otro UPDATE sin auditar;
   - en `login_cupos`, los reinicios (tras login y del admin) fijan un `reserva_id` nuevo y la auditoría se condiciona a él;
   - la revocación de familias ajenas al iniciar sesión fija la marca en `refresh_tokens` y audita después.
5. **Filas hijas.** Pueden encadenarse a la marca del padre solo si su `WHERE` es exactamente la condición del padre (evidencias de una novedad, materiales planeados de una orden). Si tienen un predicado propio (cambios de asignaciones), llevan su propia marca.
6. **Un tipo opaco, no texto SQL.** `CondicionDeEscritura` es un tipo con marca (*branded*) que solo crean los cuatro constructores. Es el tipo del parámetro de `sentenciaAuditoriaCondicional` y del helper para dependientes, así que el compilador exige el mecanismo, y además hay una comprobación en tiempo de ejecución. Las dependientes que hoy interpolan `${condicion.sql}` (`/sync/push`, `sentenciaRevocarTodas`, el reinicio de cupos del admin) reciben esta condición.
   - Respaldo estático (`apps/worker/test/correcciones-a1-*.test.ts`, sobre `TEST_ARCHIVOS_FUENTE`): ningún `INSERT INTO audit_log` fuera de `auditar.ts`, ningún literal `{ sql:` pasado a esos helpers, y ninguna condición `EXISTS` con `_at = ?`.
   - La garantía real es la prueba del "plan perdedor" por familia.
7. **Lo que se decide después del batch.** `principalAplico` con `cambiosEsperados` lee `meta.changes` de su propia sentencia: no depende de coincidencias. Las lecturas `filasEsperadas` (B11) y `condicionAplicada` de `/sync/push` pasan a la marca.
8. **La columna es interna.**
   - Los tipos `Fila*` del esquema la omiten (`Omit<…, 'escritura_id'>`). Las funciones que copian la fila entera (`consumoDe`, `materialDe`, `usuarioDe`) no pueden devolverla.
   - No entra en ninguna lista `COLUMNAS_*` ni en `COLUMNAS_AUDITABLES`. Se bindea como columna aparte.
   - Una prueba comprueba que `escritura_id` no aparece en las respuestas REST, de `/sync/push`, `/sync/pull` y del snapshot, ni en `datos_antes`/`datos_despues` de la auditoría.
   - Sin fuga no hay cambio de contrato: los clientes v1.0 y v1.1 no notan nada.
9. **Backup y restauración (enmienda a la ADR 0021).** La columna **no se exporta**. `TablaBackup` gana un campo `columnasTecnicas` (las columnas del esquema que el backup omite a propósito), y la prueba de cobertura de `fase6-cron-backup.test.ts` exige `columnas ∪ columnasTecnicas` = columnas del esquema. La restauración (`scripts/restauracion-nucleo.mjs`) usa la lista de `columnas`, así que la deja en `NULL`, y no la usa en la reversión ni en las verificaciones.
10. **Pruebas.**
    - Por cada familia (subir evidencia; editar consumo por REST y por push; crear consumo duplicado; validar; materiales; órdenes; settings; asignaciones; usuarios; revocación de familias; desbloqueo y rehash en el login; cupos), dos planes o dos batches con el **mismo `ahora`**, construidos sobre el mismo estado inicial y ejecutados uno tras otro: exactamente 1 fila de auditoría y ninguna del perdedor.
    - La **novedad duplicada** no puede fallar antes de la corrección: su INSERT con `VALUES` aborta el batch por la clave primaria. Se cubre con la prueba (que pasa antes y después) y se documenta así, sin forzar una prueba roja.
    - La prueba de B4 deja de depender del azar: una variante fuerza dos confirmaciones con el mismo `ahora`.
11. **Detección en una base existente** (`docs/despliegue.md`): contar más de una fila por `(entidad, entidad_id, accion)` en las acciones que ocurren una sola vez por entidad, sea cual sea `server_at` (los `*.crear`, `evidencia.subida`, `validacion.crear`, aprobar y rechazar, iniciar y finalizar una orden), y la misma `version` en `datos_despues` de más de un `consumo.editar`.

## Consecuencias

- La auditoría queda ligada a que **esa misma** sentencia hizo el cambio, sin depender de horas, valores ni del orden interno de D1 más allá de la atomicidad y la serialización del batch, que ya son premisas de la ADR 0010.
- Una migración nueva, solo aditiva. Las bases existentes no necesitan un backfill.
- Cada escritura auditada fija una columna más (36 bytes por fila).
- Las filas falsas que ya existan en una base no se corrigen (la auditoría es inmutable); solo se detectan con las consultas de `docs/despliegue.md`.
- Pendiente en staging (`docs/pendientes-humanos.md`): aplicar `0009` sobre la D1 remota y repetir la prueba de concurrencia de B4 contra ella.

## Cómo revertir

Volver a las condiciones por valor en un commit `revert:`. La columna `escritura_id` puede quedarse: es anulable y nadie la lee fuera de estas condiciones. Las pruebas deterministas de A1 volverían a fallar, y eso documenta el riesgo que se reabre.

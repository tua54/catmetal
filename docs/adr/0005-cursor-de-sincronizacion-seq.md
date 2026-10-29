# ADR 0005 — `audit_log.seq` como cursor de sincronización

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 1

## Contexto

`GET /api/v1/sync/pull` debe entregar a cada dispositivo los cambios que le interesan (validaciones, órdenes, asignaciones, catálogos) desde su último punto de sincronización, sin perder ni repetir cambios. Toda escritura de negocio inserta una fila en `audit_log` en el mismo `db.batch()` (§4).

## Opciones consideradas

1. **Marca de tiempo (`updated_at`)** por tabla. Dos escrituras en el mismo milisegundo, relojes desfasados entre ubicaciones o escrituras que se confirman fuera de orden harían perder cambios.
2. **Versión por fila** y una consulta por tabla. Obliga a recorrer muchas tablas y no detecta revocaciones de visibilidad.
3. **`audit_log.seq INTEGER PRIMARY KEY AUTOINCREMENT`** como cursor global.

## Decisión

Opción 3. `seq` es un entero monótono asignado por SQLite al insertar. **Es válido como cursor porque cada base D1 aplica las escrituras en serie** (un solo escritor, sin transacciones concurrentes): una fila con `seq = n` siempre se confirma antes que cualquier fila con `seq > n`, así que un lector que vio `seq = n` nunca verá aparecer después un `seq < n`. `AUTOINCREMENT` además garantiza que nunca se reutiliza un valor.

Reglas del pull (incorporan la revisión de `software-architect` del 2026-10-29):

1. **Ventana**: `SELECT seq, entidad, entidad_id, accion FROM audit_log WHERE seq > :cursor ORDER BY seq LIMIT 1000`, leída del primario (sin réplicas de lectura).
2. **Visibilidad**: se calcula una vez por petición con el estado **actual** (rol actual y asignaciones activas) y se aplica en JS fila por fila. **Nunca** se filtra en SQL, porque entonces no se sabría cuál fue el último `seq` revisado. El supervisor ve siempre, además, los consumos que él registró y sus validaciones, novedades y evidencias, aunque ya no tenga la orden asignada.
3. **Cupo**: se recorre la ventana en orden y se deduplica por (`entidad`, `id`). Al llegar a 200 entidades distintas se detiene y el cursor es el `seq` de esa fila. Si la ventana termina, el cursor es el `seq` de su última fila (o el cursor recibido si vino vacía). **El nuevo cursor es el último `seq` revisado**, no el último devuelto.
4. `hay_mas = (se detuvo por cupo) OR (la ventana trajo 1000 filas)`.
5. **Estado actual**: los cambios llevan el estado actual de la entidad (no el diff de auditoría), leído en un solo `db.batch()` con `json_each(?)` para no superar 100 parámetros por sentencia. Si la entidad ya no es visible, se envía `revocar`.
6. **Eventos de visibilidad** para quien pide: asignación a una orden → `hidratar` (`production_orders`, id); desasignación → `revocar`; cambio de rol o reactivación → `reiniciar`. El cliente atiende `hidratar` y `reiniciar` dentro del mismo candado de sync con un snapshot paginado. Así un supervisor recién asignado recibe el histórico de la orden, que su cursor ya había pasado.
7. **Snapshot** (arranque con cursor 0, hidratación o reinicio): en un solo `db.batch()`, **primero** `SELECT MAX(seq)` y **después** el estado. El cursor resultante es ese `MAX(seq)`; los cambios posteriores se vuelven a entregar y aplicarlos es idempotente.
8. **Invariante**: toda escritura sobre una entidad sincronizable inserta una fila de `audit_log` **por entidad modificada** en el mismo batch (incluido marcar una evidencia como subida). Hay una prueba.
9. **Época**: cada respuesta lleva `epoca` (ADR 0009). Si cambia, el cliente reinicia su estado.

## Consecuencias

- **Advertencia de portabilidad**: este razonamiento no vale en una base con escrituras concurrentes (PostgreSQL, MySQL con varias conexiones), donde una secuencia puede confirmarse fuera de orden. Si se migra, habrá que usar un cursor por transacción (por ejemplo `pg_snapshot`/`xmin`) o un registro de cambios con confirmación ordenada.
- La carga inicial usa el snapshot (regla 7). El seed escribe igual su auditoría (con ids deterministas) para mantener el invariante.
- Una restauración con Time Travel hace retroceder `seq`: la cubre la época de sync (ADR 0009).
- `audit_log` crece sin límite (nada se borra); el índice por `seq` es la clave primaria.

## Cómo revertir

Agregar una columna `version` por tabla y un endpoint de pull por entidad; el cliente guardaría un cursor por tabla.

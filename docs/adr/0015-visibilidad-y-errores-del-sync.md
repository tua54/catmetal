# ADR 0015 — Visibilidad de usuarios, revocación y clasificación de errores en el sync

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 3
- Complementa: ADR 0005, 0009

## Contexto

Al implementar `/sync/push`, `/sync/pull` y `/sync/snapshot` (tareas 3.1–3.2) quedaron decisiones no cubiertas por la ADR 0005/0009: qué datos de usuarios viajan al cliente, cuándo se envía `revocar`, qué hacer con un payload demasiado grande y cómo tratar la contención agotada entre pushes concurrentes.

## Opciones consideradas y decisión

1. **Usuarios en pull y snapshot**: solo `id`, `nombre`, `rol`, `activo` (nunca correo, hash, intentos ni bloqueo; ADR 0013 y Ley 1581). Jefe y admin ven a todos; el supervisor se ve a sí mismo y a jefes y admins (para mostrar quién validó); los nombres de otros supervisores le llegan en `order_supervisors.nombre`. Si un jefe o admin pasa a supervisor, los supervisores reciben `revocar` de ese usuario.
2. **`revocar` solo de lo que pudo ser visible**: se envía para entidades de una orden que el usuario tuvo asignada (asignación ahora inactiva). Lo que nunca pudo ver se omite sin enviar nada (un supervisor ajeno a 300 filas recibe cero cambios y su cursor avanza). Al desasignar se envía `revocar` de la orden y de la asignación; el cliente borra en cascada lo ajeno de esa orden y conserva lo propio (ADR 0005 regla 2). No se enumera el histórico ajeno de la orden (no tiene límite).
3. **Payload > 64 KiB**: la mutación se rechaza con `VALIDACION`; en `payload_json` se guarda un marcador `{ omitido, motivo, tamano_bytes }` en lugar de truncar (un JSON truncado no es válido). Una mutación legítima nunca llega a ese tamaño (los textos tienen tope y las fotos van aparte).
4. **Contención agotada**: si la sentencia principal no aplica en 3 intentos por cambios concurrentes (p. ej. el acumulado de tolerancia cambió cada vez), se trata como **transitorio** (el lote se detiene y la mutación sigue pendiente en la tablet), no como `conflicto`: el dato de planta no se marca como rechazado por una carrera.
5. **`devices.ultimo_sync_at` no se audita**: es un metadato operativo; auditarlo añadiría una fila por sincronización que el pull tendría que recorrer.

## Consecuencias

- El cliente nunca guarda correos de otros usuarios.
- Un supervisor reasignado recibe el histórico por `hidratar` + snapshot de la orden.
- La detección de dependencias rechazadas guardadas recorre `sync_mutations` del usuario con `json_extract` (solo ante `NO_ENCONTRADO` en una mutación dependiente); si crece, se añade un índice por expresión.

## Cómo revertir

Cada punto está aislado en `apps/worker/src/sync/{pull,snapshot,push,entidades}.ts`.

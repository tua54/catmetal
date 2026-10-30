# ADR 0009 — Época de sincronización y contrato robusto de `/sync/push`

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 1 (el contrato se usa en la Fase 3)
- Enmendado por: ADR 0022 (snapshot en un área temporal y autoridad del servidor tras un cambio de época o un reinicio).

## Contexto

La revisión de `software-architect` (2026-10-29) encontró dos riesgos altos de pérdida de datos de planta:

1. **Restauración con Time Travel** (primera línea de backup, §4): al volver a un punto anterior, `audit_log.seq` retrocede. Los clientes con un cursor mayor se saltarían todo lo que se escriba después, y las mutaciones que el cliente ya marcó como `aplicada` y que se escribieron después del punto restaurado desaparecerían del servidor sin que nadie lo note.
2. **Lote atascado**: si `/sync/push` valida el lote entero con un esquema estricto, una sola mutación inválida (por ejemplo, una PWA vieja en caché frente a un Worker nuevo) hace fallar toda la petición con 400; el cliente reenvía el mismo lote para siempre y el outbox no avanza.

## Opciones consideradas

- Restauración: (a) documentar que tras restaurar se borren los datos locales de todas las tablets (pierde lo que solo estaba en las tablets); (b) **época de sync**.
- Push: (a) validación estricta del lote; (b) **sobre laxo y validación por mutación**.

## Decisión

**Época**:

- `settings.sync_epoca` guarda un UUID. Viaja en cada respuesta de `/sync/pull` (campo `epoca`).
- El procedimiento de restauración (`docs/despliegue.md`) cambia la época después de restaurar.
- Si el cliente recibe una época distinta de la que tenía: reinicia su cursor y su estado sincronizado (snapshot), y **reenvía las mutaciones aplicadas que conserva** (el reenvío es idempotente por `mutation_id`).
- El cliente conserva las mutaciones `aplicada` al menos 7 días antes de purgarlas.

**Push**:

- Sobre: `{ user_id, mutaciones: unknown[] (1..25) }`. `user_id` debe ser igual al `sub` de la sesión (si no, 403 y no se procesa nada). No hay `device_id` en el sobre: se usa el `did` de la sesión.
- Cada mutación se valida por separado con `mutacionSchema.safeParse`:
  - inválida con `mutation_id` legible → `rechazada` con `VALIDACION`, guardada en `sync_mutations`;
  - `mutation_id` ilegible → resultado identificado por `indice`, no se guarda;
  - error transitorio (D1, `ERROR_INTERNO`) → no se guarda y se dejan de procesar las siguientes, que quedan sin resultado (= siguen pendientes).
- Cada resultado lleva `indice` y, si se pudo leer, `mutation_id`.
- La idempotencia está ligada al usuario: si un `mutation_id` ya existe para **otro** usuario, se responde `ID_DUPLICADO` sin devolver la respuesta guardada.
- `sync_mutations` guarda además `payload_json` de las mutaciones `rechazada` o `conflicto` (con `json_valid` y tamaño acotado), para que un dato de planta rechazado no dependa solo de la tablet. El cliente nunca borra las mutaciones rechazadas.
- Compatibilidad: los cambios de payload deben ser aditivos o usar un tipo nuevo (`consumo.crear.v2`); el servidor acepta los formatos de cualquier PWA en circulación.

## Consecuencias

- Cambios en `packages/shared` (Fase 1, tarea 1.0): sobre laxo, `indice`, tipos de cambio `hidratar` y `reiniciar`, `epoca` en el pull.
- Cambio de esquema respecto a la spec: columna `sync_mutations.payload_json` y `settings.sync_epoca` (registrado en `docs/desviaciones.md`).
- La restauración requiere un paso más en el runbook.

## Cómo revertir

Quitar `epoca` del pull y `payload_json` de `sync_mutations` (migración nueva) y volver a validar el lote completo con `syncPushRequestSchema` estricto.

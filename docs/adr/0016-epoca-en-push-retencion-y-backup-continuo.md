# ADR 0016 — Época en el push, retención de 30 días, idempotencia por clave natural y backup con continuaciones

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 3
- Enmienda: ADR 0009 (época y retención) y ADR 0014 (backup)

## Contexto

La revisión del protocolo de la Fase 3 (`docs/auditoria/revision-esquema-fase-3.md`) encontró:

- **A1**: tras una restauración, el cliente hace push antes de detectar la nueva época; una novedad o edición que depende de un consumo perdido queda `rechazada` **y guardada**, y el reenvío posterior devuelve esa respuesta guardada aunque el consumo se reaplique.
- **M1**: el cliente conservaba las mutaciones `aplicada` 7 días, pero Time Travel restaura hasta 30 días atrás.
- **M2**: un backup de R2 no es una foto de un instante; tras restaurarlo, un consumo puede existir sin su fila de `sync_mutations`, y el reenvío daría `ID_DUPLICADO` → `rechazada`.
- **A3**: con un solo cron diario y 800 operaciones por invocación, el backup deja de completarse hacia las ~385k filas, en silencio.

## Opciones consideradas

- A1: (a) que el cliente haga siempre pull antes del push (más latencia en cada sync y no cubre la carrera de una restauración entre ambos); (b) **época en el sobre del push** verificada por el servidor antes de procesar.
- M1: documentar el límite de 7 días, o **subir la retención a 30 días**.
- M2: cambiar el orden de exportación (empeora: una respuesta `aplicada` sin su fila de negocio sí perdería datos), o **idempotencia por clave natural** en el clasificador.
- A3: subir el presupuesto (límites de plataforma), o **crons de continuación** y página más grande.

## Decisión

1. **Época en el push**: `syncPushRequestSchema.epoca` (opcional, aditivo). Si viene y no coincide con `settings.sync_epoca`, el servidor responde 409 `EPOCA_CAMBIADA` **sin procesar ni guardar nada**. El cliente devuelve el lote a pendiente (sin backoff ni rechazo), hace pull (detecta la época, reencola en orden y hace el snapshot) y repite el push.
2. **Retención**: `RETENCION_MUTACIONES_APLICADAS_DIAS = 30` (también los bytes de las fotos subidas); cerrar sesión conserva las `aplicada` dentro de la retención. El runbook de restauración (Fase 6) prohíbe restaurar más atrás de la retención sin aceptar explícitamente la pérdida, y reconcilia evidencias contra R2.
3. **Idempotencia por clave natural** en `/sync/push`: un `ID_DUPLICADO` en `consumo.crear` cuya fila existente tiene el mismo autor, orden, material y `client_created_at` (y análogamente para `novedad.crear` y para aprobar/rechazar con la misma decisión y validador) se responde `aplicada` con el estado actual y se guarda como `aplicada`.
4. **Backup**: crons `0 8 * * *` (inicio) y `0 9-13 * * *` (continuaciones horarias del mismo día; con intervalo ≥ 1 h cada invocación tiene hasta 15 min de CPU), página de hasta 2000 filas (medida con la prueba de multipart), presupuestos separados para D1 y R2, `seq_final` en el manifest y log de error `backup_incompleto_del_dia` si la última continuación del día termina en pausa.

## Consecuencias

- Una restauración ya no convierte en rechazados los registros dependientes del cliente.
- La tablet guarda más historia (≈ 1.500 registros pequeños por usuario en 30 días, más las fotos): se vigila la cuota en tablets modestas.
- El backup completa bases de varios millones de filas por día.

## Cómo revertir

Quitar `epoca` del sobre (el servidor la ignora si falta), volver la constante a 7, quitar la rama de clave natural del clasificador y el segundo cron de `wrangler.jsonc`.

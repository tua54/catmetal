# ADR 0019 — `alerta_reloj` con la hora del dispositivo al enviar

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem M2)
- Enmienda: ADR 0010 (orden en la auditoría), solo en el cálculo de `alerta_reloj`

## Contexto

`calcularAlertaReloj` (`apps/worker/src/auditoria/auditar.ts`) compara `client_at`, que se alimenta con `client_created_at` (la hora en que se registró en la tablet), con `server_at`. Todo lo que se registra offline y se envía más de 10 min después queda con `alerta_reloj = 1`: esa regla mide el retraso de sincronización, no el reloj. La spec v2.1 §6 cambia la regla. La alerta compara la hora del dispositivo **en el momento de enviar** (`enviado_at` en `/sync/push` y `X-Hora-Dispositivo` en el REST que escribe) con la hora del servidor al recibir. Si falta, la alerta es 0.

## Opciones consideradas

1. **Calcular `alerta_reloj` en el cliente.** Se descarta: un cliente desfasado no sabe que lo está.
2. **Guardar `enviado_at` en una columna nueva de `audit_log`.** Da trazabilidad extra, pero cambia el esquema de una tabla inmutable y no lo pide la spec.
3. **Calcular la alerta una vez por petición, con la hora de envío, y aplicarla a todas sus filas de auditoría.** `client_at` sigue guardando `client_created_at`.

## Decisión

Se adopta la opción 3.

1. **Contrato** (`packages/shared/src/esquemas.ts`):
   - El cuerpo de `/sync/push` admite `enviado_at` opcional: ISO-8601 UTC, el mismo formato que `client_created_at`.
   - Las peticiones REST con método distinto de GET/HEAD/OPTIONS admiten el header `X-Hora-Dispositivo`, con el mismo formato.
   - **Un formato inválido no rechaza la petición**: el valor se ignora y se trata como ausente. Se valida con Zod mediante una función común `horaDeEnvio(valor): string | null`.
2. **Cálculo.**
   - Al recibir la petición, el Worker fija `recibido_at` (`ahoraIso()`) y calcula una sola vez `alerta = |enviado - recibido| > 10 min`.
   - Cuando falta la hora de envío o no es válida, `alerta = false`.
   - El resultado viaja en el contexto del comando de dominio (`dominio/contexto.ts`) y en el de cada mutación del push.
   - `valores()` de `auditar.ts` usa ese booleano. Si no lo hay, por ejemplo en el cron o el mantenimiento, se registra 0.
   - `client_at` sigue guardando `client_created_at`, solo para la trazabilidad.
3. **Alcance.** Todas las filas de `audit_log` que escribe esa petición llevan la misma alerta, incluidas las 25 mutaciones de un lote del push.
4. **Cliente.**
   - El motor de sync pone `enviado_at = new Date().toISOString()` justo antes de cada `fetch` del push, también en los reintentos.
   - El cliente REST agrega `X-Hora-Dispositivo` en las escrituras.
5. **Compatibilidad.** Un cliente viejo no manda la hora: `alerta_reloj = 0`. Un servidor viejo ignora el campo, porque el esquema del push no es estricto con las claves desconocidas. Si lo fuera, se ajusta y se indica en el commit.

## Consecuencias

- La señal vuelve a detectar relojes desajustados y deja de marcar lo registrado offline.
- La alerta mide la petición, no cada registro. Un reloj que se corrigió entre el registro y el envío no queda marcado: es lo que pide la spec.
- Las filas históricas de la v1 con `alerta_reloj = 1` siguen así, porque `audit_log` es inmutable. Se documenta en el informe.

## Cómo revertir

Volver a pasar `client_created_at` a `calcularAlertaReloj` y dejar de leer `enviado_at` y `X-Hora-Dispositivo`. Los clientes nuevos siguen funcionando, porque los dos campos son opcionales.

# ADR 0026 — Versión mínima del cliente (`CLIENTE_DESACTUALIZADO`)

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem B5)

## Contexto

La PWA se actualiza con su Service Worker (`apps/web/src/pwa/registro.ts` y `AvisoActualizacion.tsx`), pero el servidor no sabe qué versión del cliente le habla. Ante un cambio de contrato incompatible, una tablet que no se actualizó seguiría enviando con el contrato viejo. La auditoría (B5) pide que el cliente envíe su versión, que el servidor responda `CLIENTE_DESACTUALIZADO` si es menor que la mínima y que la app fuerce la actualización **sin perder el outbox**.

## Opciones consideradas

1. **Versión semántica del paquete web** (`MAJOR.MINOR.PATCH`). Hoy los paquetes están en `0.0.0`, y comparar textos semver agrega reglas sin aportar nada: lo que importa es la compatibilidad del contrato.
2. **Un entero de versión de contrato del cliente.** Se sube solo cuando un cambio del contrato exige que los clientes viejos se actualicen.
3. **Bloquear por la fecha de compilación.** Obligaría a actualizar en cada despliegue, aunque no haga falta.

## Decisión

Se adopta la opción 2.

1. **Constante compartida** `VERSION_CLIENTE` (entero) en `packages/shared`. La v1.1 usa **2**. Los clientes v1.0, que no mandan el header, cuentan como versión **1**.
2. **Header** `X-Version-Cliente: <entero>` en **toda** petición del cliente a `/api/v1`, REST y `/sync/*`. Un valor ausente cuenta como 1. Un valor inválido (no entero o fuera de rango) también se trata como 1 y no rechaza la petición por formato.
3. **Mínima del servidor**: la variable `VERSION_MINIMA_CLIENTE` de `wrangler.jsonc` (`vars`, por entorno). No es un secreto. Vale `"1"` en todos los entornos al desplegar la v1.1, así que no bloquea a nadie. El equipo la sube cuando un cambio lo exija. Si está vacía o no es válida, también vale 1.
4. **Middleware** de `/api/v1/*`. Si la versión es menor que la mínima, responde **426** con `{ code: 'CLIENTE_DESACTUALIZADO', message, details: { version_minima } }` **antes** de procesar nada: no escribe, no audita y no toca `sync_mutations`. Queda fuera `GET /api/v1/health`, si existe.
5. **Cliente.** Ante 426 `CLIENTE_DESACTUALIZADO`, en cualquier petición:
   - el motor de sync se detiene sin marcar ninguna mutación: siguen `pendiente`, porque la respuesta es de la petición entera, no por mutación;
   - se muestra un aviso bloqueante: "Hay una versión nueva de la app. Actualizando…";
   - se busca el Service Worker nuevo (`registration.update()`), se activa (`skipWaiting`) y se recarga.
   - El outbox, las fotos y las particiones viven en IndexedDB, y las migraciones de Dexie solo agregan, así que la actualización no pierde nada.
   - Si no hay SW nuevo disponible (sin red, por ejemplo), el aviso queda visible y se reintenta en el siguiente disparador de sync.
6. Los clientes v1.0 no entienden el código, pero con la mínima en 1 nunca lo reciben.

## Consecuencias

- El equipo puede exigir una actualización cambiando una variable, sin desplegar código nuevo del Worker.
- Antes de subir la mínima a 2 o más, hay que verificar que el motor viejo trata un 426 de la petición entera como transitorio, sin rechazar mutaciones. El de la v1.1 sí. Queda en `docs/despliegue.md`.
- Hay un header más por petición, sin datos personales.

## Cómo revertir

Quitar el middleware o dejar `VERSION_MINIMA_CLIENTE` en 1. El header del cliente es inocuo.

## Enmienda 1 — El logout no exige la versión mínima (correcciones v1.2, ítem A3)

- Fecha: 2026-10-30.

### Contexto

El middleware se aplica a todo `/api/v1/*`. Con la mínima subida, un cliente desactualizado recibe 426 también en `POST /auth/logout`: la tablet no puede revocar su familia de refresh antes de actualizarse, y la sesión queda viva en el servidor hasta que vence.

### Decisión

1. **`POST /api/v1/auth/logout` queda fuera** de la exigencia de versión mínima, igual que `GET /api/v1/health`. Solo reduce privilegios (revoca la familia y borra la cookie), no escribe datos de negocio ni toca `sync_mutations`. El CSRF por `Origin`, el límite de cuerpo y la autenticación del logout siguen igual.
   - La exención compara el método **y** la ruta exactos. Cualquier otro método sobre esa ruta, o cualquier otra ruta, sigue exigiendo la versión.
2. **`POST /api/v1/auth/refresh` sigue exigiendo la versión mínima.** Criterio:
   - El refresh **emite credenciales nuevas**. Un cliente con un contrato incompatible no debe obtener un access token con el que seguir hablando con la API.
   - No hace falta para actualizarse: la cookie de refresh sobrevive a la recarga, y la versión nueva hace su refresh con su propio header.
   - El 426 del refresh durante un push no debe contar como intento ni aplicar espera: eso lo resuelve el cliente (A4).
3. `POST /auth/login` y el resto siguen exigiendo la versión.

### Consecuencias

- Un cliente viejo siempre puede cerrar sesión y revocar su familia.
- El logout no puede usarse para escribir nada con un contrato viejo: su cuerpo no se procesa más allá de lo que ya hacía.

### Cómo revertir

Quitar la exención del logout en `apps/worker/src/middleware/version-cliente.ts`.

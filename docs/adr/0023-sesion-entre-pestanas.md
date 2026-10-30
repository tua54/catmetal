# ADR 0023 — Propagación de la sesión entre pestañas

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem M7)
- Enmienda: ADR 0012 (cliente de auth) y ADR 0017 (bloqueo por inactividad)

## Contexto

La sesión del cliente (`apps/web/src/auth/sesion.ts`) vive en memoria en cada pestaña: el access token nunca va a `localStorage` ni a IndexedDB (ADR 0012). Si un usuario cierra sesión, se bloquea por inactividad o cambia de usuario en una pestaña, las otras pestañas o ventanas del mismo origen siguen con la sesión anterior. En una tablet compartida, una pestaña olvidada podría seguir mostrando datos de A o enviar con su identidad mientras B trabaja en otra.

## Opciones consideradas

1. **Guardar la sesión en `localStorage` y escuchar `storage`.** Se descarta: expone el access token a cualquier script del origen y contradice la ADR 0012.
2. **`BroadcastChannel` con mensajes sin secretos, más el evento `storage` como alternativa.** Las demás pestañas solo reciben la orden de descartar.
3. **Sondear periódicamente el refresh.** No cumple los 2 s y gasta red.

## Decisión

Se adopta la opción 2.

1. **Canal.**
   - `BroadcastChannel('catmetal-sesion')`.
   - Mensajes: `{ v: 1, tipo: 'logout' | 'bloqueo' | 'cambio-usuario', user_id: string | null, origen: <id aleatorio de la pestaña>, at: <ms> }`. Nunca llevan tokens, contraseñas ni datos del perfil.
   - Una pestaña ignora sus propios mensajes, porque compara `origen`.
2. **Alternativa.** Si no existe `BroadcastChannel` (WebKit viejo), se escribe la clave `catmetal-sesion-evento` en `localStorage` con el mismo JSON y las demás pestañas escuchan el evento `storage`. La clave no contiene secretos y se sobrescribe en cada evento.
3. **Qué emite cada acción.**
   - `cerrarSesion()` emite `logout`.
   - `bloquear()` por inactividad emite `bloqueo`.
   - Un login correcto de otro usuario emite `cambio-usuario` con el `user_id` nuevo.
4. **Qué hace la pestaña que recibe el mensaje**, en el mismo tick:
   - descarta el access token y el perfil en memoria;
   - detiene el motor de sync;
   - con `logout` o `cambio-usuario`, si su usuario no es el nuevo, navega al login;
   - con `bloqueo`, va a la pantalla de bloqueo del mismo usuario.
   - No borra datos locales: eso lo decide la pestaña que cerró sesión, según la regla de pendientes de la spec §5.
5. **Revalidación en el motor.** Antes de cada `fetch` del push, el motor compara el `user_id` del lote con el `sub` de la sesión actual en memoria. Si la sesión cambió o no existe, no envía y deja el lote pendiente. Esta defensa no depende del canal.

## Consecuencias

- Las pestañas convergen en menos de 2 s, en la práctica en el mismo tick del navegador.
- Una pestaña bloqueada pide la contraseña aunque la otra siga activa. Para tablets compartidas es el comportamiento conservador correcto.
- En navegadores sin `BroadcastChannel` ni `storage` entre pestañas, la revalidación del motor no detecta que **otra** pestaña cerró sesión, porque compara contra la memoria de su propia pestaña. Lo que impide enviar con la identidad anterior es el servidor: `autenticar` exige una familia vigente y el logout la revoca, el login de otro usuario en la misma instalación revoca las familias ajenas (F4-06) y `AUTOR_NO_COINCIDE` rechaza un lote de otro autor. Corregido tras la revisión de seguridad (S-10).

## Cómo revertir

Quitar la suscripción al canal y la emisión de mensajes. La revalidación del motor se puede conservar, porque es independiente.

## Enmienda 1 — Inactividad compartida entre pestañas (correcciones v1.2, ítem A2)

- Fecha: 2026-10-30.

### Contexto

Cada pestaña tenía su propio vigilante de inactividad (`apps/web/src/auth/inactividad.ts`) y `bloquear()` siempre avisaba a las demás. Si el supervisor trabajaba 10 min en la pestaña B, el temporizador de la pestaña A, olvidada en segundo plano, vencía y bloqueaba a B en medio de un registro.

### Opciones consideradas

1. **Que `bloquear()` no avise a las demás pestañas.** Una pestaña olvidada nunca dejaría de mostrar datos aunque nadie use la tablet en ninguna: contradice la decisión original.
2. **Que la última actividad sea del usuario, no de la pestaña.** Las pestañas se comunican su actividad y solo bloquean si ninguna tuvo actividad en los últimos 10 min.

### Decisión

Se adopta la opción 2.

1. **Aviso `actividad`.** El canal admite un tipo nuevo, `{ v: 1, tipo: 'actividad', user_id, origen, at }`, sin secretos. `at` es la hora (ms) de la última interacción de la pestaña que emite.
   - Límite de frecuencia: como mucho un aviso cada 5 s por pestaña, con envío **al final** del intervalo (el último `at` de una ráfaga siempre se emite). Así, cuando vence el plazo, todas las pestañas conocen la última interacción exacta.
2. **Marca compartida.** Con cada aviso se escribe también la clave `catmetal-sesion-actividad` en `localStorage`, con `{ user_id, at }` (sin secretos). Sirve a una pestaña que estuvo congelada en segundo plano, a una recién abierta y a los navegadores sin `BroadcastChannel`.
3. **Regla de bloqueo.** La última actividad de una pestaña es el máximo entre la propia, la de los avisos recibidos del mismo usuario y la de la marca compartida (los valores en el futuro se ignoran). Una pestaña solo bloquea, y solo avisa `bloqueo`, si ese máximo tiene 10 min o más. Antes de bloquear, siempre relee la marca compartida.
4. **Vuelta de segundo plano.** Al volver a `visible`, la pestaña relee la marca compartida antes de decidir.
5. **Motivo del bloqueo.** El aviso `bloqueo` lleva `motivo: 'inactividad' | 'revocacion'`.
   - Con `inactividad`, la pestaña que lo recibe no se bloquea si **ella misma** tuvo una interacción dentro del plazo. En ese caso responde con un aviso `actividad`. Esto cubre la ventana de, como mucho, 5 s en que el emisor no conocía la última interacción.
   - Con `revocacion` (S-09), o sin `motivo` (una pestaña con el código anterior), la pestaña se bloquea siempre, como antes. Es el lado conservador.
6. Una pestaña con el código anterior ignora el tipo `actividad`, porque no lo conoce. La convivencia de versiones dura hasta que se recarga la pestaña vieja.

### Consecuencias

- Una pestaña en segundo plano ya no bloquea a quien trabaja en otra.
- Sin actividad en ninguna pestaña, todas se bloquean igual que antes, en menos de 2 s.
- Una pestaña que bloqueó por un aviso tardío puede quedar bloqueada mientras otra sigue activa. Es el comportamiento ya aceptado en las consecuencias originales.
- La E2E `e2e/sesion-multipestana.spec.ts` cambia: comprueba que, con actividad en B, A no bloquea, y que sin actividad en ninguna, ambas se bloquean en menos de 2 s.

### Cómo revertir

Quitar el tipo `actividad`, la marca compartida y el campo `motivo`, y volver a la regla por pestaña.

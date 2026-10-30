# ADR 0018 — Cupos de login por dispositivo conocido y por origen desconocido

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem M1)
- Reemplaza: ADR 0008, punto 6, en lo que se refiere al bloqueo duro por cuenta. La primera capa (binding de Rate Limiting) se conserva, pero se omite para un dispositivo conocido verificado.
- Segunda opinión: `software-architect`, 2026-10-30, "aprobar con cambios". Todos los cambios obligatorios están incorporados abajo.

## Contexto

En el diseño de la ADR 0008, punto 6, la cuenta se bloqueaba 15 min a los 5 fallos, vinieran de donde vinieran. La auditoría externa (M1) mostró el abuso: un tercero sin cuenta manda 5 contraseñas erróneas a cada admin y jefe cada 15 min. Así ninguno de esos roles puede entrar, y si todos los admin quedan bloqueados nadie puede desbloquear.

La spec v2.1 §5 exige:

- (a) el dispositivo conocido del usuario no puede ser bloqueado desde otros dispositivos o IP;
- (b) las adivinanzas desde orígenes desconocidos quedan acotadas: unos 5 por 15 min por (cuenta, origen) y un tope global por cuenta;
- (c) hay un desbloqueo de emergencia sin admin, con un script local que genera SQL;
- (d) todo bloqueo y desbloqueo se audita, y el mensaje es uniforme.

La primera capa también es abusable. Su clave es `ip:email`, y en planta todas las tablets salen por la misma IP pública (NAT). Alguien en la red de la planta puede agotarle el límite al admin legítimo.

## Opciones consideradas

1. **Bloqueo por cuenta con desbloqueo automático corto.** No cumple (a): el abuso solo se vuelve intermitente.
2. **Cupo por `device_id` del cuerpo.** El `device_id` no es secreto: aparece en la auditoría y en el JWT. Un atacante que lo conozca obtendría el cupo del dispositivo legítimo y podría agotarlo. No cumple (a).
3. **Device cookie firmada (OWASP, *Slow Down Online Guessing Attacks with Device Cookies*), con cupos en D1 por (cuenta, origen).** Tras un login correcto, el servidor entrega un secreto que solo tiene ese navegador. Los fallos de otros orígenes nunca agotan su cupo.
4. **Un secreto por navegador con su hash en `devices`.** Permite revocar desde el admin y elimina el tope de entradas. A cambio, suma una columna y una consulta. Queda como evolución posible.
5. **CAPTCHA o segundo factor.** No hay infraestructura y complica la tablet de planta. Queda fuera de la v1.

## Decisión

Se adopta la opción 3.

1. **Cookie de dispositivo `mp_dispositivo`.**
   - Atributos: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=34560000` (400 días).
   - Valor: hasta **16** entradas separadas por `~`, una por usuario de la tablet, la más reciente primero.
   - Cada entrada es `v1.<user_id>.<emitida_dia>.<nonce>.<firma>`:
     - `emitida_dia`: días desde 1970-01-01 (UTC);
     - `nonce`: 16 bytes aleatorios en base64url;
     - `firma`: HMAC-SHA-256 sobre el resto de la entrada, truncado a 128 bits y en base64url, con una clave derivada de `REFRESH_SECRET` y la etiqueta `mp-dispositivo-v1`.
   - La firma se compara en tiempo constante.
   - Se rechaza toda entrada de más de 400 días.
   - **Lectura robusta**:
     - se leen **todas** las apariciones de `mp_dispositivo` del header `Cookie`, por si un subdominio hermano planta otra con `Domain=catmetal.com`;
     - hay tope de 4 KiB por valor y de 16 entradas;
     - se toma la primera entrada válida cuyo `user_id` sea el de la cuenta del email.
   - Una entrada inválida, vencida o de otro usuario se ignora: el intento cuenta como de un origen desconocido.
   - **Emisión**:
     - solo tras un login con contraseña correcta;
     - al renovar, se conservan las entradas **válidas** de otros usuarios y se descartan las inválidas, para no reemitir nada plantado;
     - la entrada nueva del usuario va primero.
   - Logout, refresh y `borrarCookieRefresh` **nunca** borran `mp_dispositivo`.
   - La cookie no da acceso: solo elige el cupo.
2. **Tabla técnica `login_cupos`** (migración nueva):
   - Columnas: `user_id` (FK a `users`), `origen` (`TEXT`), `fallos` (`INTEGER`), `ventana_inicio`, `bloqueado_hasta` (anulable), `reserva_id` (`TEXT`), `created_at` y `updated_at`.
   - PK: (`user_id`, `origen`).
   - `origen` toma uno de tres valores:
     - `d:<nonce>`: dispositivo conocido;
     - `ip:<hmac>`: origen desconocido. Es el HMAC-SHA-256, truncado a 128 bits, de la IP normalizada: IPv4, IPv4 mapeada `::ffff:a.b.c.d` → IPv4 e IPv6 → prefijo /64. Se calcula con una clave derivada de `REFRESH_SECRET` y la etiqueta `mp-ip-v1`. Sin `cf-connecting-ip` (desarrollo local), la IP es `local`;
     - `g`: tope global de orígenes desconocidos de la cuenta.
3. **Límites y semántica** (constantes en `packages/shared`):

   | Cupo | Fallos en la ventana | Ventana | Bloqueo |
   |---|---|---|---|
   | (cuenta, dispositivo conocido) | 5 | 15 min desde el primer fallo | 15 min desde el 5.º fallo, solo ese dispositivo |
   | (cuenta, origen desconocido) | 5 | 15 min | 15 min desde el 5.º fallo |
   | (cuenta, todos los desconocidos) | 20 | 15 min | 15 min desde el 20.º fallo |

   - La ventana es fija. Si `ventana_inicio + 15 min` ya pasó y no hay bloqueo vigente, el contador vuelve a 1 con una ventana nueva.
4. **Reserva antes de comparar el hash, atómica.** Se genera un `reserva_id` aleatorio por petición y se usa un solo `db.batch()`.
   - **Dispositivo conocido** (dos sentencias):
     1. Upsert condicional de la fila `d:` con `RETURNING`. Solo aplica si no hay bloqueo vigente.
     2. Auditoría condicionada a que la fila tenga este `reserva_id` **y** haya quedado bloqueada.
   - **Origen desconocido** (cuatro sentencias):
     1. Upsert de la fila `ip:`, condicionado a que la IP **y** `g` tengan cupo. Usa `INSERT … SELECT … WHERE`, con `WHERE` en el SELECT por la regla de parseo de SQLite con `ON CONFLICT`.
     2. Incremento de `g`, solo si la fila `ip:` quedó con este `reserva_id`.
     3. y 4. Auditorías condicionadas al bloqueo que haya fijado esta reserva.
   - Se reservan los dos cupos o ninguno: una IP bloqueada no consume `g`. Sin cupo global no se crean filas de IP, así que las filas y las auditorías por ventana quedan acotadas.
   - Sin reserva no se compara el hash: se ejecuta la derivación ficticia.
   - Con la contraseña correcta se reinicia **solo** el cupo del origen usado (`d:` o `ip:`). **El global `g` no se reinicia**: vence con su ventana. Si no, cada login legítimo le regalaría al atacante otros 20 intentos.
5. **Primera capa (binding de Rate Limiting).**
   - El usuario se busca **antes** del limitador.
   - Con un **dispositivo conocido verificado** (entrada válida cuyo `user_id` es el de la cuenta), se omite el limitador: su cupo en D1 (5 por 15 min) es más estricto.
   - En cualquier otro caso, incluida una cuenta inexistente, la clave sigue siendo `ip:email`, como en la spec. Así, el 429 no revela si la cuenta existe.
   - La desviación se registra en `docs/desviaciones.md`.
6. **`users.intentos_fallidos` y `users.bloqueado_hasta`.**
   - Se conservan (spec §4), pero dejan de bloquear el login.
   - El login correcto y el desbloqueo de emergencia las dejan en 0 y NULL. Así no queda ningún bloqueo heredado de la v1.
   - El desbloqueo del admin con `PATCH /users/:id` reinicia además todos los cupos del usuario, con auditoría.
7. **Auditoría con la entidad nueva `login_cupos`**, con su lista blanca en `auditar.ts`.
   - Datos: `{ user_id, tipo: 'dispositivo' | 'origen' | 'global', fallos, bloqueado_hasta }`, sin IP ni nonce. `entidad_id = user_id`.
   - **Sin descriptor de sync**: las filas no viajan a las tablets por `/sync/pull`.
   - Se excluye de la consulta de auditoría para quien no es admin (`dominio/auditoria-consulta.ts`, como las identidades en la ADR 0013).
   - Acciones:
     - `login_cupos.bloqueado` cuando una reserva deja un cupo bloqueado;
     - `login_cupos.desbloqueado` cuando un login correcto o el admin reinician un cupo que estaba bloqueado;
     - `login_cupos.desbloqueo_emergencia` en el script.
   - Volumen máximo por cuenta y ventana de 15 min: unas 6 filas inmutables (4 de IP, 1 global y 1 por dispositivo atacado con su cookie).
8. **Respuesta uniforme.** Toda negativa del login es 401 `CREDENCIALES_INVALIDAS`, con un piso de 400 ms desde el inicio, como ahora. `Set-Cookie` solo aparece tras un login correcto.
9. **Desbloqueo de emergencia.**
   - `node scripts/desbloqueo-emergencia-sql.mjs --email <correo> [--salida <archivo>]` escribe un SQL local que resuelve al usuario con `(SELECT id FROM users WHERE email = ?)`. Con un correo erróneo no hace nada, y el email nunca llega a `audit_log` (ADR 0013).
   - Sentencias, idempotentes y seguras aunque se apliquen a medias (no se supone que `d1 execute --file` sea atómico):
     1. Auditoría `INSERT … SELECT … FROM users WHERE email = ?`, con columnas de la lista blanca y fechas `toISOString()`, sin `seq` explícito.
     2. `UPDATE login_cupos` para reiniciar el usuario, sin `DELETE`.
     3. `UPDATE users` con `intentos_fallidos = 0` y `bloqueado_hasta = NULL`.
   - El equipo lo aplica con `wrangler d1 execute … --file` (`docs/despliegue.md`).
10. **Mantenimiento.** El cron de mantenimiento borra las filas de `login_cupos` que llevan más de 24 h sin cambios y sin bloqueo vigente. Es una tabla técnica, como `refresh_tokens`: no es de negocio y no tiene trigger de inmutabilidad.

## Consecuencias

- Un atacante sin la cookie del navegador legítimo no puede impedir que ese usuario entre desde su tablet.
- **Riesgos residuales**:
  - Otro usuario de la **misma** tablet compartida puede bloquear el cupo de A en esa tablet cada 15 min. Queda fuera de (a), y A conserva las otras vías de desbloqueo.
  - El usuario 17.º de una tablet desplaza al más antiguo.
  - Rotar `REFRESH_SECRET` convierte todos los dispositivos en desconocidos.
  - Las entradas no se revocan del lado del servidor. Vencen a los 400 días y una robada solo da su propio cupo.
  - Un subdominio hermano de `catmetal.com` podría desalojar la cookie llenando el cupo de cookies del dominio. Requiere controlar ese subdominio.
- Un usuario en un dispositivo **nuevo** puede quedar frenado por el tope global durante un ataque. Le quedan el desbloqueo del admin y el de emergencia.
- El tope global acota las adivinanzas a 20 por 15 min por cuenta (unas 1.920 al día), sin importar cuántas IP se usen. Con PBKDF2 de 100.000 iteraciones y la política de contraseñas vigente, es un riesgo aceptable. Se registra en `docs/preguntas-abiertas.md`, por si el cliente quiere CAPTCHA o un segundo factor.
- Hay una cookie más en `/api/v1/auth`, una tabla técnica más y una entidad de auditoría nueva.

## Notas de implementación (M1)

- **Login correcto desde un origen desconocido.** La reserva había contado el intento en `g` como fallo anticipado, así que el login correcto devuelve **esa** unidad (`fallos - 1`, solo si `g` no está bloqueado) y no reinicia `g`. Sin esto, un usuario legítimo que entra 20 veces en 15 min desde orígenes nuevos se bloquearía solo. Al atacante no le da ningún intento extra.
- Cada login correcto rota el nonce de la entrada del dispositivo. La fila `d:` anterior la purga el mantenimiento.
- Los fallos ya no escriben `users.intentos_fallidos` ni `bloqueado_hasta`. El login correcto los deja en 0 y NULL, y audita `usuario.desbloqueado` si quedaba un bloqueo heredado de la v1.
- El script de emergencia tiene 4 sentencias idempotentes, cada auditoría con id fijo y `NOT EXISTS`:
  1. `login_cupos.desbloqueo_emergencia` con `tipo: 'todos'`;
  2. `usuario.desbloqueado`, solo si había columnas heredadas que reiniciar;
  3. el reinicio de `login_cupos`;
  4. el reinicio de `users`.
- El desbloqueo del admin audita un `login_cupos.desbloqueado` por cada tipo con bloqueo vigente.
- Una IP que no se puede interpretar se usa tal cual, en minúsculas.

## Cómo revertir

Volver al bloqueo por cuenta de la ADR 0008, punto 6: restaurar `reservarIntento` sobre `users` y dejar de emitir y leer `mp_dispositivo`. La tabla `login_cupos` puede quedar sin uso. Revertir **no** es recomendable porque reabre el abuso M1.

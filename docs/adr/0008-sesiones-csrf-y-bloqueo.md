# ADR 0008 — Sesiones, CSRF por `Origin` y bloqueo de cuentas

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 1
- Reemplazado en parte por: ADR 0018 (punto 6: el bloqueo duro por cuenta se sustituye por cupos por dispositivo conocido y por origen desconocido).

## Contexto

La spec (§5) define access token en memoria (15 min), refresh en cookie `HttpOnly` (30 días) con rotación y detección de reutilización, verificación de `Origin` y fuerza bruta en dos capas. Faltan detalles de implementación que afectan a la seguridad.

## Decisión

1. **Access token**: JWT HS256 (`jose`, `algorithms: ['HS256']`, con `iss` y `aud` verificados) con `sub`, `did` (dispositivo) y `fam` (familia de refresh). El rol **no** se toma del token: en cada petición autenticada, una sola consulta indexada comprueba que el usuario sigue activo, toma su **rol actual** de D1 y verifica que la familia tenga al menos un token sin revocar. Así, el logout, la desactivación o la detección de robo cortan el acceso de inmediato. Cambiar el rol o restablecer la contraseña revoca todas las familias del usuario.
2. **Rotación atómica** en un único `db.batch()`, en este orden: (a) `INSERT INTO refresh_tokens (...) SELECT :nuevo, user_id, device_id, :hash, familia_id, :expira, ... FROM refresh_tokens WHERE id = :viejo AND revocado_at IS NULL AND expira_at > :ahora`; (b) `UPDATE refresh_tokens SET revocado_at = :ahora, reemplazado_por = :nuevo WHERE id = :viejo AND revocado_at IS NULL AND EXISTS (SELECT 1 FROM refresh_tokens WHERE id = :nuevo)`; (c) auditoría con `INSERT ... SELECT ... WHERE EXISTS (nuevo)`. Gana quien obtiene `changes = 1` en (a). Si es 0, se relee el token: expirado o inexistente → 401 `TOKEN_INVALIDO`; revocado → punto 3.
3. **Reutilización**: si el token presentado está revocado **y** su sucesor se creó hace 30 s o menos y sigue sin revocar, se trata como reintento por respuesta perdida (frecuente con mala señal en planta): en un batch condicional se revoca el sucesor y se emite uno nuevo de la misma familia. Fuera de esa ventana se revoca toda la familia, se audita `sesion.reutilizacion` y responde 401 `SESION_REVOCADA`. El robo se sigue detectando en el siguiente refresco del dueño legítimo.
4. **Cookie**: `mp_refresh`, `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000`. En `http://localhost`, Chromium acepta `Secure`; WebKit puede no guardarla (se documenta en la Fase 4). `token_hash` es `UNIQUE` y hay índice por `familia_id`.
5. **CSRF**: además de `SameSite=Strict`, toda petición con método distinto de GET/HEAD/OPTIONS exige `Origin` igual al origen de la petición. En desarrollo se aceptan también los orígenes de `ORIGENES_DEV` (proxy de Vite, ADR 0002); en staging y producción esa variable está vacía. Sin `Origin` → 403 `ORIGEN_INVALIDO`.
6. **Fuerza bruta**: primero `LOGIN_LIMITER.limit({ key: ip + ':' + email })` (429 `DEMASIADOS_INTENTOS`); después el contador en D1, actualizado de forma **atómica en SQL** (`CASE` que reinicia el contador si el bloqueo anterior ya expiró y fija `bloqueado_hasta` al llegar a 5), con la auditoría `usuario.bloqueado` condicionada en el mismo batch. **Durante el bloqueo no se compara el hash** (solo se ejecuta la derivación ficticia para igualar el tiempo) y la respuesta es idéntica sea la contraseña correcta o no: 401 `CREDENCIALES_INVALIDAS`. `CUENTA_BLOQUEADA` no se usa en `/auth/login`. No se audita el correo de intentos sobre cuentas inexistentes (Ley 1581). El admin puede desbloquear con `PATCH /users/:id` (auditado).
7. **Dispositivos y autoría**: el cliente propone un `device_id` (UUID v7) por usuario y navegador, y un `instalacion_id` por navegador, compartido entre usuarios (columna nueva `devices.instalacion_id`, para saber que A y B usaron la misma tablet). El dispositivo se crea solo tras un login correcto; si el id pertenece a otro usuario, el servidor asigna uno nuevo y lo devuelve. **El servidor usa siempre el `did` de la sesión**, nunca un `device_id` del cuerpo. Al iniciar sesión se revocan las familias activas del mismo usuario en el mismo dispositivo.
8. **Tablet compartida**: hay una sola cookie `mp_refresh` por origen. Para que una mutación de A nunca se registre con la sesión de B, el sobre de `/sync/push` lleva `user_id` (autor del outbox) y el servidor responde 403 si no coincide con `sub`; además el cliente compara el `sub` del token con la partición del outbox antes de enviar.
9. **No quedarse sin administrador**: el servidor impide desactivar o quitar el rol al último admin activo.

## Consecuencias

- Una consulta extra por petición autenticada (por clave primaria e índice); aceptable para el volumen de una planta.
- El bloqueo de 15 min puede usarse para bloquear a un usuario a propósito (5 intentos desde una IP bastan). No se pierden datos (login offline y outbox siguen), pero la sync se detiene. No se agrega un límite solo por IP porque todas las tablets salen por la misma IP pública de la planta. Mejora futura: contador por dispositivo conocido (patrón *device cookie* de OWASP).
- La ventana de gracia de 30 s abre una pequeña ventana para un atacante que robe un token ya rotado; se acepta frente al coste operativo de cerrar la sesión de un supervisor por mala señal.
- El verificador offline del dispositivo sigue aceptando la contraseña anterior hasta que el dispositivo reconecte.

## Cómo revertir

Cada punto es independiente: por ejemplo, eliminar la verificación de familia en el middleware devuelve el comportamiento estándar de JWT sin estado.

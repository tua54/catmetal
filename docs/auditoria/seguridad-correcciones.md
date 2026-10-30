# Revisión de seguridad: correcciones v1.1 (M1, B1, B3, B4, B5 y relacionados)

- Revisor: `security-reviewer`, en modo de solo lectura. Lo encargó el orquestador según `CLAUDE.md` (bucle de trabajo, punto 4).
- Fecha: 2026-10-30. Rama: `fix/auditoria-v1`.
- Alcance: los archivos del árbol de trabajo. Todo el código del Worker revisado corresponde a HEAD; lo único sin confirmar era el trabajo de M7 en `apps/web/src/auth`, `apps/web/src/sync` y `e2e`. No se ejecutaron pruebas ni exploits.

## Resumen

**Veredicto: aprobado con observaciones.** No hay bypass de autenticación ni de autorización, ni fuga de datos entre usuarios, ni inyección. Los controles previos siguen en pie: CSRF por Origin, `SameSite=Strict`, autorización en cada petición contra D1 y piso de 400 ms en el 401.

| Severidad | Cantidad |
|---|---|
| Crítico | 0 |
| Alto | 0 |
| Medio | 0 |
| Bajo | 4 |
| Info | 4 |

Ningún hallazgo bloquea el cierre de P1.

## Hallazgos

### S-01 · Bajo · M1 — Amplificación de filas inmutables en `audit_log` por bloqueos de origen

- **Archivo:** `apps/worker/src/auth/cupos.ts:195-216` y `:308-323`.
- **Descripción:** cada reserva de un origen desconocido puede auditar dos bloqueos (`origen` y `global`). Con 4 IP o 4 prefijos /64 por ventana, un atacante sin cuenta llega al tope `g` de 20 y genera 5 filas por cuenta cada 15 min, unas 480 al día por cuenta (96 en la v1). `audit_log` no se puede borrar, se exporta en cada backup y `/sync/pull` lo recorre (las filas de `login_cupos` se descartan en JS, pero cuentan para `MAX_FILAS_REVISADAS_PULL`). Las cuentas inexistentes no generan filas.
- **Escenario:** con unas 40 cuentas, unas 19.000 filas al día sin límite de tiempo.
- **Recomendación:** auditar como máximo un bloqueo `origen` por (usuario, ventana de `g`), además del `global`. Avisar si `audit_log` crece más de N filas al día. Registrar el volumen en la ADR 0018.

### S-02 · Bajo · M1 — Las entradas de `mp_dispositivo` no se invalidan al cambiar la contraseña y su cupo se suma al tope global

- **Archivos:** `apps/worker/src/auth/dispositivo.ts:139-161`, `apps/worker/src/rutas/auth.ts:182-186` y `apps/worker/src/auth/cupos.ts:222-251`.
- **Descripción:** la firma cubre `user_id`, día y nonce. Una entrada sigue válida 400 días aunque se restablezca la contraseña. Con ella se evita el limitador y se obtiene un cupo `d:` de 5 cada 15 min que **no** toca `g`: unas 480 adivinanzas más al día por entrada. En una tablet compartida, cualquier usuario del navegador hereda ese cupo.
- **Escenario:** el admin restablece la contraseña de A por sospecha de un compañero, que sigue probando desde la tablet compartida sin pasar por `g`.
- **Recomendación:** contar también los fallos `d:` en `g`, sin que `g` condicione la reserva `d:`. Así se mantiene la propiedad (a) y el total queda acotado. Otra opción es firmar un dato que cambie con la contraseña.

### S-03 · Bajo · M5/M6 (ADR 0022) — Visibilidad retenida tras bajar el rol

- **Archivos:** ADR 0022 (líneas 98 y 259), `apps/worker/src/rutas/usuarios.ts:168-171` y `:250-252`, y `apps/worker/src/middleware/autenticar.ts:20-28` y `:48`.
- **Evaluación:**
  - El servidor está bien: el cambio de rol revoca todas las familias en el mismo batch y `autenticar` lo exige en cada petición.
  - La tablet conserva en IndexedDB, hasta que termina el snapshot, lo que ese usuario veía como jefe; por ejemplo, consumos ajenos.
  - No es una fuga a terceros ni una escalada.
- **Recomendación:** si el perfil nuevo ya no tiene `auditoria.ver_todo` ni `consumos.validar`, borrar de inmediato los consumos ajenos (y sus hijos) que no tengan outbox, o al menos ocultarlos mientras `motivo_snapshot = 'reiniciar'`.

### S-04 · Bajo · M4 (ADR 0021) — Una restauración puede deshacer acciones de seguridad posteriores a la exportación de `users`

- **Descripción:** `users` se restaura con su valor exportado. Una desactivación, una baja de rol o un restablecimiento de contraseña posteriores a la exportación no aparecen en `revisar_seguridad`. Las entradas de `mp_dispositivo` siguen válidas, porque dependen de `REFRESH_SECRET`.
- **Recomendación:** en el runbook, reaplicar esas acciones y, si la restauración se debe a un incidente de seguridad, rotar `JWT_SECRET` y `REFRESH_SECRET`.

### S-05 · Info · M1 — Separación de claves débil entre la derivación y el hash del refresh

- **Archivos:** `apps/worker/src/auth/dispositivo.ts:54-66` y `apps/worker/src/auth/tokens.ts:62-72`.
- **Descripción:** la clave derivada es HMAC(`REFRESH_SECRET`, etiqueta), el mismo primitivo y la misma clave de `hashRefreshToken`. No es explotable: los tokens son aleatorios y ese hash nunca se guarda.
- **Recomendación:** HKDF con `info` distinto, un prefijo de dominio en `hashRefreshToken` o un secreto propio.

### S-06 · Info · M1 / Ley 1581 — El HMAC de la IP viaja al backup de R2

- **Archivos:** `apps/worker/src/cron/tablas.ts:137-149` y `apps/worker/src/auth/cupos.ts:126-128`.
- **Descripción:** `login_cupos.origen` (`ip:<hmac>`) se exporta en cada backup. Con el secreto, el espacio IPv4 se recorre por fuerza bruta: es un dato personal seudonimizado que se conserva según la retención del backup, no solo 24 h.
- **Recomendación:** excluir `login_cupos` del backup, o al menos las filas `ip:`. Si no, registrarlo en el inventario de datos personales.

### S-07 · Info · M1 — El SQL de emergencia deja el correo en el directorio temporal

- **Archivo:** `scripts/desbloqueo-emergencia-sql.mjs:136-137`.
- **Recomendación:** que `docs/despliegue.md` indique borrar el archivo tras aplicarlo, o imprimirlo por stdout. No hay inyección.

### S-08 · Info · Anterior a la v1.1 — `mp_refresh` no tiene la misma protección

- **Archivo:** `apps/worker/src/auth/cookie.ts:19-22` y `:33-35`.
- **Descripción:** `getCookie` toma una sola aparición y `borrarCookieRefresh` solo borra la del host. Un subdominio hermano podría plantar `mp_refresh` con `Domain=` para forzar un cierre de sesión o fijar una sesión. Requiere controlar ese subdominio.

## Verificaciones realizadas (sin hallazgos)

- **M1, enumeración y tiempos.** El usuario se busca antes del limitador. Para una cuenta inexistente, inactiva, bloqueada o con contraseña errónea, la respuesta es la misma: 401 `CREDENCIALES_INVALIDAS` con piso de 400 ms, o el 429 `ip:email`, que también se aplica a cuentas inexistentes. Con el cupo bloqueado, se hace la derivación ficticia. `Set-Cookie` solo aparece tras un login correcto.
- **M1, reserva.** Es atómica. Para un origen desconocido, la IP y `g` se comprueban en la misma sentencia, y `g` solo se incrementa con este `reserva_id`. El login correcto reinicia solo el origen usado y descuenta su unidad de `g`. Un tercero sin la cookie no toca `d:`: se cumple la propiedad (a).
- **M1, cookie.** Atributos correctos. Se leen todas las apariciones (tope de 8 valores, 4 KiB y 16 entradas), la firma se compara en tiempo constante y se rechazan las edades negativas o de más de 400 días. Al renovar solo se reemiten las válidas, y logout y refresh no tocan la cookie.
- **M1, IP.** La normalización cubre IPv4 mapeada y el /64 de IPv6. Solo se guarda el HMAC, y el CHECK limita su largo.
- **M1, auditoría.** La lista blanca no incluye IP, nonce ni origen. No hay descriptor de sync. `SOLO_NEGOCIO` excluye `login_cupos` para quien no es admin; N3 está bien.
- **M1, desbloqueos.** El del admin queda condicionado y auditado por tipo. El de emergencia no usa `DELETE`, no deja el correo en `audit_log` y es idempotente. La purga solo borra filas sin bloqueo y con más de 24 h.
- **B1.** La familia empieza en `MIN(created_at)` y su vencimiento se comprueba antes de la gracia y de la reutilización. El sucesor vence en min(token, familia), y `Max-Age` es la vida restante.
- **B6.** El rehash ocurre después de verificar, con un UPDATE condicional y una auditoría sin hashes.
- **B3.** `COLISION_DE_ID` no lleva `servidor`. Un `mutation_id` ajeno no revela la respuesta guardada. El 409 del REST solo trae nombres de tabla y columna. Los permisos y la visibilidad se comprueban antes de `ID_DUPLICADO`.
- **B4.** Nunca se borra un objeto no confirmado. El contenido coincide con el sha256, el tamaño y los magic bytes. Se comprueba la propiedad de la novedad.
- **B5.** El orden es: cabeceras, secretos, Origin, versión, límite de cuerpo y rutas. El 426 no toca D1. Es un control de compatibilidad, no de seguridad.
- **M2.** `alerta_reloj` solo se guarda en la auditoría; ninguna decisión de autorización depende de ella.

## Pendiente

- **M7** (ADR 0023): revisado en el seguimiento de abajo.

## Fuera de alcance

- El código del cliente de M5/M6, más allá del riesgo señalado.
- La implementación del script de restauración de M4 (solo se revisó el diseño).
- `pnpm audit`, CSP y cabeceras, que no cambiaron.
- El binding de Rate Limiting en un entorno real.

## Seguimiento: M7 (commit `ea2b5df`)

Revisión de solo lectura del mismo revisor, sobre los archivos del árbol de trabajo. M7 está bien implementado: no hay secretos en los mensajes, no se puede escalar privilegios por el canal y ninguna mutación sale con la identidad anterior. Resultado: 0 críticos, 0 altos, 0 medios, 1 bajo, 3 informativos. **La parte "sin verificar" de S-03 queda resuelta: se confirma (S-09).**

### S-09 · Bajo · M7 / S-03 — Tras una revocación del servidor, la pestaña sigue mostrando los datos con el perfil y los permisos anteriores

- **Dónde:** `apps/web/src/auth/sesion.ts:400-405` (`#perderSesionDelServidor`), `apps/web/src/auth/cliente-api.ts:227-229` y `apps/web/src/components/layout/AvisosSesion.tsx:40-53`.
- **Qué pasa:** ante `SESION_REVOCADA`, la pestaña olvida el token y publica `modo: 'offline'` con `requiere_contrasena: true`. Conserva `usuario` y `permisos` anteriores, y la UI solo muestra un aviso: la partición sigue visible. Las revocaciones del servidor no se difunden por el canal.
- **Escenario:** a un jefe le bajan el rol o lo desactivan, y su pestaña abierta en la tablet compartida sigue mostrando pantallas de jefe y consumos ajenos.
- **No hay riesgo en el servidor:** sigue rechazando toda lectura y toda mutación.
- **Sin verificar:** si un usuario desactivado puede volver a entrar sin conexión con su verificador local (ADR 0017).
- **Recomendación:** ante una revocación de una petición autenticada, bloquear la app con desbloqueo **en línea** y emitir `bloqueo` por el canal. Si el perfil nuevo pierde permisos, purgar lo ajeno sin pendientes (S-03).

### S-10 · Info · M7 — La ADR 0023 atribuía al motor una defensa que da el servidor

- **Dónde:** `docs/adr/0023-sesion-entre-pestanas.md:43`.
- **Descripción:** sin `BroadcastChannel` ni `storage`, la revalidación del motor no detecta un logout de **otra** pestaña. Lo que lo impide es el servidor: familia vigente, F4-06 y `AUTOR_NO_COINCIDE`.
- **Recomendación:** corregir el texto.

### S-11 · Info · M7 — Un mensaje falsificado desde el mismo origen solo puede cerrar o bloquear sesiones

- **Dónde:** `apps/web/src/auth/sesion.ts:329-358`.
- **Descripción:** el manejador nunca adopta una identidad ni un dato del mensaje. Como mucho es una denegación de servicio local, y se acepta.

### S-12 · Info · B5 — El cliente todavía no enviaba `X-Version-Cliente`

- **Riesgo:** operativo. Si se sube `VERSION_MINIMA_CLIENTE` a 2 antes de que el cliente mande la cabecera, todas las tablets reciben 426.
- **Recomendación:** dejar la advertencia en `docs/despliegue.md` hasta cerrar B5.

### Verificaciones de M7 sin hallazgos

- **Mensajes:** `{v, tipo, user_id, origen, at}`, sin tokens, contraseñas ni perfil (lo afirma una prueba). La forma se valida, y cada pestaña ignora los suyos.
- **Otros orígenes:** no pueden enviar mensajes; `BroadcastChannel` y `localStorage` están acotados al origen.
- **Emisión:** `logout` antes de esperar la revocación, `bloqueo` y `cambio-usuario` (en línea y sin conexión). No hay reenvío, así que no hay bucles.
- **Recepción:** descarta el token, aborta la sync en vuelo y bloquea con `bloqueo`. No borra datos.
- **Motor:** `#verificarAntesDeEnviar` corre después de cada `await` y justo antes del `fetch`, sin `await` en medio. Comprueba que el lote sea del usuario de la sesión, y `devolverAPendiente` deja el lote pendiente si no salió nada (`motor.ts:336-396` y `:559-604`).
- **`X-Hora-Dispositivo`:** solo una hora ISO, solo en las escrituras, y sin uso para autorizar.

## Estado de los hallazgos (orquestador)

| Id | Estado |
|---|---|
| S-01 | ACEPTADO como riesgo residual: se mantiene "todo bloqueo se audita" (spec §5 d), con un volumen acotado por `g` (≤ 5 filas por cuenta y ventana). Lo fija una prueba en `correcciones-m1-seguridad.test.ts` (53487c8). La alerta de crecimiento queda como pendiente humano. Enmienda de la ADR 0018. |
| S-02 | RESUELTO (53487c8): los fallos con la cookie de dispositivo cuentan en `g` sin que `g` los condicione. |
| S-03 | RESUELTO (2c29a5d): purga de lo ajeno sin pendientes al perder visibilidad. ADR 0027. |
| S-04 | DOCUMENTADO (5ad5b39): `docs/despliegue.md` §9.2, paso 12 (reaplicar acciones de seguridad y rotar secretos). |
| S-05 | RESUELTO (53487c8): claves derivadas con HKDF. |
| S-06 | RESUELTO (53487c8): `login_cupos` fuera del backup. |
| S-07 | DOCUMENTADO (5ad5b39): `docs/despliegue.md` §5.1. |
| S-08 | PENDIENTE HUMANO (anterior a la v1.1): `docs/pendientes-humanos.md`. |
| S-09 | RESUELTO (d14566f): bloqueo con desbloqueo solo en línea tras una revocación. ADR 0027. |
| S-10 | RESUELTO (d4b6d21): texto de la ADR 0023 corregido. |
| S-11 | ACEPTADO (informativo). |
| S-12 | RESUELTO (68dc60d): el cliente envía `X-Version-Cliente`. La advertencia sigue en `docs/despliegue.md`. |

# Revisión de seguridad — correcciones v1.2 (A1, N1, N2, A3, A5, A6 y A8)

- **Revisor**: `security-reviewer`, en modo solo lectura. No modificó archivos ni ejecutó pruebas o exploits.
- **Fecha**: 2026-10-30. Rama `fix/auditoria-v1`, árbol limpio en `8b71fea`.
- **Alcance**: el código del árbol de trabajo para los ítems A1 (con N1 y N2), A3, A5, A6 (servidor y cliente) y A8. El revisor no tuvo shell, así que no usó `git diff` por commit.
- Informe guardado por el orquestador. El estado de cada hallazgo está al final.

## Veredicto

**Aprobado con observaciones. No hay hallazgos críticos, altos ni medios.**

- No se encontró bypass de autenticación ni de autorización, inyección SQL, fuga de `escritura_id` ni filas de auditoría atribuibles a un perdedor.
- Hay 1 hallazgo bajo (A8) y 3 informativos.

## Hallazgos

| Id | Sev. | Evidencia | Descripción | Recomendación |
|---|---|---|---|---|
| S-v12-01 | Bajo | `apps/worker/src/rutas/auth.ts:316-327`; `auth/dispositivo.ts:279-288`; `auth/cupos.ts:136-138` y `:257-266`; ADR 0018 | **A8.** El refresh crea entradas de dispositivo conocido sin contraseña. Quien tenga un refresh token robado (o el anterior, dentro de la gracia de 30 s) puede rotarlo una y otra vez con cookies vacías y obtener cada vez un nonce nuevo, es decir, un cupo `d:` nuevo: 5 intentos cada 15 min que no dependen de `g`. Las entradas duran 400 días y sobreviven a la revocación de la familia y al cambio de contraseña (residual S-02). La frase de la ADR ("demuestra lo mismo que un login previo **en este navegador**") no es exacta: el refresh token no está ligado al navegador. El requisito previo es robar una cookie HttpOnly y SameSite=Strict, que ya es un compromiso de la cuenta. | Emitir una entrada **nueva** como mucho una vez por familia, o ligar el cupo `d:` a la familia. Corregir la frase de la ADR 0018. |
| S-v12-02 | Info | `middleware/version-cliente.ts:26-28`; `app.ts:70-75` | **A3.** La exención compara el método `POST` y la ruta exactos. HEAD, otros métodos, la barra final o las mayúsculas no quedan exentos. Origin (CSRF) y el límite de cuerpo siguen aplicándose. `X-Version-Cliente` la controla el cliente: la versión mínima no es un control de seguridad, así que la exención no abre nada. Un cliente viejo solo puede revocar familias de las que tiene el refresh token o un access token válido. | Ninguna. |
| S-v12-03 | Info | `sync/snapshot.ts:79-126`, `:132-153`, `:222-235` | **A6.** El token sin firma es aceptable: `user_id` y `rol` sirven para la consistencia del cliente, no para el acceso. Cada página se filtra con la visibilidad del actor actual y el alcance `orden` pasa por `puedeVerOrden`. Un `cursor` falsificado solo afecta al pull de quien lo falsifica. Los campos se validan y van enlazados. | Mantener la prueba de que un token falsificado con el propio `user_id` no amplía lo visible. |
| S-v12-04 | Info | `apps/web/src/datos/snapshot-temporal.ts:172-196`; `sync/motor.ts:931-958` | **A6, cliente.** `guardarPagina` acepta una página de continuación aunque no haya progreso guardado y la trata como la primera. Si una respuesta en vuelo cruzara la purga, volvería a sembrar el área temporal. En la práctica no parece alcanzable: el cambio de rol revoca todas las familias y la purga requiere un login nuevo. | Rechazar la página si la petición llevaba `pagina` y no existe progreso previo. |

## Respuestas a las preguntas

1. **A1, N1 y N2.**
   - Toda auditoría y toda dependiente pasan por `sentenciaAuditoriaCondicional` o `sentenciaDependiente`, que exigen en ejecución una `CondicionDeEscritura` registrada en un `WeakSet` (`auditoria/auditar.ts`). Un cast de tipos no la evita.
   - Las marcas son UUID v7 generados por el servidor (62 bits aleatorios). `porPkNueva` solo admite tablas cuya clave genera el servidor.
   - `/sync/push` exige `plan.aplicada` para la fila `aplicada`. La decisión posterior al batch es `meta.changes` de la propia principal.
   - Sin superficie de inyección SQL: tabla en lista blanca, columnas validadas con `^[a-z_][a-z0-9_]*$`, valores enlazados; el marcador de `sentenciaDependiente` debe ir una vez y al final, y solo se sustituye por SQL de los constructores.
   - Sin fuga de `escritura_id`: lecturas con columnas explícitas (sync, usuarios, materiales, settings, asignaciones), fuera de la lista blanca de auditoría, backup con columnas explícitas, y el log del push solo registra `mutation_id` y `tipo`.
   - Sin regresión de autorización: `/users` sigue con `autenticar` y `admin.gestionar`; la guardia del último admin se mantiene; las dependientes se encadenan a la auditoría; la regla de orden se cumple en el login (rehash, desbloqueo heredado y N2).
2. **A3**: ver S-v12-02.
3. **A5.** El desbloqueo de `g` solo ocurre en el batch del login con la contraseña correcta y exige el `reserva_id` de esa misma reserva con un bloqueo vigente. Mientras `g` está bloqueado ninguna otra reserva lo toca; si el admin lo reinicia entretanto, el `reserva_id` cambia y no se descuenta nada; `fallos > 0` evita negativos. `g` queda en máximo − 1, como antes del login: el atacante no gana intentos. La auditoría es correcta.
4. **A8.** La cookie solo se emite tras un refresh exitoso (la reutilización y los errores lanzan antes); las entradas de otros usuarios solo se reemiten si son válidas; los atributos no cambian; la propiedad (a) se mantiene. La única debilidad es S-v12-01.
5. **A6.** La purga del cliente es atómica (una transacción de Dexie sobre los datos, el área temporal y `perfiles`) y solo descarta el área del usuario afectado.
6. **Otros.** Sin secretos ni datos personales nuevos en la auditoría. La migración 0009 solo agrega columnas. El crecimiento de `audit_log` baja: la revocación de una familia ya revocada no se audita.

## Verificado frente a supuestos

- **Verificado leyendo el código**: lo citado arriba con archivo y línea.
- **Supuestos del revisor**: que Hono usa enrutado estricto y el mismo `getPath` para middleware y router; que los batches de D1 son atómicos y serializables (ADR 0010); que `autenticar` relee el rol y la familia en cada petición. La regla de orden no se revisó plan por plan: se apoya en las pruebas del "plan perdedor".

## Riesgos residuales

- La regla de orden de la ADR 0028 se cumple por convención y por pruebas, no por el compilador.
- Sigue S-02: las entradas de `mp_dispositivo` sobreviven al cambio de contraseña.
- Sigue S-01: crecimiento de `audit_log` por bloqueos.
- Pendiente humano: migración 0009 y prueba de B4 en staging.

## Estado de los hallazgos (orquestador)

| Id | Estado |
|---|---|
| S-v12-01 | Corregido: el refresh emite la entrada nueva con un nonce determinista por familia, así un refresh token da como mucho un cupo `d:`. Frase de la ADR 0018 corregida. Ver el commit de S-v12-01 en `docs/INFORME-CORRECCIONES-V1.2.md`. |
| S-v12-02 | Sin acción. |
| S-v12-03 | Sin acción: la prueba `correcciones-a6-token-pagina.test.ts` cubre el rechazo por identidad, y el filtro por visibilidad actual ya lo cubren las pruebas de snapshot de la fase 3. |
| S-v12-04 | Aceptado como riesgo residual (informativo, no alcanzable en la práctica); registrado en `docs/pendientes-humanos.md` como mejora. |

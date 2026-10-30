# Correcciones v1.2 — segunda auditoría externa y CI de GitHub

Auditoría del 2026-10-30 sobre `fix/auditoria-v1` (tag `correcciones-v1.1`):

- En el clon limpio pasaron las 2.252 pruebas y las 28 E2E de Chromium.
- Las 23 baterías de regresión fallan sobre el código previo a su corrección.
- Dos revisores independientes no encontraron nada crítico ni alto.
- El CI de GitHub pasó con el push. **Falló en el PR #1** por un defecto real que solo aparece a veces: el ítem A1.

Este documento es **el alcance de la sesión v1.2**. Cada ítem trae:

- su id;
- su prioridad (P1 antes de fusionar a `main` o de ir a producción, P2 mejora);
- dónde está el problema (rutas y líneas del momento de la auditoría);
- el criterio de aceptación.

**Regla para todos los ítems de código**: primero una prueba de regresión que **falla** con el código actual y que sea **determinista** (no puede depender del azar ni de la velocidad de la máquina). Después, la corrección que la hace pasar. Ambas van en el mismo commit, con `Corrige: <id>` en el cuerpo.

---

## P1

### A1. La auditoría condicionada por coincidencia de hora registra acciones que no ocurrieron

- **Síntoma**: en el CI del PR #1 falló `apps/worker/test/correcciones-b4-evidencias-concurrencia.test.ts:235`. Con 5 subidas simultáneas de la misma foto aparecieron **3** filas `evidencia.subida` en `audit_log` en lugar de 1. En el push anterior y en dos corridas de la auditoría la misma prueba pasó: el fallo depende del azar.
- **Causa**: `sentenciaAuditoriaCondicional` (`apps/worker/src/auditoria/auditar.ts:289-299`) inserta la auditoría `WHERE EXISTS(...)` con una condición que compara el estado final del registro, **incluida una hora** (`updated_at`, `subido_at`, `server_received_at`, `revocado_at`…) igual a `ctx.ahora`.
  - En Workers la hora se congela durante cada petición y tiene resolución de milisegundos, así que dos peticiones concurrentes pueden tener el mismo `ctx.ahora`.
  - La que **pierde** (su UPDATE no cambia filas) ve el registro "como ella lo habría dejado" y **escribe igual su fila de auditoría**. El batch se confirma, y después el código detecta 0 cambios y responde idempotente o con conflicto, pero la auditoría falsa ya quedó escrita y es inmutable.
- **Alcance del patrón**: unas 14 condiciones, en `dominio/evidencias.ts:217`, `dominio/consumos.ts:371` y `:497`, `sync/push.ts:273-289`, `dominio/novedades.ts:85`, `dominio/materiales.ts:158`, `dominio/ordenes.ts:292`, `dominio/settings.ts:97`, `dominio/asignaciones.ts:90`, `rutas/usuarios.ts:191` y `auth/sesiones.ts:530`, más cualquier otra que use `sentenciaAuditoriaCondicional`.
- **Escenario grave**: dos ediciones concurrentes del mismo consumo con la misma `version`. Una gana. La perdedora recibe `CONFLICTO`, pero `audit_log` dice que también editó. La trazabilidad, que es un requisito central (spec §1 y §4), queda falseada.
- **Aceptación** (diseño en un ADR; usa `software-architect` como segunda opinión):
  - La auditoría de cada escritura queda condicionada a que **esa misma petición** haya hecho el cambio, nunca a una coincidencia de valores u horas. Opciones a evaluar en el ADR:
    - **(a)** Condicionar con `changes()` de SQLite justo después de la sentencia principal. Hay que demostrar con pruebas que en D1 el batch corre en la misma conexión y en orden, y dejar en `docs/pendientes-humanos.md` una verificación en staging.
    - **(b)** Usar un identificador de escritura único por petición. Por ejemplo, una columna `escritura_id` en las tablas mutables, agregada con `ALTER TABLE ADD COLUMN` en una migración nueva escrita a mano, **sin reconstruir tablas**. La sentencia principal la fija y la auditoría la comprueba.
    - **(c)** Otra opción equivalente que justifiques.
  - **Pruebas deterministas**: se inyecta el mismo `ahora` en dos peticiones concurrentes (o en dos planes ejecutados en secuencia sobre el mismo estado inicial) para **cada familia** del patrón: subir evidencia, editar consumo por REST y por push, crear consumo o novedad duplicados, validar, materiales, órdenes, settings, asignaciones, usuarios y revocación de familias. Para cada una: exactamente 1 fila de auditoría y ninguna atribuida al perdedor.
  - Una **prueba estática** que falle si alguna condición de auditoría vuelve a depender solo de igualdad de horas o valores. Por ejemplo, que todas las escrituras usen el mecanismo nuevo.
  - La prueba de B4 queda **determinista**.
  - **Repetición**: las pruebas de concurrencia (A1 y B4) se ejecutan **20 veces seguidas** sin fallos. La salida resumida va a la evidencia.
  - Se revisa si el mismo problema afecta a otras decisiones del código que se toman después del batch (por ejemplo `filasEsperadas`, `cambiosEsperados` o `principalAplico`). Si es así, se documenta y se corrige.
  - Si falta, en `docs/despliegue.md` se agrega un procedimiento para detectar filas de auditoría duplicadas o espurias en una base existente. Hoy no hay producción, pero deja la consulta.

### A2. El bloqueo por inactividad de una pestaña en segundo plano bloquea a quien trabaja en otra

- **Dónde**: `apps/web/src/auth/inactividad.ts:88` y `:105`, y `apps/web/src/auth/sesion.ts:751-756` (`bloquear()` siempre avisa a las demás pestañas). La E2E `e2e/sesion-multipestana.spec.ts:40` comprueba el comportamiento actual.
- **Escenario**: el supervisor trabaja 10 min en la pestaña B. El temporizador de la pestaña A, en segundo plano, se dispara y bloquea a B en medio de un registro.
- **Aceptación**:
  - La última actividad se comparte entre las pestañas del mismo usuario. Por ejemplo, con un aviso `actividad` por el canal de sesión (con límite de frecuencia) o una marca compartida.
  - Una pestaña solo bloquea, y solo avisa a las demás, si **ninguna** pestaña tuvo actividad en los últimos 10 min.
  - La vuelta de segundo plano respeta la actividad de las otras pestañas.
  - La E2E se ajusta a la regla nueva, y el cambio se explica en el commit:
    - con actividad en B, A no bloquea;
    - sin actividad en ninguna, ambas se bloquean en menos de 2 s.
  - El ADR 0023 se enmienda.

---

## P2

### A3. Con la versión mínima subida, el logout de un cliente viejo recibe 426

- **Dónde**: `apps/worker/src/middleware/version-cliente.ts:20-29`, que se aplica a todo `/api/v1/*`.
- **Aceptación**:
  - `POST /auth/logout` queda fuera de la exigencia de versión mínima, para que un cliente desactualizado siempre pueda revocar su familia.
  - Se evalúa con el mismo criterio `/auth/refresh` y se documenta.
  - Hay una prueba, y el ADR 0026 se enmienda.

### A4. Un 426 que llega a través de `/auth/refresh` durante el push cuenta un intento y aplica espera

- **Dónde**: `apps/web/src/sync/motor.ts:604` → `:396`, y `apps/web/src/auth/sesion.ts:867`.
- **Aceptación**: si el refresh dentro de un push responde `CLIENTE_DESACTUALIZADO`, el lote vuelve a `pendiente` **sin contar el intento ni aplicar espera**, como promete el ADR 0026. Hay una prueba.

### A5. Un login correcto puede bloquear el tope global `g`

- **Dónde**: `apps/worker/src/auth/cupos.ts:223-248` y `:431-438`.
- **Aceptación**: un login correcto desde un dispositivo conocido no suma al tope global de orígenes desconocidos, o lo descuenta antes de evaluar el bloqueo. Un login correcto nunca deja `g` bloqueado. Hay una prueba.

### A6. Un snapshot reanudado vuelve a meter datos ajenos que la purga de S-03 ya había borrado

- **Dónde**: `apps/web/src/auth/sesion.ts:531` (`purgarAjenosSinVisibilidad`), `apps/web/src/datos/snapshot-temporal.ts:272` y `apps/worker/src/sync/snapshot.ts:195`.
- **Aceptación**:
  - La purga descarta el área temporal del snapshot en la misma transacción.
  - Además, el servidor rechaza continuar un token de página emitido para otro rol o usuario: el token incluye el rol y el usuario, y el servidor los verifica.
  - Hay pruebas en el cliente y en el servidor.

### A7. Si el reemplazo del snapshot falla por cuota llena, la tablet no sale sola de ese estado

- **Dónde**: `apps/web/src/datos/snapshot-temporal.ts:82` y `apps/web/src/sync/motor.ts:806`.
- **Aceptación**:
  - Ante `QuotaExceededError` en una página o en el reemplazo, se descarta el área temporal sin tocar el estado vivo. Se reintenta con espera y se muestra un aviso claro: "Almacenamiento lleno: sincroniza o libera espacio".
  - El push del outbox no queda bloqueado por un snapshot que no se puede completar, siempre que la época lo permita.
  - Hay pruebas que simulan la cuota agotada.

### A8. Solo se reconoce como conocido un dispositivo que tenga la cookie

- **Dónde**: `apps/worker/src/auth/dispositivo.ts:10` y `apps/worker/src/rutas/auth.ts:258-261`.
- **Aceptación**:
  - Un refresh exitoso **renueva o emite** la cookie `mp_dispositivo`, para que los dispositivos con sesión viva la recuperen.
  - El ADR 0018 y `docs/despliegue.md` documentan el efecto de rotar `REFRESH_SECRET`: todos los dispositivos dejan de ser conocidos. Se indica cuándo hacerlo (fuera de un ataque activo) y cómo mitigarlo (desbloqueo de emergencia y comunicación a planta).
  - Hay una prueba de la renovación.

### A9. Documentación incorrecta

- El ADR 0021 dice "ninguna migración borra triggers", pero `migrations/0008_settings_insert_validos.sql:16` hace `DROP TRIGGER` y lo recrea más fuerte. Hay que corregir la frase y explicar el caso.
- `docs/despliegue.md` §9.2, paso 1, todavía admite `login_cupos` como tabla incompleta, aunque ya no se exporta (S-06). Hay que corregirlo.

### A10. Fijar la imagen de los runners de CI

- **Dónde**: `.github/workflows/ci.yml:29,75` y `deploy-staging.yml:26,43` usan `ubuntu-latest`. GitHub avisa que esa etiqueta pasa a Ubuntu 26.
- **Aceptación**:
  - Se usa `ubuntu-24.04` en todos los jobs.
  - La prueba estática de B8 (o una nueva) verifica que ningún workflow use `-latest`.

### A11. Procesos en segundo plano

- **Situación**: en la v1.1, un subagente dejó un shell vigilando una medición durante 5 h 51 min después del informe final.
- **Aceptación**:
  - Ningún comando de espera sin tiempo límite: todo bucle `until`/`while` lleva un tope.
  - Antes del informe final, el orquestador lista y cierra sus tareas y shells en segundo plano, y lo deja en la evidencia.
  - Las mediciones informativas largas no se lanzan en segundo plano sin un tope.

---

## Fuera de alcance

- Tablet real, WebKit en un dispositivo y staging siguen como pendientes humanos.
- Las preguntas de negocio de `docs/preguntas-abiertas.md` no se tocan, salvo que un ítem las afecte.

---

## Nuevos

### N1. La concurrencia optimista por `updated_at` o por valor admite actualizaciones perdidas

- **Prioridad**: P1 (integridad de la auditoría; está en el área de A1).
- **Dónde**: `apps/worker/src/dominio/materiales.ts` (testigo `updated_at`), `dominio/settings.ts` (testigo `valor IS ?`) y `dominio/asignaciones.ts` (testigo `activo`).
- **Escenario**: con escrituras en el mismo milisegundo, una edición basada en una lectura vieja pisa a otra (materiales). Con un valor que vuelve al anterior (ABA), el cambio se aplica con un `datos_antes` que ya no es el estado previo (tolerancia, asignaciones). La restauración usa `datos_antes` (R-04).
- **Aceptación**: la principal exige también la marca de escritura leída (`escritura_id IS ?`, ADR 0028). Prueba determinista en `apps/worker/test/correcciones-n1-concurrencia-optimista.test.ts`.

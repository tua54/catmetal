# Plan de correcciones v1.1

Alcance: `docs/correcciones-v1.1.md`. Orden: **P0 → P1 → P2**. Rama: `fix/auditoria-v1` (desde `build/v1`).

Reglas comunes a todos los ítems de código:

- El subagente escribe primero la prueba de regresión y entrega la salida del fallo con el código actual.
- Después hace la corrección hasta que pasan esa prueba y los gates (`pnpm lint`, `pnpm typecheck`, `pnpm test`).
- El orquestador revisa el `git diff` real y hace un commit por ítem (prueba + corrección) con `Corrige: <id>`. Luego marca el ítem en `docs/correcciones-v1.1.md`.
- Las decisiones de diseño van en ADR nuevos (0018 en adelante), cada uno en su propio commit `docs(adr): …`, **antes** de implementar.
- Máximo 3 subagentes en paralelo y con archivos disjuntos. Los subagentes no hacen commits.
- Cada brief empieza con el bloque de stack de `CLAUDE.md` (TypeScript/Cloudflare, no .NET).

## ADR previstos

> **Numeración final** (difiere de la prevista): 0018 M1, 0019 M2, 0020 M3, 0021 M4, 0022 M5/M6, 0023 M7, 0024 B4, 0025 B12, 0026 B5, 0027 S-03/S-09. B3 no necesitó ADR, porque el contrato no cambió.

| ADR | Ítem | Tema | Segunda opinión |
|---|---|---|---|
| 0018 | M1 | Cupos de login por dispositivo conocido y por origen desconocido, y desbloqueo de emergencia. Reemplaza el punto de bloqueo de ADR 0008. | `software-architect` |
| 0019 | M2 | Hora del dispositivo al enviar (`enviado_at`, `X-Hora-Dispositivo`) para `alerta_reloj` | — |
| 0020 | M3 | Paginación del backup acotada por bytes, aislamiento de tablas fallidas y tope de rechazadas. Enmienda ADR 0014/0016. | — |
| 0021 | M4 | Consistencia entre tablas del backup: marca de corte y reconciliación al restaurar | `software-architect` |
| 0022 | M5/M6 | Snapshot en área temporal y autoridad del servidor tras época o reinicio. Enmienda ADR 0009/0016. | — |
| 0023 | M7 | Propagación de la sesión entre pestañas | — |
| 0024 | B5 | Versión mínima del cliente (`CLIENTE_DESACTUALIZADO`) | — |
| 0025 | B3 | Colisión de PK ajena → `conflicto` sin datos (si el contrato lo exige) | — |

## P0

### C1. Instalar la configuración de Claude Code en el repo

- **Responsable**: orquestador.
- **Archivos**: `.claude/settings.json`, `.claude/sesion.json`, `.claude/hooks/guardia.mjs`, `.claude/hooks/no-parar.mjs` (solo `git add`), `_mover-a-claude/` (eliminación), `CLAUDE.md`, `docs/spec.md`, `docs/correcciones-v1.1.md`, `docs/ARRANQUE-CORRECCIONES.md`.
- **Contrato**: ninguno.
- **Verificación**:
  - `git ls-files .claude` lista los 4 archivos.
  - `git ls-files _mover-a-claude` queda vacío.
  - Se le pasa al hook un JSON con un push por stdin y debe salir con exit 2. Va a `docs/evidencia/correcciones.md`.
- **Commit**: `chore: instalar configuración de claude code y alcance de correcciones v1.1`, con `Agente: equipo`.

### C2. Versión de Node coherente

- **Responsable**: orquestador (cambio pequeño y acotado).
- **Archivos**: `package.json` (engines), los `package.json` de paquetes que declaren `engines` (hoy solo la raíz), `README.md`, `docs/despliegue.md` y `apps/web/src/features/consumos/fotos-diferido.test.ts`.
- **Prueba de regresión**: dentro de la prueba se simula el Blob de Node 22 / jsdom, quitando temporalmente `Blob.prototype.stream`. Hoy falla porque `new Response(blob)` lo necesita. Después se lee con `blob.arrayBuffer()`, con alternativa `FileReader`.
- **Aceptación**: `engines.node >=24`, y el README y `docs/despliegue.md` dicen Node 24. La prueba no depende de `stream()`.

## P1

### Olas de ejecución (archivos disjuntos)

| Ola | En paralelo | Motivo del orden |
|---|---|---|
| 1 | M1 (`general-purpose`, worker auth) · M3→M4 (`general-purpose`, worker cron) · M5→M6 (`react-developer`, `apps/web/src/datos`) | No comparten archivos. M3 toca `sync/push.ts` solo para el tope opcional de rechazadas. |
| 2 | M2-servidor (`general-purpose`) · M7 (`react-developer`, `apps/web/src/auth` + revalidación en `sync/motor.ts`) | M2 toca `sync/push.ts` y `auditoria/auditar.ts` después de M3. M7 toca el motor antes que M2-cliente. |
| 3 | M2-cliente (`react-developer`: `sync/motor.ts`, `auth/cliente-api.ts`, E2E offline) | Depende del contrato de M2-servidor y de M7. |
| Cierre P1 | `security-reviewer` (M1, M7, B1, B3, B4, B5 al final de P2) · `database-specialist` (M3, M4, B7) | La revisión de seguridad se hace con lo que haya de P2 al cerrar. Si B1/B3/B4/B5 aún no están, se repite sobre ellos al cerrar P2. |

### M1. Bloqueo de cuentas abusable (spec §5 v2.1)

- **Responsable**: `general-purpose` (backend). ADR 0018 con segunda opinión de `software-architect`.
- **Archivos**:
  - `apps/worker/src/rutas/auth.ts` y `apps/worker/src/auth/*`.
  - Un módulo nuevo de cupos en `apps/worker/src/auth/`.
  - Una migración nueva `migrations/0007_*.sql` (tabla de cupos por usuario y origen) y el esquema en `apps/worker/src/db/schema.ts`.
  - `packages/shared/src/errores.ts` (solo si cambia algún código), `scripts/desbloqueo-emergencia-sql.mjs` (nuevo), `docs/despliegue.md` (sección de desbloqueo) y las pruebas `apps/worker/test/auth-*.test.ts`.
- **No toca**: `sync/*`, `cron/*` ni `apps/web`.
- **Contrato**: mensaje de error uniforme (`CREDENCIALES_INVALIDAS`), el mismo para cuenta inexistente o bloqueada. Si el dispositivo conocido se identifica con una cookie firmada del dispositivo, se documenta en el ADR y se agrega a la lista de cookies.
- **Diseño a validar en el ADR**:
  - Cupo por (cuenta, dispositivo conocido) separado del cupo por (cuenta, origen desconocido). Hay 5 fallos por cada 15 min y un tope global por cuenta para los orígenes desconocidos.
  - El "dispositivo conocido" se prueba con un secreto que entrega el servidor tras un login correcto (cookie `HttpOnly` firmada con HMAC, OWASP *device cookies*), nunca con un id que mande el cliente sin firma.
  - Ningún cupo bloquea al dispositivo conocido por fallos de otros orígenes.
  - El tiempo de respuesta tiene un piso: se hace el PBKDF2 aunque la cuenta no exista o el cupo esté agotado.
- **Pruebas de regresión que deben fallar hoy**:
  1. Tras 50 fallos desde orígenes desconocidos, el usuario legítimo entra desde su dispositivo conocido. Hoy falla por el bloqueo duro.
  2. Desde un origen desconocido, el sexto intento dentro de 15 min se rechaza con el mensaje uniforme, aunque la contraseña sea correcta.
  3. El script de desbloqueo genera SQL que, aplicado a la D1 local, desbloquea la cuenta, respeta los triggers e inserta su fila de `audit_log`.
  4. El mensaje es igual para un email inexistente, uno bloqueado y una contraseña errónea, y la duración tiene un piso.
- **Aceptación**: (a)–(d) de la spec §5 v2.1.

### M2. `alerta_reloj` con la hora del dispositivo al enviar (spec §6 v2.1)

- **Responsables**: `general-purpose` (servidor) y `react-developer` (cliente). ADR 0019.
- **Archivos del servidor**:
  - `packages/shared/src/esquemas.ts`: `enviado_at` opcional en el cuerpo del push y un esquema para el header.
  - `apps/worker/src/auditoria/auditar.ts` (`calcularAlertaReloj`) y los sitios que lo alimentan con `client_created_at` (`dominio/*.ts`, `sync/push.ts`).
  - `apps/worker/src/rutas/*.ts`: lectura de `X-Hora-Dispositivo` en un middleware común.
  - Pruebas en `apps/worker/test/`.
- **Archivos del cliente**: `apps/web/src/sync/motor.ts` (`enviado_at` en el momento de enviar), `apps/web/src/auth/cliente-api.ts` (header en las escrituras REST) y `e2e/registro-offline.spec.ts`.
- **Contrato**:
  - `enviado_at` es opcional (ISO-8601 UTC). Si su formato es inválido, se ignora y no se rechaza.
  - El header `X-Hora-Dispositivo` es opcional, con el mismo formato y la misma regla.
  - Un cliente viejo, que no manda la hora, deja `alerta_reloj = 0`.
- **Pruebas de regresión que deben fallar hoy**:
  - Un consumo con `client_created_at` de hace 3 h y `enviado_at` igual a la hora actual → `alerta_reloj = 0`. Hoy es 1.
  - Con `enviado_at` desfasado 15 min → 1.
  - Sin `enviado_at` → 0. Hoy es 1 si `client_created_at` es viejo.
  - Lo mismo por REST con el header.
  - La E2E offline verifica que las filas de auditoría quedan con 0.
- **Dependencias**: después de M3 (los dos tocan `sync/push.ts`); M2-cliente va después de M7 (los dos tocan `sync/motor.ts`).

### M3. Backup acotado por memoria

- **Responsable**: `general-purpose`. ADR 0020.
- **Archivos**: `apps/worker/src/cron/backup.ts`, `apps/worker/src/cron/presupuesto.ts`, `apps/worker/src/cron/ejecutar.ts`, `apps/worker/test/fase6-cron-*.test.ts` y, si se implementa el tope, `apps/worker/src/sync/push.ts` y su prueba.
- **Diseño**:
  - La página se acota por bytes además de por filas: se suma `length()` en SQL hasta un límite por página (o la página se adapta).
  - El gzip y la subida multiparte se escriben por partes, sin acumular la tabla en memoria.
  - Una tabla que falla de forma persistente (N reintentos) queda `incompleta` en el manifest y en el log, y el backup sigue con las demás.
  - Tope de rechazadas: se evalúa truncar `payload_json` de las mutaciones **rechazadas** y no aplicadas. Eso no pierde datos de planta, porque la mutación sigue en el outbox del cliente. La alternativa es un tope diario por usuario. La decisión va en el ADR.
- **Pruebas de regresión que deben fallar hoy**:
  - 2.500 filas de ~64 KiB en `sync_mutations` completan el backup, y el manifest cuadra en conteos y sha256. Hoy la página de 2.000 filas de ~64 KiB excede el presupuesto de memoria que mide la prueba (se instrumenta el tamaño de página).
  - Una tabla con fallo persistente simulado → `incompleta`, y las demás tablas se respaldan.

### M4. Backup consistente entre tablas

- **Responsable**: `general-purpose`, después de M3 (los mismos archivos). ADR 0021 con segunda opinión de `software-architect`.
- **Archivos**: `apps/worker/src/cron/tablas.ts`, `apps/worker/src/cron/backup.ts`, `scripts/restaurar-backup.mjs` (nuevo: genera SQL de importación y de reconciliación desde el NDJSON), `docs/despliegue.md` §9 y las pruebas.
- **Diseño a validar**:
  - Al iniciar se toma una marca de corte (`MAX(audit_log.seq)` y la hora), que va al manifest.
  - Cada tabla se exporta en un orden que respete la causalidad: `audit_log` al final o filtrado por `seq <= corte`.
  - Al restaurar, se reconcilia con un procedimiento determinista. La opción preferida es volver a pendiente lo decidido sin validación, o, si no, descartar lo posterior al corte, con su auditoría.
  - Lo que se escribió en la ventana del backup y falta en la auditoría se repara o se descarta de forma consistente.
- **Prueba de regresión que debe fallar hoy**:
  - Se simula una aprobación del jefe entre la exportación de `validations` y la de `consumptions`.
  - Se importa el NDJSON en una D1 local limpia y se ejecuta el procedimiento.
  - No debe quedar ningún consumo decidido sin validación ni ninguna fila sin su auditoría.

### M5. Snapshot en un área temporal

- **Responsable**: `react-developer` (sync del cliente; brief detallado). ADR 0022 (compartido con M6).
- **Archivos**:
  - `apps/web/src/datos/entidades.ts` (`reiniciarEstadoSincronizado`), `apps/web/src/datos/aplicar-cambios.ts`, `apps/web/src/datos/db.ts` (si hace falta una tabla temporal: nueva versión de Dexie con migración que no pierda datos), `apps/web/src/datos/servidor.ts` y `apps/web/src/sync/motor.ts` (solo la parte del snapshot).
  - Las pruebas en `apps/web/src/datos/*.test.ts`.
- **Pruebas de regresión que deben fallar hoy**:
  - Un snapshot interrumpido a mitad deja los catálogos y las órdenes anteriores disponibles, y se puede registrar offline.
  - Un snapshot completo reemplaza el estado.

### M6. Autoridad del servidor tras época o reinicio

- **Responsable**: `react-developer`, después de M5 (los mismos archivos).
- **Archivos**: `apps/web/src/datos/servidor.ts`, `apps/web/src/datos/entidades.ts` (`masReciente`), `apps/web/src/datos/aplicar-cambios.ts` y las pruebas.
- **Pruebas de regresión que deben fallar hoy**:
  - Tras un cambio de época, un consumo local `aprobado` con versión 3 y el servidor `pendiente` con versión 2 → la copia local queda `pendiente`, salvo que haya una mutación local pendiente.
  - Un `conflicto` en modo propio actualiza la copia local con la versión del servidor.

### M7. Cierre de sesión entre pestañas

- **Responsable**: `react-developer`. ADR 0023.
- **Archivos**:
  - `apps/web/src/auth/sesion.ts`, `apps/web/src/auth/store.ts` y `apps/web/src/auth/inactividad.ts` (avisar del bloqueo).
  - `apps/web/src/sync/motor.ts` (revalidar la identidad antes de cada envío).
  - Las pruebas de `apps/web/src/auth/*.test.ts` y una E2E nueva `e2e/sesion-multipestana.spec.ts`.
- **Contrato**: el canal `BroadcastChannel('catmetal-sesion')` lleva los mensajes `{ tipo: 'logout' | 'bloqueo' | 'cambio-usuario', user_id }`. Si no hay `BroadcastChannel`, se usa el evento `storage` con una clave de `localStorage` que no guarda secretos.
- **Pruebas de regresión que deben fallar hoy**:
  - Una prueba de componentes con dos instancias que comparten el canal: al cerrar sesión en una, la otra vuelve al login en menos de 2 s.
  - Una prueba del motor: si la identidad cambia entre el lote y el envío, no envía.
  - Una E2E con dos páginas del mismo contexto.

## P2

| Ola | En paralelo |
|---|---|
| 4 | B1+B2+B6 (`general-purpose`, `apps/worker/src/auth/`) · B9+B10 (`react-developer`, `datos/outbox.ts`, `auth/candado.ts`, `sync/motor.ts`) · B7+B8 (orquestador: migración y workflow) |
| 5 | B3+B12+B11 (`general-purpose`, `sync/push.ts`, `dominio/errores-d1.ts`, `dominio/validaciones.ts`) · B4 (`general-purpose`, `rutas/evidencias.ts`) |
| 6 | B5 (servidor `general-purpose` → cliente `react-developer`; `packages/shared`, un middleware del worker y `apps/web/src/pwa/`) |

| Id | Responsable | Archivos | Prueba de regresión (falla hoy) | Aceptación |
|---|---|---|---|---|
| B1 | `general-purpose` | `auth/sesiones.ts`, `test/auth-refresh.test.ts` | Hay un login, rotaciones repetidas y el reloj se avanza 30 días y 1 min: hoy el refresh se acepta. | La familia vence a los 30 días del login aunque se rote. |
| B2 | orquestador | `docs/desviaciones.md` | — (documental) | La entrada referencia ADR 0008 punto 3. |
| B3 | `general-purpose` | `dominio/errores-d1.ts`, `sync/push.ts`, `test/fase3-push*.test.ts`; cliente: `apps/web/src/sync/motor.ts` (mostrar `conflicto` sin datos) | Una colisión de PK con una fila de otro usuario hoy responde `rechazada`/`ID_DUPLICADO`. | `conflicto` sin datos de la fila ajena. Las pruebas existentes se actualizan y se explica en el commit. |
| B4 | `general-purpose` | `rutas/evidencias.ts`, `dominio/evidencias.ts`, `test/fase2-evidencias.test.ts` | Dos subidas concurrentes de la misma evidencia: la que pierde borra el objeto que la otra confirmó. | Nunca se borra un objeto confirmado en D1, por ejemplo con una clave por intento. |
| B5 | `general-purpose` + `react-developer` | `packages/shared` (código y versión), un middleware del worker, `apps/web/src/pwa/registro.ts`, `AvisoActualizacion.tsx`, `auth/cliente-api.ts` | Un cliente con una versión menor que la mínima hoy no recibe `CLIENTE_DESACTUALIZADO`. | Se fuerza la actualización sin perder el outbox, con pruebas en ambos lados. |
| B6 | `general-purpose` | `auth/contrasenas.ts`, `rutas/auth.ts`, `test/auth-login.test.ts` | Un hash de 10.000 iteraciones hoy sigue igual después de un login correcto. | Se recalcula a 100.000 en el mismo batch que la auditoría. |
| B7 | orquestador o `general-purpose` | `migrations/0008_*.sql` (a mano), `test/integridad-triggers.test.ts`, `test/integridad-esquema.test.ts` | Hoy se acepta un INSERT de una clave desconocida o de `tolerancia_pct` = 150. | Trigger `BEFORE INSERT` equivalente; la prueba de `sqlite_master` se actualiza. |
| B8 | orquestador | `.github/workflows/deploy-staging.yml` | Una prueba de Node lee el YAML y exige `if: github.ref == 'refs/heads/main'`. | El job lleva la condición. |
| B9 | `react-developer` | `datos/outbox.ts`, `datos/retencion.ts`, la UI de cierre de sesión | Una foto `bloqueada` sin subir hoy no cuenta en `puedeBorrarDatosDeUsuario` y la retención la borra. | Se cuenta, la UI avisa y la retención no la borra. |
| B10 | `react-developer` | `auth/candado.ts`, `sync/motor.ts` | Con el reloj simulado, una sync más larga que el TTL pierde el candado. | El candado se renueva y el motor trata `CONFLICTO` de `marcarEnviando` como esperado. |
| B11 | `general-purpose` | `dominio/validaciones.ts`, `test/fase2-validaciones.test.ts` | Se simula un `meta.changes` que no cuenta las filas del trigger: hoy falla. | La verificación usa una lectura en el mismo batch o `RETURNING`. |
| B12 | `general-purpose` | `sync/push.ts`, `test/fase3-push-limites.test.ts` | Con contención simulada (reintentos máximos), el contador de consultas supera el presupuesto. | Hay un presupuesto de consultas: el lote se corta antes de 1000 y las mutaciones restantes quedan sin resultado. |

## Cierre

1. Revisiones de `security-reviewer` y `database-specialist` (ver la tabla de P1). Los hallazgos altos y críticos se corrigen antes de cerrar.
2. Gates completos: `pnpm lint`, `pnpm typecheck`, `pnpm test` (con cobertura ≥ 80 % en `apps/worker/src` y `packages/shared`), `pnpm test:e2e`, `pnpm format:check`, `pnpm audit --prod` y `pnpm test:lighthouse` (≥ 90). La evidencia va a `docs/evidencia/correcciones.md`.
3. Se escribe `docs/INFORME-CORRECCIONES.md`, se hace el commit `docs: informe de correcciones v1.1` y se crea el tag anotado local `correcciones-v1.1`. Sin push.

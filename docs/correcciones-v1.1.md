# Correcciones v1.1 — resultado de la auditoría externa de `build/v1`

Auditoría del 2026-10-30, hecha sobre un clon limpio. Se repitieron los gates, las 1.926 pruebas y las 26 E2E de Chromium (todo en verde con Node 24), y tres revisores independientes revisaron el código. No hubo hallazgos críticos ni altos.

Este documento es **el alcance de la sesión de correcciones**. Cada ítem trae:

- su id;
- su prioridad (P0 antes del push, P1 antes de producción, P2 mejora);
- dónde está el problema (rutas y líneas del momento de la auditoría; pueden haberse desplazado un poco);
- el criterio de aceptación.

Los cambios de la spec de esta ronda están en `docs/spec.md` §14 (v2.1).

**Regla para todos los ítems de código**: primero se escribe una prueba de regresión que **falla** con el código actual. Después viene la corrección que la hace pasar. Ambas van en el mismo commit, y el cuerpo del commit cita el id del ítem (por ejemplo, `Corrige: M3`).

---

## P0 — antes del push

### C1. Instalar la configuración de Claude Code en el repo

- **Estado**: RESUELTO (5e5cdcf). Evidencia en `docs/evidencia/correcciones.md`.

- **Situación**: los hooks no estuvieron activos en la sesión anterior porque `_mover-a-claude/` nunca se movió a `.claude/`, y esa carpeta quedó versionada en el commit de línea base.
- **Quién hace qué**: el equipo humano mueve la carpeta **antes** de lanzar esta sesión (`docs/ARRANQUE-CORRECCIONES.md`). Claude Code solo registra el cambio en git: `git add -A .claude _mover-a-claude`.
- **Aceptación**:
  - `git ls-files .claude` lista `settings.json`, `sesion.json` y los dos hooks.
  - `git ls-files _mover-a-claude` está vacío.
  - El hook `guardia.mjs` bloquea `git push`. Se verifica pasándole JSON por stdin a `node .claude/hooks/guardia.mjs`; el resultado esperado es exit 2. La salida va a la evidencia.

### C2. Versión de Node coherente

- **Estado**: RESUELTO (e06919d).

- **Situación**: `package.json` declara `engines.node >=22`, pero con Node 22 falla `apps/web/src/features/consumos/fotos-diferido.test.ts`. El Blob de jsdom no tiene `stream()` y la prueba usa `new Response(blob)`. `.nvmrc` y el CI usan 24.
- **Aceptación**:
  - `engines.node` pasa a `>=24` (en la raíz y en los paquetes que lo declaren).
  - El README y `docs/despliegue.md` dicen Node 24.
  - Además, la prueba lee el blob con `blob.arrayBuffer()` o un `FileReader`, para no depender de la versión de Node.

---

## P1 — antes de producción

### M1. El bloqueo de cuentas se puede abusar (spec §5, v2.1)

- **Estado**: RESUELTO (e8e5a27). ADR 0018. Pruebas: `apps/worker/test/correcciones-m1-login-cupos.test.ts` y `correcciones-m1-dispositivo.test.ts`.

- **Dónde**: `apps/worker/src/rutas/auth.ts:103` (clave `${ip}:${email}` del limitador) y `:136-172` (`reservarIntento`, bloqueo por cuenta).
- **Escenario**: un tercero sin cuenta manda 5 contraseñas erróneas a cada admin y jefe cada 15 min. Nadie de esos roles puede iniciar sesión, y si todos los admin están bloqueados nadie puede desbloquear.
- **Aceptación**: el diseño cumple (a)–(d) de la spec §5 v2.1 y tiene su ADR. Pruebas que lo demuestren:
  - Con 50 fallos desde orígenes desconocidos, el usuario legítimo sigue entrando desde su dispositivo conocido.
  - Desde un origen desconocido, el ritmo de adivinanzas queda acotado.
  - El script de desbloqueo de emergencia genera el SQL correcto, y ese SQL respeta los triggers y la auditoría.
  - El mensaje es uniforme y el tiempo de respuesta tiene un piso.

### M2. `alerta_reloj` marca casi todo lo registrado offline (spec §6, v2.1)

- **Estado**: PARCIAL: servidor RESUELTO (d498af3); falta el cliente (`enviado_at`, `X-Hora-Dispositivo`) y la E2E. ADR 0019.

- **Dónde**: `apps/worker/src/auditoria/auditar.ts:220-229` (`calcularAlertaReloj`), alimentado con `client_created_at` en `dominio/consumos.ts:366` y otros sitios.
- **Aceptación**:
  - El cliente envía `enviado_at` en `/sync/push` y `X-Hora-Dispositivo` en el REST que escribe. Ambos se validan con Zod; ante un formato inválido, se ignoran.
  - Un consumo registrado offline hace 3 h y enviado con el reloj correcto → `alerta_reloj = 0`.
  - Un envío con el reloj del dispositivo desfasado 15 min → `alerta_reloj = 1`.
  - Sin hora de envío → `alerta_reloj = 0`.
  - La E2E offline verifica que las filas de auditoría quedan con 0.

### M3. Un cliente puede hacer fallar el backup de forma permanente (memoria)

- **Estado**: RESUELTO (88c6afb, junto con M4). ADR 0020. Pruebas: `apps/worker/test/fase6-cron-bytes.test.ts`, `fase6-cron-aislamiento.test.ts` y `fase3-push-recorte.test.ts`. El tope por usuario y día se evaluó y no se implementó (ADR 0020).

- **Dónde**: `apps/worker/src/cron/backup.ts:54` (`TAMANO_PAGINA = 2000`) y `:398-412` (`SELECT *` por página); `sync/push.ts:140-146` guarda `payload_json` de hasta 64 KiB por mutación rechazada.
- **Escenario**: unas 80 peticiones de 25 mutaciones inválidas de unos 63 KB llevan una página de `sync_mutations` a unos 128 MB. El Worker se queda sin memoria, la tabla se reintenta para siempre y las tablas siguientes nunca se respaldan.
- **Aceptación**:
  - La paginación queda acotada por **bytes**, no solo por filas (por ejemplo, un límite de bytes por página con `length()` en SQL, o una página adaptativa). Lo que se acumula en memoria se escribe por partes.
  - Una prueba con al menos 2.500 filas de unos 64 KiB completa el backup, y su manifest cuadra en conteos y sha256.
  - Una tabla que falla de forma persistente no impide respaldar las demás: el error queda en el manifest como `incompleta` y en el log.
  - Evalúa también si hace falta un tope de crecimiento de `sync_mutations` rechazadas por usuario y día. Si lo implementas, que no pierda datos de planta y quede en el ADR.

### M4. Restaurar desde el backup de R2 puede dejar consumos decididos sin su validación

- **Estado**: RESUELTO (88c6afb). ADR 0021. Prueba: `apps/worker/test/fase6-restauracion.test.ts`. Procedimiento en `docs/despliegue.md` §9.2.

- **Dónde**: orden de `apps/worker/src/cron/tablas.ts` (`audit_log → sync_mutations → validations → … → consumptions`); `docs/despliegue.md` §9.
- **Escenario**: el jefe aprueba entre la exportación de `validations` y la de `consumptions`. El backup restaurado tiene el consumo `aprobado` sin su fila de validación, y el reenvío del jefe recibe `CONSUMO_NO_PENDIENTE`. Además, falta en la auditoría lo que se escribió durante la ventana del backup.
- **Aceptación** (diseño en un ADR):
  - Un backup restaurado es **consistente entre tablas**. Por ejemplo, se puede tomar una marca de corte al inicio (`seq` máximo de `audit_log` más la hora) y, al restaurar, reconciliar con un script verificado. O cambiar el orden y aplicar una reparación determinista. Tú eliges.
  - Hay una prueba que simula una decisión del jefe entre dos tablas. Tras "restaurar" (importar el NDJSON en una D1 local limpia y ejecutar el procedimiento documentado), no queda ningún consumo decidido sin validación, ni ninguna fila sin su auditoría.
  - `docs/despliegue.md` §9 queda actualizado con el procedimiento exacto.

### M5. Al resincronizar, la tablet borra órdenes y catálogos antes de volver a bajarlos

- **Estado**: RESUELTO (bf91c2f). ADR 0022. Pruebas: `apps/web/src/sync/motor.test.ts` (describe "snapshot en un área temporal (M5)…") y `apps/web/src/datos/snapshot-temporal.test.ts`.

- **Dónde**: `apps/web/src/datos/entidades.ts:399-413` (`reiniciarEstadoSincronizado`) y `apps/web/src/datos/aplicar-cambios.ts:239-250` y `306-310`.
- **Escenario**: la red se cae a mitad del snapshot y el supervisor queda sin órdenes ni materiales en la tablet. Ya no puede registrar sin conexión.
- **Aceptación**:
  - El snapshot se descarga a un área temporal y se reemplaza el estado anterior **solo cuando está completo**, en una transacción Dexie.
  - Prueba: si el snapshot se interrumpe, los catálogos y las órdenes anteriores siguen disponibles y se puede registrar offline.
  - Prueba: si el snapshot se completa, el estado queda reemplazado.

### M6. Después de una restauración del servidor, la tablet conserva estados que el servidor ya no tiene

- **Estado**: RESUELTO (bf91c2f). ADR 0022. Pruebas: `motor.test.ts` (M6) y `apps/web/src/datos/outbox.test.ts` ("M6: un conflicto adopta la copia del servidor…").

- **Dónde**: `apps/web/src/datos/servidor.ts:179-195` y `apps/web/src/datos/entidades.ts:76-81` y `:419-424` (`masReciente` se queda con la versión más alta).
- **Escenario**: el jefe aprueba en línea por REST, y después se restaura un punto anterior. La tablet sigue mostrando "Validado por jefe" mientras el servidor tiene `pendiente`, y editar ese consumo falla o entra en conflicto.
- **Aceptación**:
  - Ante un cambio de época o un reinicio, la **versión del servidor es la autoridad** para todo lo que no sea una mutación local pendiente. Lo local que ya no está pendiente se reemplaza aunque su versión sea mayor.
  - Un `conflicto` en modo propio también actualiza la copia local con la del servidor.
  - Hay pruebas de ambos casos.

### M7. Cerrar sesión no se propaga a otras pestañas o ventanas

- **Dónde**: `apps/web/src/auth/sesion.ts:815-865`. No hay `BroadcastChannel` ni evento `storage`.
- **Aceptación**:
  - Al cerrar sesión, al bloquear por inactividad o al cambiar de usuario en una pestaña, las demás descartan la sesión en memoria y vuelven al login (o al bloqueo) en menos de 2 s. Se usa `BroadcastChannel`, con el evento `storage` como alternativa.
  - Las mutaciones nunca salen con la identidad anterior: el motor revalida antes de cada envío.
  - Hay una prueba de componentes o una E2E con dos páginas del mismo contexto.

---

## P2 — mejoras (hazlas después de cerrar P0 y P1)

### B1. Vida máxima de la familia de refresh (spec §5, v2.1)

- **Estado**: RESUELTO (f5d4454). Prueba: `apps/worker/test/correcciones-b1-vida-familia.test.ts`.

- **Dónde**: `apps/worker/src/auth/sesiones.ts:325` (cada rotación da 30 días nuevos).
- **Aceptación**: la familia vence a los 30 días del login con contraseña aunque se rote, y hay una prueba de ello.

### B2. Documentar la ventana de gracia de la rotación

- **Estado**: RESUELTO (51f7956): entrada D10 en `docs/desviaciones.md`.

- **Dónde**: `sesiones.ts:411-440`; ADR 0008 punto 3.
- **Aceptación**: hay una entrada en `docs/desviaciones.md` que referencia el ADR.

### B3. Una colisión de PK con una fila ajena debe responder `conflicto` (spec §4)

- **Estado**: PARCIAL: servidor RESUELTO (f8b5c1b); falta que el cliente lo muestre como conflicto. Prueba: `apps/worker/test/correcciones-b3-colision-pk.test.ts`.

- **Dónde**: `apps/worker/src/dominio/errores-d1.ts:226` y `apps/worker/src/sync/push.ts:456` (hoy responde `rechazada` con `ID_DUPLICADO`).
- **Aceptación**:
  - La respuesta es `conflicto`, sin datos de la fila ajena (no se filtra nada a otros usuarios). El cliente la muestra como conflicto.
  - Las pruebas existentes se actualizan y el cambio se explica en el commit.

### B4. Una subida concurrente de la misma foto puede borrar un objeto de R2 válido

- **Estado**: RESUELTO (ea0f97d). ADR 0024. Prueba: `apps/worker/test/correcciones-b4-evidencias-concurrencia.test.ts`.

- **Dónde**: `apps/worker/src/rutas/evidencias.ts:84-96`.
- **Aceptación**: una subida que pierde la carrera nunca borra un objeto que otra ya confirmó en D1 (por ejemplo, con una clave por intento o un borrado condicional). Hay una prueba de concurrencia.

### B5. Versión mínima del cliente

- **Estado**: PARCIAL: servidor RESUELTO (2a81cf2), ADR 0026; falta el cliente.

- **Dónde**: `apps/web/src/pwa/AvisoActualizacion.tsx` y `pwa/registro.ts`.
- **Aceptación**:
  - El cliente envía su versión. Si es menor que la mínima del servidor, recibe un código `CLIENTE_DESACTUALIZADO` y la app fuerza la actualización **sin perder el outbox**.
  - Hay pruebas de ambas partes.

### B6. Hashes de contraseña con pocas iteraciones

- **Estado**: RESUELTO (51a3ed3). Prueba: `apps/worker/test/correcciones-b6-rehash.test.ts`.

- **Dónde**: `apps/worker/src/auth/contrasenas.ts:56-62` (acepta de 1 a 100.000).
- **Aceptación**: un hash con menos de 100.000 iteraciones se acepta una vez y se **recalcula** a 100.000 al iniciar sesión, en el mismo batch que la auditoría.

### B7. El trigger de `settings` solo protege los UPDATE

- **Estado**: RESUELTO (231ad15). Migración `0008_settings_insert_validos.sql`. Prueba: `apps/worker/test/correcciones-b7-settings-insert.test.ts`.

- **Dónde**: `migrations/0004_integridad_reforzada_triggers.sql` (`settings_valores_validos`).
- **Aceptación**:
  - Hay un trigger `BEFORE INSERT` equivalente: solo se aceptan claves conocidas y `tolerancia_pct` entre 0 y 100.
  - Va en una **migración nueva** escrita a mano.
  - La prueba de `sqlite_master` se actualiza.

### B8. Restringir el despliegue a `main` dentro del workflow

- **Estado**: RESUELTO (8f24550). Prueba: `apps/worker/test/correcciones-b8-workflow-despliegue.test.ts`.

- **Dónde**: `.github/workflows/deploy-staging.yml`.
- **Aceptación**: el job lleva `if: github.ref == 'refs/heads/main'`, además de la política del environment.

### B9. Las fotos bloqueadas se borran al cerrar sesión

- **Dónde**: `apps/web/src/datos/outbox.ts:1101-1106`, `1162-1168` y `1283-1298`.
- **Aceptación**:
  - `puedeBorrarDatosDeUsuario` cuenta las fotos `bloqueada` que nunca llegaron al servidor, y la UI avisa.
  - La retención automática tampoco las borra.
  - Hay una prueba.

### B10. El candado alternativo vence sin renovarse

- **Dónde**: `apps/web/src/auth/candado.ts:33` y `:55-77`.
- **Aceptación**:
  - El candado de IndexedDB se renueva mientras dura la sync.
  - El motor trata `ErrorDatosLocales('CONFLICTO')` de `marcarEnviando` como un caso esperado.
  - Hay una prueba con el reloj simulado.

### B11. Aprobar y rechazar dependen de cómo D1 cuenta los cambios

- **Estado**: RESUELTO (69eb496). Prueba: `apps/worker/test/correcciones-b11-validaciones.test.ts`.

- **Dónde**: `apps/worker/src/dominio/validaciones.ts:171` (`cambiosEsperados: 2`); `docs/notas-plataforma.md:63`.
- **Aceptación**:
  - La verificación del resultado no depende de que `meta.changes` incluya las filas que actualiza un trigger. Por ejemplo, comprueba con una lectura en el mismo batch o con `RETURNING`.
  - Hay una prueba que no asume ese conteo.

### B12. Tope de consultas por invocación del push en condiciones de contención

- **Estado**: RESUELTO (65e4732). ADR 0025. Prueba: `apps/worker/test/correcciones-b12-presupuesto-push.test.ts`.

- **Dónde**: `apps/worker/src/sync/push.ts` (`MAX_INTENTOS`).
- **Aceptación**:
  - El push lleva un presupuesto de consultas y corta el lote limpiamente antes de las 1000. Las mutaciones restantes quedan sin resultado y el cliente las reenvía.
  - Hay una prueba.

---

## Fuera de alcance de esta sesión

- La verificación en una tablet real, WebKit/Safari en un dispositivo y el CI en GitHub siguen como pendientes humanos.
- Las preguntas abiertas de negocio de `docs/preguntas-abiertas.md` no se tocan, salvo que un ítem de este documento las afecte.

---

## Nuevos

### N1. La aserción "sin EXIF" de la prueba de fotos era vacía (P1, área de C2)

- **Dónde**: `apps/web/src/features/consumos/fotos-diferido.test.ts`; la rama alternativa de `leerBytes` en `apps/web/src/features/consumos/fotos.ts` y `apps/web/src/datos/outbox.ts`.
- **Hallazgo**: en jsdom, `new Response(blob)` no lee el Blob. Lo convierte al texto `"[object Blob]"`. Así, `tieneExif(...) === false` pasaba siempre, también con Node 24. La alternativa con `Response` del código tenía el mismo defecto en entornos sin `Blob.arrayBuffer`.
- **Corrección**: el helper `apps/web/src/lib/blob.ts` (`leerBlob`) usa `arrayBuffer()` o, si no existe, `FileReader`. La prueba ahora exige el tamaño y el SOI del JPEG.
- **Estado**: RESUELTO (e06919d).

### N2. Volver a correr el seed deja la D1 local sin poder auditar (P2, local)

- **Dónde**: `scripts/seed.mjs` (`sentenciasDe`: la auditoría usa `INSERT … SELECT … ON CONFLICT DO NOTHING`).
- **Hallazgo**: en SQLite, un `INSERT` que se omite por `ON CONFLICT DO NOTHING` u `OR IGNORE` **igual hace avanzar** `sqlite_sequence` en una tabla AUTOINCREMENT. Comprobado con SQLite 3.53.1. Al volver a correr el seed idempotente, `audit_log` queda con `sqlite_sequence` por encima de `max(seq)`, y el trigger `audit_log_seq_sin_saltos` rechaza **toda** auditoría posterior: la D1 local de desarrollo tenía 31 filas y la secuencia en 60. El código del Worker y los scripts de producción (`crear-admin-sql.mjs` y `desbloqueo-emergencia-sql.mjs`) no usan esa forma sobre `audit_log`.
- **Corrección**: la auditoría del seed usa `WHERE NOT EXISTS`. Una prueba estática impide `ON CONFLICT` y `OR IGNORE` en las inserciones a `audit_log` de `apps/worker/src`, `migrations/` y `scripts/`.
- **Estado**: RESUELTO (25c254a).

### N3. El filtro de auditoría no acepta la entidad `login_cupos` (P2)

- **Dónde**: `ENTIDADES_AUDITORIA` en `packages/shared/src/reportes.ts`.
- **Hallazgo**: el admin ve las filas de `login_cupos` en `/audit` sin filtro, pero `?entidad=login_cupos` responde 400.
- **Estado**: RESUELTO (41ae133).


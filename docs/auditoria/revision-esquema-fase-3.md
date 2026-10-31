# Revisión del esquema y del protocolo de sincronización — cierre de la Fase 3

- Revisor: `database-specialist` (solo lectura), 2026-10-29, HEAD `d670039`.
- Alcance: `migrations/0000–0004`, `apps/worker/src/{db/schema.ts, sync/*, rutas/sync.ts, dominio/{plan,errores-d1,consumos,novedades,validaciones,visibilidad}.ts, cron/*}`; del cliente, solo coherencia del protocolo: `apps/web/src/datos/{aplicar-cambios,entidades,outbox}.ts`, `apps/web/src/sync/motor.ts`; ADR 0005, 0009, 0010, 0014, 0015.
- Método: lectura del código con evidencia `archivo:línea`; banco `node:sqlite` (SQLite 3.53.1) con las migraciones reales y 200k consumos, 600k filas de auditoría, 60k `sync_mutations`, 100k refresh tokens, `EXPLAIN QUERY PLAN` y tiempos; límites de plataforma en la documentación oficial (https://developers.cloudflare.com/d1/platform/limits/, https://developers.cloudflare.com/workers/platform/limits/).
- Línea base: 1.114 pruebas del worker en verde, 97,62 % de líneas.

## Resumen

Ninguna sentencia del servidor duplica una mutación ni deja datos parciales; el clasificador nunca guarda como rechazado un error transitorio; el cursor del pull no pierde cambios. Los riesgos están en los bordes del protocolo (época, hidratación, backup grande) y en lo que pasa tras una restauración.

## Hallazgos

| # | Sev. | Hallazgo | Evidencia | Recomendación | Estado |
|---|---|---|---|---|---|
| A1 | Alta | El push sale antes de detectar el cambio de época: tras una restauración, una novedad/edición dependiente de un consumo perdido queda `rechazada` y **guardada** (el reenvío devuelve la respuesta guardada), aunque luego el consumo se reaplique | `apps/web/src/sync/motor.ts:294-301`, `apps/worker/src/sync/push.ts:324-360`, `packages/shared/src/esquemas.ts:387` | Época opcional en el sobre del push; si no coincide → 409 `EPOCA_CAMBIADA` sin procesar ni guardar nada; el cliente devuelve el lote a pendiente, hace pull (detecta la época, reencola y snapshot) y repite el push | Corregido (servidor 2bb5ef5, cliente f01ae99) |
| A2 | Alta | Una hidratación persistida cuyo snapshot devuelve 404 (orden desasignada entretanto) aborta cada sincronización antes del pull: el supervisor deja de recibir validaciones y rechazos | `motor.ts:410,436`, `sync/snapshot.ts:142-149`, `datos/aplicar-cambios.ts:292-320` | Tolerar `NO_ENCONTRADO` en el snapshot de hidratación y completarla (el `revocar` llega en el pull) | Corregido (f01ae99) |
| A3 | Alta | El backup deja de completarse con ~385k filas (800 operaciones × 500 filas por invocación, un solo cron diario) y el fallo es silencioso | `cron/presupuesto.ts:206`, `cron/backup.ts:44,52`, `wrangler.jsonc` | Crons de continuación horarios (`0 9-13 * * *`), página de 2000 filas medida, presupuestos separados D1/R2, log de error `backup_incompleto_del_dia`, enmienda de la ADR 0014 | Corregido (2bb5ef5) |
| M1 | Media | La retención de 7 días de las mutaciones `aplicada` es menor que el horizonte de Time Travel (30 días): una restauración a más de 7 días pierde datos propios en tablet y servidor; las fotos liberadas no se pueden volver a subir | `shared/dominio.ts:97`, `datos/outbox.ts:1057-1104`, `datos/entidades.ts:368` | Retención de 30 días (también de los bytes de fotos) y conservarlas al cerrar sesión; documentar en el runbook no restaurar más atrás de la retención y reconciliar evidencias contra R2 | Corregido en el cliente (f01ae99, 18d3141); runbook en la Fase 6 |
| M2 | Media | Tras restaurar desde el backup de R2 (no es una foto de un instante) pueden quedar consumos sin su `sync_mutations`/auditoría: el reenvío da `ID_DUPLICADO` → `rechazada` aunque el servidor tenga el dato | `cron/tablas.ts:99-114`, `dominio/consumos.ts:290-292` | Idempotencia por clave natural en el clasificador (mismo autor, orden, material y `client_created_at` → `aplicada`); `seq_final` en el manifest; verificaciones SQL tras restaurar en el runbook. **No** cambiar el orden de exportación | Idempotencia y seq_final corregidos (2bb5ef5); runbook en la Fase 6 |
| M3 | Media (negocio) | Un consumo registrado offline se rechaza si, antes de sincronizar, el jefe desasigna al supervisor o se desactiva el material | `dominio/consumos.ts:222-224,281-286` | Pregunta abierta P24 (supuesto: aceptar como registro tardío si la desasignación/desactivación es posterior a `client_created_at`) | Pregunta abierta P24 |
| M4 | Media | El cliente marca el snapshot como completo aunque agotó `MAX_PAGINAS_SNAPSHOT` | `motor.ts:451-476` | Si queda página, lanzar un error de red reintentable; nunca completar | Corregido (f01ae99) |
| M5 | Media-baja | Cada página del snapshot consulta todas las entidades restantes; validaciones de un supervisor con B-tree temporal (~22 ms por página) | `sync/snapshot.ts:158-160` | Consultar solo la entidad en curso; validaciones paginadas por `consumption_id` | Corregido (9fcd408) |
| B1 | Baja | `creacionRechazadaGuardada` recorre las `sync_mutations` del usuario | `sync/push.ts:303-315` | Índice por expresión parcial `sync_mutations_no_aplicadas_consumo` | Corregido (0006) |
| B2 | Baja | No se comprueba que se insertó la fila `aplicada` de `sync_mutations` | `dominio/plan.ts:182-187`, `sync/push.ts:210-234` | Comprobar `changes === 1` de la última sentencia y registrar error; prueba por tipo | Corregido (2bb5ef5) |
| B3 | Baja | El clasificador depende del texto de error de D1 (`SQLITE_CONSTRAINT`) | `dominio/errores-d1.ts:39` | Alternativa `/constraint failed/i`; prueba de humo en staging (pendiente humano) | Corregido (2bb5ef5); prueba de humo en staging en pendientes humanos |
| B4 | Baja | Una mutación que siempre da error transitorio se reintenta para siempre sin aviso | `sync/push.ts:395-397`, `motor.ts:391-394` | Con `intentos ≥ 10`, mostrarla como "atascada" en la UI; `tipo` en el log | Corregido (f01ae99, 18d3141) |
| B5 | Baja | Purga de `refresh_tokens`: segura (sin FK entrantes, sin trigger, tokens ya vencidos); hace `SCAN` | `cron/mantenimiento.ts:53-58` | Índice en `expira_at` y condición solo `expira_at < ?` | Corregido (0005) |
| B6 | Baja | El nombre de un co-supervisor no se actualiza en el cliente | `sync/entidades.ts:157-159` | Cosmético | Diferido |
| B7 | Baja | Ramas críticas sin prueba: contención agotada → transitorio; fila que no cabe en el cupo | `sync/push.ts:295`, `sync/pull.ts:199-200` | Pruebas | Corregido (2bb5ef5) |

## Verificado sin hallazgos

Idempotencia y concurrencia del push (respuesta perdida, peticiones iguales simultáneas, rechazo/aplicación concurrentes, autor = `sub`, dispositivo = `did`); clasificador; pull (ventana, visibilidad en JS, cursor = última fila revisada, deduplicación, planes con índices); snapshot (cursor antes del estado, token, escrituras entre páginas); revocación en el cliente (conserva lo propio, en cola, rechazos y fotos sin subir); límites de D1 (≤ 37 sentencias por mutación, ≤ 32 parámetros por sentencia); paginación y orden del backup; esquema sin otros índices necesarios.

## Estado de la revisión de la Fase 1

H1–H8, H10–H14 resueltos (con B3/B4 y A3/B5 como riesgos menores derivados); H9 parcial (orden de exportación hecho; falta `docs/despliegue.md` — Fase 6); H15 abierto (negocio, P20); H16 sin cambio.

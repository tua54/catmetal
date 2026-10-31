# Plan — Fase 3: Sincronización offline

Referencia: `docs/spec.md` §5 (login offline, tablet compartida) y §6 (protocolo), §10 (Fase 3). ADR que mandan: 0005 (cursor y reglas del pull), 0008 (autoría, `did` de la sesión), 0009 (época y contrato robusto de push), 0010 (guardas y cadena condicional). Revisión de esquema H2 (clasificador de errores).

**Criterio de cierre (§10):** pruebas de que una mutación repetida —también en concurrencia— no duplica; conflicto de versión; la edición de un consumo ya validado se rechaza; registro tardío en orden finalizada; tolerancia superada sin novedad → `requiere_novedad = 1`; un lote de 25 mutaciones no excede los límites de D1; el pull avanza el cursor aunque no haya cambios visibles; revocación de visibilidad. Revisión del esquema por `database-specialist` antes de cerrar.

## Servidor

### `POST /api/v1/sync/push`

1. Autenticado. Sobre `syncPushRequestSchema`; `user_id ≠ sub` → 403 `AUTOR_NO_COINCIDE` sin procesar nada. El dispositivo es el `did` de la sesión.
2. Mutaciones **en orden**. Para cada una (`indice`):
   - `leerMutationId`; si no se puede leer → resultado `rechazada` `VALIDACION` por `indice`, sin guardar.
   - `sync_mutations` existente: del mismo usuario → devuelve la respuesta guardada; de otro usuario → `rechazada` `ID_DUPLICADO`, sin revelar la respuesta.
   - `mutacionSchema.safeParse`; inválida → `rechazada` `VALIDACION`, guardada con `payload_json`.
   - Dependencias: si la entidad de la que depende (consumo de una novedad, consumo que se edita) fue rechazada en este lote o tiene una mutación de creación rechazada guardada → `rechazada` `DEPENDENCIA_RECHAZADA`.
   - Despacho al **mismo comando de dominio** de la Fase 2 (`registrarConsumo`, `editarConsumo`, `registrarNovedad`, `aprobarConsumo`, `rechazarConsumo`) → `PlanDeEscritura`; se añade al final del batch el `INSERT INTO sync_mutations … 'aplicada'` **condicionado** a la sentencia principal (`WHERE EXISTS`). `db.batch()`.
   - Resultado: `aplicada` (con la entidad resultante en `servidor`), `rechazada` (código + mensaje en español), `conflicto` (versión del servidor en `servidor`). `rechazada` y `conflicto` se guardan en un batch propio con `payload_json`.
   - **Clasificador de errores** (revisión H2): `ErrorApi` de negocio → `rechazada`/`conflicto`; error de D1 con `SQLITE_CONSTRAINT` o texto de un `RAISE` → `rechazada`/`conflicto` (nunca transitorio); conflicto de PK en `sync_mutations` (reintento concurrente) → se relee y se devuelve la respuesta guardada; solo errores de red/sobrecarga de D1 o `ERROR_INTERNO` desconocido → **transitorio**: se detiene el lote y las siguientes quedan sin resultado (siguen pendientes).
3. `server_received_at` = ahora; `client_created_at` del payload; `alerta_reloj` en la auditoría si difieren > 10 min.
4. Actualiza `devices.ultimo_sync_at`.
5. Límite: 25 mutaciones × (lecturas + 1 batch) ≤ 1000 consultas por invocación; ninguna sentencia con > 100 parámetros. Prueba que cuenta las consultas.

### `GET /api/v1/sync/pull?cursor=`

Reglas exactas de la ADR 0005 (ventana de 1000 filas por `seq`, visibilidad con el estado actual aplicada en JS, deduplicación, cupo de 200, cursor = último `seq` revisado, `hay_mas`, estado actual por `json_each`, eventos `hidratar`/`revocar`/`reiniciar`, `epoca`). Usa `audit_log.order_id` (ADR 0010) para la visibilidad por orden.

### `GET /api/v1/sync/snapshot?alcance=inicial|orden&order_id=&pagina=`

Estado actual de lo visible para el usuario (materiales, settings, órdenes visibles con plan y asignaciones, consumos visibles, novedades, evidencias (metadatos), validaciones), paginado. La primera página devuelve `cursor = MAX(seq)` leído **antes** del estado en el mismo batch (ADR 0005 regla 7) y `epoca`.

## Cliente (`apps/web/src/datos`, `apps/web/src/sync`, `apps/web/src/auth`)

- **Dexie** (`catmetal-mp`), todo particionado por `user_id` (índices compuestos `[user_id+…]`): `outbox`, `consumos`, `novedades`, `evidencias` (blob comprimido + metadatos + estado de subida), `ordenes`, `planeados`, `asignaciones`, `materiales`, `validaciones`, `settings`, `meta` (cursor, época, último sync), `perfiles` (perfil, permisos y verificador local), `trazabilidad` (eventos de este dispositivo), `instalacion` (id por navegador).
- **Outbox**: `{ mutation_id, user_id, tipo, entidad_id, payload, client_created_at, intentos, estado, error, siguiente_intento_at, aplicada_at }`. Cada acción escribe en una transacción de Dexie la entidad local (estado "pendiente de sync") **y** la mutación. Las `aplicada` se conservan 7 días; las `rechazada` nunca se borran.
- **Motor de sync**: disparadores (evento `online`, apertura, cada 60 s si hay pendientes, botón "Sincronizar ahora", Background Sync donde exista); candado con Web Locks (`navigator.locks`) y alternativa (candado en IndexedDB con expiración); envío **en orden** en lotes ≤ 25 **solo del usuario de la sesión** (compara `sub` del token con la partición; nunca envía las de otro usuario); backoff exponencial con jitter, máximo 5 min; una `rechazada`/`conflicto` no bloquea a las siguientes salvo dependencia; aplica `servidor` a las tablas locales; luego pull en bucle mientras `hay_mas`, atendiendo `hidratar` (snapshot de la orden), `revocar` (borra datos locales de la orden salvo pendientes propios), `reiniciar` y cambio de `epoca` (snapshot completo y reenvío de las aplicadas conservadas).
- **Evidencias**: subida en segundo plano con `PUT /evidences/:id` solo después de que la mutación de su novedad quedó `aplicada`; `EVIDENCIA_DESCONOCIDA` → reintento posterior; compresión previa con `browser-image-compression` a JPEG/WebP (P21).
- **Auth cliente**: access token solo en memoria; refresh serializado con Web Locks; al recargar, refresh para obtener el access token; login offline con verificador local (ADR 0012); tablet compartida (aviso "Hay N registros pendientes de <A>", cerrar sesión borra datos locales solo sin pendientes).
- `navigator.storage.persist()` al iniciar; si no se concede, aviso permanente "Sincroniza al menos una vez al día".
- Estado de UI: indicador global ("En línea · Todo sincronizado" / "Sin conexión · N por sincronizar" / "Sincronizando…").

## Tareas

| Id | Tarea | Responsable | Archivos | Depende | Aceptación |
|---|---|---|---|---|---|
| 3.1 | `POST /sync/push` con clasificador de errores e idempotencia en el batch | `general-purpose` | `apps/worker/src/sync/push.ts`, `src/rutas/sync.ts`, `app.ts`, pruebas | Fase 2 | Repetida y concurrente no duplica; conflicto; editar validado → rechazada; tardío; tolerancia; 25 mutaciones dentro de límites; dependencia rechazada; autor distinto 403 |
| 3.2 | `GET /sync/pull` y `GET /sync/snapshot` | `general-purpose` | `src/sync/{pull,snapshot,visibilidad}.ts`, `src/rutas/sync.ts`, pruebas | 3.1 | Cursor avanza sin cambios visibles; revocación; hidratación; época; cupo y `hay_mas` |
| 3.3 | Capa de datos local (Dexie) particionada y outbox | `react-developer` | `apps/web/src/datos/**`, pruebas con `fake-indexeddb` | Fase 2 (contrato) | Partición por usuario; transacción entidad + mutación |
| 3.4 | Cliente de auth (memoria, refresh con candado, verificador offline) | `react-developer` | `apps/web/src/auth/**` | 3.3 | Login offline solo tras login online; verificador nunca se envía |
| 3.5 | Motor de sync y subida de evidencias | `react-developer` | `apps/web/src/sync/**` | 3.3, 3.4 | Orden, lotes, candado, backoff, partición, dependencias, evidencias después de aplicada |
| 3.6 | Revisión del esquema y del protocolo | `database-specialist` | `docs/auditoria/revision-esquema-fase-3.md` | 3.1–3.2 | Hallazgos corregidos o justificados |
| 3.7 | ADR 0012 (verificador local y almacenamiento del cliente) | orquestador | `docs/adr/` | — | — |

Paralelismo: servidor (3.1→3.2, `general-purpose`) ∥ cliente (3.3→3.4→3.5, `react-developer`). Contrato común: `packages/shared`.

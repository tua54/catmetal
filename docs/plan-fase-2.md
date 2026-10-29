# Plan — Fase 2: API de negocio

Referencia: `docs/spec.md` §1 (supuestos S2–S12), §3 (permisos), §6 (reglas de conflicto), §7 (API) y §10 (Fase 2). ADR aplicables: 0005, 0006, 0008, 0009.

**Criterio de cierre (§10):** pruebas de integración por endpoint y por permiso; un fallo a mitad del batch no deja datos parciales; evidencias con mime falso se rechazan; el CSV neutraliza fórmulas; revisión de seguridad (`docs/auditoria/seguridad-fase-2.md`); `pnpm audit --prod` sin high/critical sin justificar.

## Arquitectura: comandos de dominio reutilizables por REST y por sync

Toda escritura de negocio es un **comando de dominio** en `apps/worker/src/dominio/` con esta forma:

```ts
type Contexto = { db: Db; actor: { id; rol }; deviceId: string; ahora: string /* ahoraIso() */; clientAt?: string };
type PlanDeEscritura<R> = { sentencias: BatchItem[]; respuesta: R };
async function registrarConsumo(ctx: Contexto, entrada: CrearConsumo): Promise<PlanDeEscritura<Consumo>>; // lanza ErrorApi
```

- El comando **lee y valida** (permisos de datos, reglas de negocio) y devuelve las sentencias a ejecutar (cambio de negocio + filas de `audit_log`), **sin ejecutarlas**.
- La ruta REST ejecuta `db.batch(plan.sentencias)`. El motor de `/sync/push` (Fase 3) ejecuta `db.batch([...plan.sentencias, insertSyncMutation])`: así la idempotencia queda en el mismo batch (ADR 0009) sin duplicar lógica.
- Una colisión de PK en un id generado por el cliente se traduce a `ID_DUPLICADO` (409) / `conflicto` en sync, nunca a sobrescritura.
- **Sentencias con guarda** (ADR 0010, revisión H2): toda sentencia de negocio lleva en su `WHERE` las condiciones leídas (estado, versión, autor, acumulado). Así una carrera da `changes = 0` (→ 409 `CONFLICTO` o reintento), no un error de trigger; los triggers son la última línea de defensa.
- **Cadena condicional**: todo lo que sigue a la sentencia principal en el batch (auditoría y, en sync, la fila de `sync_mutations` como `aplicada`) se escribe con `INSERT … SELECT … WHERE EXISTS (<la sentencia principal aplicó>)`. El comando devuelve también cómo comprobar el resultado (índice de la sentencia principal y `changes` esperado).
- Toda fila de auditoría de una entidad que pertenece a una orden lleva `order_id` (ADR 0010).

## Reglas de negocio (interpretación de la spec; supuestos en `preguntas-abiertas.md`)

- **Registro de consumo**: supervisor solo en órdenes asignadas activas; jefe en cualquiera; admin nunca. Orden `planeada` → `ORDEN_NO_EN_PROCESO`; `finalizada`/`cancelada` → se acepta con `registro_tardio = 1`. Material inactivo → `MATERIAL_INACTIVO`.
- **Unidades (S11)**: la unidad del consumo debe ser convertible a la del material (`UNIDAD_INCOMPATIBLE` si no). `cantidad_en_unidad_plan` = cantidad convertida a la unidad del plan de ese material en la orden; si el material no está en el plan (P10), a la unidad del material y `requiere_novedad = 1`.
- **Costo (S12)**: `costo_unitario_cop_snapshot` = costo vigente del material (por unidad del material) al registrar. Costo del consumo = cantidad convertida a la unidad del material × snapshot, redondeado a pesos.
- **Tolerancia (S7, servidor autoridad)**: acumulado = Σ `cantidad_en_unidad_plan` de los consumos **no rechazados** del material en la orden, incluido el nuevo. Si `excedeTolerancia(planeada, acumulado, tolerancia_pct)` → `requiere_novedad = 1` (se acepta igual). El consumo "falta novedad" = `requiere_novedad = 1` sin filas en `incidents`. **Sin carreras** (revisión H4): el INSERT va condicionado a que el acumulado y el estado de la orden sigan siendo los leídos (`INSERT … SELECT … FROM production_orders o WHERE o.id = ? AND o.estado = ? AND (SELECT total(...)) = ?`); si `changes = 0`, se relee y se reintenta (máx. 3). La fórmula sigue siendo solo `excedeTolerancia` de shared.
- **Edición (S4)**: solo el autor, rol supervisor (P3), estado `pendiente`, `version` igual a la del servidor (si no → 409 `CONFLICTO` con la versión del servidor en `details`). Recalcula conversión, snapshot (si cambia el material) y `requiere_novedad`. Auditoría con antes/después.
- **Corrección (S3)**: `corrige_a` solo hacia un consumo `rechazado` del mismo autor (o jefe), misma orden; una sola corrección por rechazado.
- **Novedad**: la registra el autor del consumo o un jefe; tipo, descripción y metadatos de hasta 5 evidencias (`evidences` con `subido = 0`, `storage_key = evidencias/<order_id>/<evidence_id>`) en el mismo batch.
- **Evidencia** (`PUT /evidences/:id`): solo quien registró la novedad; cuerpo binario ≤ 5 MB; tipo por **magic bytes** (JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF....WEBP`), debe coincidir con el `mime` declarado; sha256 calculado debe coincidir con el declarado; escribe en R2 y luego marca `subido = 1` + auditoría. Si ya está subida con el mismo sha256 → 200 idempotente; distinto → `EVIDENCIA_YA_SUBIDA`. Evidencia desconocida → 404 `EVIDENCIA_DESCONOCIDA`. `GET /evidences/:id`: permiso de lectura del consumo; streaming desde R2 con `Content-Type` fijo (el guardado), `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Cache-Control: private, no-store`.
- **Validación**: jefe; nunca un consumo propio (`AUTOAPROBACION`, aunque sea el único jefe — P1); solo `pendiente` (`CONSUMO_NO_PENDIENTE`); aprobar con `requiere_novedad = 1` sin novedad → `REQUIERE_NOVEDAD`; rechazar exige motivo. El cuerpo lleva la `version` del consumo que vio el jefe. Batch: `INSERT INTO validations … SELECT … WHERE EXISTS (consumo pendiente con esa versión)` → la base aplica estado y `version + 1` (trigger `validations_aplica_decision`, ADR 0010; el Worker **no** hace UPDATE) → auditoría de la validación y del consumo, condicionadas. Si no aplicó → 409 `CONFLICTO` con la versión actual.
- **Órdenes**: crear (jefe/admin) con materiales planeados (unidad del plan convertible a la del material); `start` planeada → en_proceso; `finish` en_proceso → finalizada, con pendientes → `ORDEN_CON_PENDIENTES` salvo `force: true` (auditado con `force` y el número de pendientes). No se expone cancelar (P16).
- **Asignaciones** (`PUT /orders/:id/supervisors`, admin): reemplaza la lista: los quitados quedan `activo = 0`, los nuevos o reactivados `activo = 1`; una fila de auditoría por asignación cambiada (la usa el pull para hidratar/revocar). Solo usuarios con rol supervisor y activos.
- **Lectura**: supervisor ve órdenes asignadas activas y sus propios consumos aunque haya perdido la asignación (ADR 0005 regla 2); jefe y admin ven todo. Paginación por cursor sobre el id UUID v7 (ordenable por tiempo), nunca `OFFSET`.
- **Auditoría**: `GET /audit` (jefe/admin todo; supervisor solo filas donde es actor); `GET /orders/:id/audit` = línea de tiempo de la orden (orden, asignaciones, consumos, novedades, evidencias, validaciones) con nombre y rol del actor.
- **Reportes**: `summary` por material planeado (planeado, consumido no rechazado, % y costo), costo total en COP con costos congelados, novedades abiertas (consumos pendientes con novedad o que la requieren) y estado. CSV: UTF-8 con BOM, separador `;`, CRLF, celdas que empiezan con `=`, `+`, `-`, `@`, tabulador o retorno de carro se prefijan con `'`; números con coma decimal.

## Tareas

| Id | Tarea | Responsable | Archivos | Depende | Aceptación |
|---|---|---|---|---|---|
| 2.1 | Infraestructura de comandos (`Contexto`, `PlanDeEscritura`, visibilidad), materiales, settings/tolerancia, órdenes (listar, detalle con plan vs consumo, crear, iniciar, finalizar) y asignaciones; registro de todas las rutas de la fase en `app.ts` | `general-purpose` | `apps/worker/src/dominio/{contexto,visibilidad,materiales,ordenes,asignaciones,settings}.ts`, `src/rutas/{materiales,ordenes,settings}.ts`, `src/app.ts`, pruebas | Fase 1 | Pruebas por endpoint y permiso |
| 2.2 | Consumos (crear, editar, listar por orden), novedades y evidencias en R2 | `general-purpose` | `src/dominio/{consumos,novedades,evidencias}.ts`, `src/rutas/{consumos,evidencias}.ts`, pruebas | 2.1 | Conversión, costo congelado, tolerancia, registro tardío, conflicto de versión, mime falso rechazado |
| 2.3 | Validaciones (cola con filtros y cursor, aprobar, rechazar) | `general-purpose` | `src/dominio/validaciones.ts`, `src/rutas/validaciones.ts`, pruebas | 2.2 | Sin autoaprobación, sin aprobar con `requiere_novedad` |
| 2.4 | Auditoría (`/audit`, `/orders/:id/audit`) y reportes (summary, CSV) | `general-purpose` | `src/dominio/{auditoria-consulta,reportes}.ts`, `src/rutas/{auditoria,reportes}.ts`, pruebas | 2.1 | CSV neutraliza fórmulas, BOM y `;` |
| 2.5 | Pruebas transversales: matriz endpoint × rol, fallo a mitad de batch sin datos parciales, auditoría en el mismo batch para cada escritura | `test-engineer` | `apps/worker/test/fase2-*.test.ts` | 2.1–2.4 | Matriz completa |
| 2.6 | Revisión de seguridad | `security-reviewer` | `docs/auditoria/seguridad-fase-2.md` (lo guarda el orquestador) | 2.1–2.5 | Altos/críticos corregidos o en ADR |
| 2.7 | `pnpm audit --prod`, evidencia y cierre | orquestador | `docs/evidencia/fase-2.md` | todo | — |

Paralelismo: 2.2 ∥ 2.4 después de 2.1 (archivos disjuntos; 2.1 deja registradas todas las rutas en `app.ts`).

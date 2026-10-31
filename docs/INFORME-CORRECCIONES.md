# Informe de la sesión de correcciones v1.1

- Fecha: 2026-10-30.
- Rama: `fix/auditoria-v1`, creada desde `build/v1`. **Sin push.** Tag local: `correcciones-v1.1`.
- Alcance: `docs/correcciones-v1.1.md`. Plan: `docs/plan-correcciones.md`.

## 1. Resumen

Se corrigieron **todos** los ítems de la auditoría externa: **2 de P0, 7 de P1 y 12 de P2**. Ninguno quedó sin resolver. Además, se encontraron y corrigieron **3 defectos nuevos** (N1–N3), y las revisiones de esquema y de seguridad de esta sesión dejaron **13 correcciones adicionales** (R-01 a R-05, R-10, S-02, S-03, S-05, S-06, S-09, S-10 y S-12).

- Cada ítem de código tiene una prueba de regresión que falló con el código anterior. La salida del fallo está en el cuerpo de su commit.
- Cada commit se verificó en un worktree limpio con HEAD más solo los archivos de ese commit.
- Gates finales: **2.252 pruebas** sin fallos (worker 98,35 % de líneas, shared 100 %), **35 E2E**, `pnpm audit --prod` sin vulnerabilidades y Lighthouse en 100.
- Hay **10 ADR nuevas** (0018–0027) y **2 migraciones** (0007 y 0008).

**Incidente al arrancar:** el hook `guardia.mjs` trataba a la sesión principal como un subagente, porque la máquina tenía `"agent": "orchestrator"` y Claude Code manda `agent_type` también en la sesión principal. Por eso bloqueaba `git switch`, `add` y `commit`. No se rodeó. El equipo corrigió el hook para usar solo `agent_id` y la sesión siguió. Está anotado en `docs/notas-plataforma.md`.

**Subagentes usados:**

| Subagente | Trabajo |
|---|---|
| `general-purpose` (backend) | M1, M2-servidor, M3/M4, B1/B6, B3/B11/B12, B4, B5-servidor, R-01 a R-05, S-02/S-05/S-06 |
| `react-developer` | Diseño e implementación de M5/M6, M7 y M2-cliente, y B3/B5/B9/B10, S-03 y S-09 del cliente |
| `software-architect` | Segunda opinión de las ADR 0018 (M1), 0020 y 0021 (M3/M4) |
| `database-specialist` | Revisión de esquema de M3, M4 y B7 |
| `security-reviewer` | Revisión de M1, B1, B3, B4, B5, M2 y M5/M6, más el seguimiento de M7 |
| Orquestador | C1, C2/N1, N2, N3, B2, B7, B8; todos los commits, ADR y documentos |

Un `react-developer` (M7/M2-cliente) se quedó esperando un comando en segundo plano. El orquestador corrió los gates y la E2E y confirmó su trabajo.

## 2. Tabla de ítems

| Id | Prio. | Estado | Commit | Prueba de regresión (archivo › prueba) | ADR |
|---|---|---|---|---|---|
| C1 | P0 | Resuelto | `5e5cdcf` | Prueba del hook por stdin (`docs/evidencia/correcciones.md`): un push sale con exit 2 | — |
| C2 | P0 | Resuelto | `e06919d` | `apps/web/src/lib/blob.test.ts` › «devuelve los bytes aunque el Blob no tenga arrayBuffer() ni stream()» | — |
| M1 | P1 | Resuelto | `e8e5a27` (+ `53487c8`) | `apps/worker/test/correcciones-m1-login-cupos.test.ts` › «tras 50 fallos desde orígenes desconocidos, el usuario legítimo entra desde su dispositivo conocido»; `correcciones-m1-dispositivo.test.ts`; `correcciones-m1-seguridad.test.ts` | 0018 |
| M2 | P1 | Resuelto | `d498af3` (servidor), `ea2b5df` (cliente) | `apps/worker/test/correcciones-m2-alerta-reloj.test.ts` › «registrado offline hace 3 h y enviado con el reloj correcto → 0»; `apps/web/src/sync/motor.test.ts` › «cada push lleva enviado_at…»; `e2e/registro-offline.spec.ts` | 0019 |
| M3 | P1 | Resuelto | `88c6afb` (+ `b89f69f`, R-03) | `apps/worker/test/fase6-cron-bytes.test.ts`, `fase6-cron-aislamiento.test.ts` y `fase3-push-recorte.test.ts` | 0020 |
| M4 | P1 | Resuelto | `88c6afb` (+ `b89f69f`, R-01/02/04/05/10) | `apps/worker/test/fase6-restauracion.test.ts` (aprobación del jefe entre dos tablas; V1 a V10 sin filas) | 0021 |
| M5 | P1 | Resuelto | `bf91c2f` | `apps/web/src/sync/motor.test.ts` › «M5: la red se cae a mitad del snapshot tras una restauración…»; `apps/web/src/datos/snapshot-temporal.test.ts` | 0022 |
| M6 | P1 | Resuelto | `bf91c2f` | `motor.test.ts` › «M6: tras una restauración, el consumo propio aprobado vuelve a pendiente…»; `apps/web/src/datos/outbox.test.ts` › «M6: un conflicto adopta la copia del servidor…» | 0022 |
| M7 | P1 | Resuelto | `ea2b5df` | `apps/web/src/auth/sesion-pestanas.test.ts`; `motor-seguridad.test.ts` › «si la identidad cambia entre armar el lote y enviarlo…»; `e2e/sesion-multipestana.spec.ts` | 0023 |
| B1 | P2 | Resuelto | `f5d4454` | `apps/worker/test/correcciones-b1-vida-familia.test.ts` › «las rotaciones no extienden la familia…» | — |
| B2 | P2 | Resuelto | `51f7956` | Documental: D10 en `docs/desviaciones.md` | 0008, punto 3 |
| B3 | P2 | Resuelto | `f8b5c1b` (servidor), `cc367e4` (cliente) | `apps/worker/test/correcciones-b3-colision-pk.test.ts`; `apps/web/src/sync/correcciones-b3-colision-pk.test.ts` | — |
| B4 | P2 | Resuelto | `ea0f97d` | `apps/worker/test/correcciones-b4-evidencias-concurrencia.test.ts` › «la que falla al confirmar no borra el objeto que otra confirma después» | 0024 |
| B5 | P2 | Resuelto | `2a81cf2` (servidor), `68dc60d` (cliente) | `apps/worker/test/correcciones-b5-version-cliente.test.ts`; `apps/web/src/sync/correcciones-b5-version-cliente.test.ts`; `apps/web/src/pwa/correcciones-b5-actualizacion.test.tsx` | 0026 |
| B6 | P2 | Resuelto | `51a3ed3` | `apps/worker/test/correcciones-b6-rehash.test.ts` › «un hash de 10.000 iteraciones se acepta y queda recalculado a 100.000…» | 0007 (enmienda) |
| B7 | P2 | Resuelto | `231ad15` | `apps/worker/test/correcciones-b7-settings-insert.test.ts`; `integridad-esquema.test.ts` (lista de `sqlite_master`) | — |
| B8 | P2 | Resuelto | `8f24550` | `apps/worker/test/correcciones-b8-workflow-despliegue.test.ts` | — |
| B9 | P2 | Resuelto | `8045d1f` | `apps/web/src/datos/correcciones-b9-fotos-bloqueadas.test.ts`; `components/layout/correcciones-b9-cierre.test.tsx` | — |
| B10 | P2 | Resuelto | `79f0999` | `apps/web/src/auth/correcciones-b10-candado.test.ts` (con reloj simulado) | — |
| B11 | P2 | Resuelto | `69eb496` | `apps/worker/test/correcciones-b11-validaciones.test.ts` | — |
| B12 | P2 | Resuelto | `65e4732` | `apps/worker/test/correcciones-b12-presupuesto-push.test.ts` | 0025 |

Notas:

- M3/M4, M5/M6 y M7/M2-cliente van en commits compartidos porque cambian los mismos fragmentos de código. Se explica en cada commit.
- Los hashes de estado de cada ítem están en `docs/correcciones-v1.1.md`.

## 3. Ítems nuevos

| Id | Prio. | Descripción | Estado | Commit |
|---|---|---|---|---|
| N1 | P1 | En jsdom, `new Response(blob)` devuelve el texto `"[object Blob]"`. La aserción «sin EXIF» de la prueba de fotos pasaba siempre, y la alternativa de `leerBytes` del código tenía el mismo defecto. | Resuelto | `e06919d` |
| N2 | P2 | Un `INSERT … ON CONFLICT DO NOTHING` avanza `sqlite_sequence` aunque no inserte nada. El seed lo usaba en `audit_log`, así que volver a correrlo dejaba la base sin poder auditar: el trigger `audit_log_seq_sin_saltos` rechazaba toda escritura. Una prueba estática lo impide ahora en `src/`, `migrations/` y `scripts/`. | Resuelto | `25c254a` |
| N3 | P2 | `?entidad=login_cupos` respondía 400 en `/audit`. | Resuelto | `41ae133` |

## 4. Cambios de contrato entre cliente y servidor

| Cambio | Dirección | Compatibilidad con clientes viejos (v1.0) |
|---|---|---|
| `enviado_at` en el cuerpo de `/sync/push` (M2) | cliente → servidor, opcional | El esquema no es estricto. Sin `enviado_at`, `alerta_reloj = 0`. Un formato inválido se ignora sin rechazar. |
| Header `X-Hora-Dispositivo` en las escrituras REST (M2) | cliente → servidor, opcional | Si falta o no es válido, la alerta es 0. |
| Header `X-Version-Cliente` y 426 `CLIENTE_DESACTUALIZADO` con `details.version_minima` (B5) | en las dos direcciones | Si falta, cuenta como versión 1. `VERSION_MINIMA_CLIENTE = "1"` en los tres entornos, así que **nadie se bloquea**. No subirla a 2 hasta que todas las tablets corran la v1.1 (`docs/despliegue.md` §6). |
| Colisión de PK con una fila ajena → `conflicto` + `ID_DUPLICADO`, **sin** `servidor` (B3) | servidor → cliente | El cliente v1.0 recibe `conflicto` donde antes recibía `rechazada`. Revisar con el cliente v1.0 en staging que tolera un `conflicto` sin `servidor`; el v1.1 sí lo maneja. El REST no cambia (409 sin datos de la fila). |
| Corte del push por presupuesto de consultas (B12) | servidor → cliente | Las mutaciones cortadas quedan sin resultado, igual que un error transitorio de la v1.0, y el cliente las reenvía. |
| Cookie nueva `mp_dispositivo` en `/api/v1/auth` (M1) | servidor → navegador | Es nueva. Si falta, el login cuenta como de origen desconocido. |
| `payload_json` de las no aplicadas recortado por encima de 16 KiB (M3) | interno | Sin efecto en el cliente: la mutación sigue en su outbox. |
| Vida máxima de la familia de refresh: 30 días desde el login (B1) | servidor → cliente | Las familias con más de 30 días piden la contraseña una vez al desplegar (aviso en `docs/despliegue.md` §6). |

## 5. Migraciones nuevas y su efecto sobre bases existentes

| Migración | Contenido | Efecto en staging o producción |
|---|---|---|
| `0007_login_cupos.sql` (generada por drizzle-kit) | `CREATE TABLE login_cupos` e índice `login_cupos_updated_at` | Solo agrega una tabla técnica; no toca datos. Los bloqueos heredados en `users.bloqueado_hasta` dejan de bloquear y se limpian en el siguiente login correcto. |
| `0008_settings_insert_validos.sql` (escrita a mano) | Trigger nuevo `settings_insercion_valida` (BEFORE INSERT) y `settings_valores_validos` recreado con el tope de 100 | Solo endurece. No revisa las filas existentes: la API ya acotaba a 100 (R-08). Una migración futura que agregue una clave a `settings` debe recrear antes este trigger (R-07). |

No se reconstruyó ninguna tabla. Ningún trigger de inmutabilidad se debilitó y no se agregó ningún `DELETE` sobre tablas de negocio: los únicos son las purgas de las tablas técnicas `refresh_tokens` y `login_cupos`. En el cliente, Dexie v3 (M5) solo agrega `snapshot_entidades` y `snapshot_progreso`, sin `upgrade()`.

## 6. Gates finales (números reales)

Sobre `421cf9f`, con el árbol limpio. El detalle está en `docs/evidencia/correcciones.md`.

| Gate | Resultado |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | exit 0 / exit 0 / exit 0 |
| `pnpm test` | 2.252 pasadas, 0 fallidas: shared 265 (líneas 100 %), web 618, worker 1.369 (líneas 98,35 %; umbral 80 %) |
| `pnpm test:e2e` | 35 pasadas, 0 fallidas (1,8 min) |
| `pnpm audit --prod` | Sin vulnerabilidades conocidas |
| `pnpm test:lighthouse` | 100 en Performance, Accessibility y Best Practices en todas las URLs (umbral 90) |

## 7. Hallazgos de las revisiones de esta sesión

**Segundas opiniones de `software-architect`:**

- ADR 0018: aprobar con cambios.
- ADR 0020 y 0021: aprobar con cambios.

Todos los cambios se incorporaron antes de implementar.

**Revisión de esquema** (`docs/auditoria/revision-esquema-correcciones.md`, `database-specialist`): aprobado con cambios.

| Hallazgo | Estado |
|---|---|
| R-01 (alto): la restauración no escalaba por el límite de strings de Node | Resuelto en `b89f69f` |
| R-02, R-03 (medios), R-04, R-05 (bajos), R-10 | Resueltos en `b89f69f` |
| R-06, R-07 | Documentados |
| R-08, R-09 | Aceptados |

**Revisión de seguridad** (`docs/auditoria/seguridad-correcciones.md`, `security-reviewer`, con seguimiento de M7): 0 críticos, 0 altos y 0 medios.

| Hallazgo | Estado |
|---|---|
| S-02, S-05, S-06 | Resueltos en `53487c8` |
| S-03 y S-09 | Resueltos en `2c29a5d` y `d14566f` (ADR 0027) |
| S-10 | Resuelto (texto de la ADR 0023) |
| S-12 | Resuelto en `68dc60d` |
| S-04 y S-07 | Documentados en el runbook |
| S-01 | **Aceptado como riesgo residual**: se mantiene "todo bloqueo se audita" (spec §5 d), con el volumen acotado por el tope global. Lo fija una prueba. |
| S-11 | Aceptado |
| S-08 | Anterior a la v1.1; queda como pendiente humano |

No quedan hallazgos altos ni críticos abiertos.

## 8. Pendientes humanos actualizados

Lista completa en `docs/pendientes-humanos.md`. Lo principal:

1. **Push**, cuando el equipo apruebe: `git push -u origin main build/v1 fix/auditoria-v1 --follow-tags`. Incluye los tags `fase-0` a `fase-6` y `correcciones-v1.1`.
2. **Ensayo en staging de la D1 remota** (M3/M4): `octet_length`, el límite de 100 KB por sentencia, el tope de 5 términos por `UNION ALL`, la atomicidad de `wrangler d1 execute --file`, `pragma_foreign_key_check` y si `--file` devuelve filas.
3. **Tablet real**: la duración del reemplazo del snapshot para un jefe (M5) y el login offline (ADR 0012).
4. **Compatibilidad de B3** con el cliente v1.0: un `conflicto` sin `servidor`.
5. **Seguridad**: S-08 (`mp_refresh` frente a subdominios hermanos), una alerta por crecimiento de `audit_log` (S-01) y un rate limit para `/sync/push`.
6. **Antes de subir `VERSION_MINIMA_CLIENTE`**: confirmar que todas las tablets corren la v1.1.
7. Los pendientes de despliegue de la v1 siguen igual: recursos, secretos, migraciones remotas, primer admin, MDM y Cloudflare Access.
8. Las preguntas abiertas nuevas son P25 (segundo factor), P26 (rechazos tras el corte de un backup) y P27 (supuestos de la restauración).

## 9. Mapa de commits

`git log --oneline build/v1..fix/auditoria-v1`, antes del commit de este informe (56 commits):

```
421cf9f docs(correcciones): marcar b3, b5, b9 y b10, y el estado de los hallazgos de seguridad
d14566f fix(seguridad): bloquear la app y exigir login en línea tras una revocación
2c29a5d fix(seguridad): purgar los datos ajenos de la tablet al perder visibilidad
f1f7370 docs(adr): registrar el bloqueo de la app tras una revocación del servidor
68dc60d feat(pwa): enviar la versión del cliente y actualizarse ante un 426
79f0999 fix(sync): renovar el candado alternativo mientras dura la sync
8045d1f fix(datos): no borrar fotos bloqueadas al cerrar sesión ni por retención
cc367e4 fix(sync): mostrar como conflicto la colisión de clave primaria
d4b6d21 docs(auditoria): agregar el seguimiento de seguridad de m7
9e63e0a docs(evidencia): registrar los gates de cierre de p1
7a45d67 docs(correcciones): marcar m2 y m7; p1 completo
ea2b5df fix(web): propagar la sesión entre pestañas y enviar la hora del dispositivo
53487c8 fix(seguridad): contar los fallos del dispositivo en el tope global y sacar los cupos del backup
109d25d docs(adr): enmendar la adr 0018 tras la revisión de seguridad
5ad5b39 docs(auditoria): guardar la revisión de seguridad de las correcciones v1.1
fc8310b docs(correcciones): marcar n3 y b5 parcial
41ae133 fix(shared): aceptar login_cupos en el filtro de entidades de auditoría
f244a02 docs(auditoria): registrar el estado de los hallazgos de la revisión de esquema
b89f69f fix(infra): restaurar en streaming y endurecer la verificación del backup
2a81cf2 feat(api): rechazar con 426 cliente_desactualizado a clientes viejos
8a010e6 docs(progreso): avance de p2 y revisión de esquema
d48b588 docs(adr): registrar la versión mínima del cliente
5bcfbc0 docs(auditoria): guardar la revisión de esquema de m3, m4 y b7; marcar b3, b11 y b12
69eb496 fix(api): verificar aprobar y rechazar sin depender de meta.changes de d1
65e4732 fix(sync): cortar el lote del push antes del límite de consultas de d1
a7696fc docs(adr): registrar el presupuesto de consultas del push
f8b5c1b fix(sync): responder conflicto ante una colisión de clave primaria ajena
95c9014 docs(correcciones): marcar b4
ea0f97d fix(seguridad): no borrar de r2 una evidencia que otra subida confirmó
c92dce3 docs(adr): registrar que el worker nunca borra objetos de evidencia
96d7855 docs(correcciones): marcar b7 y b8
8f24550 ci: restringir el despliegue de staging a main dentro del workflow
231ad15 fix(db): validar también los insert de settings con un trigger nuevo
3b3a11f docs(correcciones): marcar m3, m4, b1 y b6; supuestos y pendientes de la restauración
51a3ed3 fix(auth): recalcular a 100.000 iteraciones los hashes débiles al iniciar sesión
f5d4454 fix(auth): limitar la familia de refresh a 30 días desde el login
88c6afb fix(infra): acotar el backup por bytes y hacerlo consistente entre tablas
51f7956 docs(desviaciones): documentar la ventana de gracia de la rotación del refresh
06e98c2 docs(correcciones): marcar m5 y m6, y m2 parcial
bf91c2f fix(sync): bajar el snapshot a un área temporal y dar la autoridad al servidor
d498af3 fix(api): calcular alerta_reloj con la hora del dispositivo al enviar
8019eec docs(progreso): m1 y n2 resueltos; ola 2 en curso
25c254a fix(db): no usar on conflict en la auditoría del seed
3a94108 docs(correcciones): marcar m1 y registrar n2 y n3
e8e5a27 fix(auth): reemplazar el bloqueo duro por cupos por dispositivo conocido y origen
7907ff8 docs(adr): registrar backup consistente entre tablas con corte y reconciliación
d7d1a1d docs(adr): registrar backup acotado por bytes y aislamiento de tablas fallidas
82b88ca docs(adr): registrar snapshot en área temporal y autoridad del servidor
0aec456 docs(progreso): avance de p0 y arranque de la ola 1 de p1
224fd8a docs: registrar la desviación de la primera capa y la pregunta del segundo factor
867ba37 docs(adr): registrar cupos de login por dispositivo conocido y origen desconocido
b2e47af docs(adr): registrar la propagación de la sesión entre pestañas
a47c75a docs(adr): registrar el cálculo de alerta_reloj con la hora de envío
e06919d fix(web): exigir node 24 y leer las fotos sin depender de stream()
7aed2bf docs(plan): plan de correcciones v1.1
5e5cdcf chore: instalar configuración de claude code y alcance de correcciones v1.1
```

Después viene el commit `docs: informe de correcciones v1.1`, que agrega este informe, la evidencia final, el resumen de Lighthouse y el progreso.

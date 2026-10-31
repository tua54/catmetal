# Informe de la sesión de correcciones v1.2

- Fecha: 2026-10-30.
- Rama: `fix/auditoria-v1` (PR #1). **Sin push.** Tag local: `correcciones-v1.2`.
- Alcance: `docs/correcciones-v1.2.md`. Plan: `docs/plan-correcciones-v1.2.md`. Evidencia: `docs/evidencia/correcciones-v1.2.md`.

## 1. Resumen

Se corrigieron **todos** los ítems de la segunda auditoría: **2 de P1 (A1 y A2) y 9 de P2 (A3 a A11)**. Ninguno quedó sin resolver. Además se encontraron y corrigieron **3 defectos nuevos** (N1 a N3) y el hallazgo bajo **S-v12-01** de la revisión de seguridad.

- **A1**, el defecto que hizo fallar el CI del PR #1, está corregido de raíz. La auditoría, las filas dependientes, la fila `aplicada` de `sync_mutations` y las verificaciones posteriores al batch ya no dependen de que coincidan horas o valores. Dependen de una **marca de escritura** que solo la sentencia que hizo el cambio pudo escribir (ADR 0028).
- Cada ítem de código tiene una prueba de regresión **determinista** que falló con el código anterior. La salida del fallo está en el cuerpo de su commit.
- Gates finales en `23289d0`:
  - **2.365 pruebas** sin fallos (worker 98,38 % de líneas, shared 100 %);
  - **36 E2E**;
  - `pnpm audit --prod` sin vulnerabilidades;
  - Lighthouse ≥ 90 en todas las páginas;
  - **20/20 repeticiones** de las pruebas de concurrencia.
- Hay **2 ADR nuevas** (0028 y 0029), enmiendas a las ADR 0018, 0021, 0022, 0023 y 0026, y **1 migración** nueva (0009, solo `ADD COLUMN`).
- Revisiones de solo lectura:
  - esquema: **aprobada**, sin críticos, altos ni medios;
  - seguridad: **aprobada con observaciones**, sin críticos, altos ni medios.
  - Se corrigieron también sus hallazgos bajos (R-v12-01 → N2, y S-v12-01).

**Subagentes usados:**

| Subagente | Trabajo |
|---|---|
| `software-architect` | Segunda opinión del ADR 0028 (A1): "aprobar con cambios"; los 11 cambios pedidos se incorporaron antes de implementar. |
| `general-purpose` (backend) | A1 y N1; A3, A5, A8 y A6-servidor; N2; S-v12-01. |
| `react-developer` | A2; A4, A7 y A6-cliente (uno a uno, porque comparten `motor.ts`). |
| `database-specialist` | Revisión de esquema de A1 (`docs/auditoria/revision-esquema-v1.2.md`). |
| `security-reviewer` | Revisión de seguridad de A1, A3, A5, A6 y A8 (`docs/auditoria/seguridad-v1.2.md`). |
| Orquestador | C0, plan, ADR y enmiendas, A9, A10, A11 y N3; revisión de cada diff, gates, todos los commits, evidencia e informe. |

No se usaron `mvc-dotnet-developer`, `angular-developer`, `ui-ux-designer` ni `test-engineer`. El aviso de A7 reutilizó el componente `Aviso` existente, así que no hizo falta `ui-ux-designer`.

## 2. Tabla de ítems

| Id | Prio. | Estado | Commit | Prueba de regresión (archivo › prueba) | ADR |
|---|---|---|---|---|---|
| A1 | P1 | Resuelto | `6fbad17` | `apps/worker/test/correcciones-a1-dominio.test.ts` (un caso por familia, por ejemplo › «editar: dos ediciones de la misma versión con el mismo ahora, una sola consumo.editar»); `correcciones-a1-push.test.ts`; `correcciones-a1-sesiones.test.ts`; `correcciones-a1-estatica.test.ts`; `correcciones-a1-no-fuga.test.ts`; `correcciones-b4-evidencias-concurrencia.test.ts` › «dos confirmaciones con el mismo ahora (determinista)» | 0028 |
| A2 | P1 | Resuelto | `8206366` | `apps/web/src/auth/correcciones-a2-inactividad-compartida.test.ts` › «con interacción en B a los 9 min, el temporizador de A al minuto 10 no bloquea ninguna»; `e2e/sesion-multipestana.spec.ts` (2 pruebas nuevas) | 0023, enmienda 1 |
| A3 | P2 | Resuelto | `30641d4` | `apps/worker/test/correcciones-a3-logout-version.test.ts` › «POST /auth/logout sin cabecera (v1) con la mínima en 2 → 204 y la familia queda revocada» | 0026, enmienda 1 |
| A4 | P2 | Resuelto | `6775a8a` | `apps/web/src/sync/correcciones-a4-refresh-426.test.ts` › «push → 401 → refresh → 426: el lote vuelve a pendiente sin contar el intento ni aplicar espera…» | 0026 |
| A5 | P2 | Resuelto | `d0bdf03` | `apps/worker/test/correcciones-a5-login-no-bloquea-g.test.ts` › «desde un dispositivo conocido, con g en máximo − 1 …» | 0018, enmienda 2 |
| A6 | P2 | Resuelto | `77f0612` (servidor), `27de118` (cliente) | `apps/worker/test/correcciones-a6-token-pagina.test.ts` › «un token emitido para el supervisor A, usado por el supervisor B → 400»; `apps/web/src/datos/correcciones-a6-purga-area-temporal.test.ts` › «tras la purga, el área temporal y el progreso del usuario quedan vacíos» | 0029 |
| A7 | P2 | Resuelto | `7c8cf4f` | `apps/web/src/sync/correcciones-a7-cuota-snapshot.test.ts` › «en una página…», «en el reemplazo…», «con un cambio de época pendiente, el push NO se adelanta…»; `components/layout/correcciones-a7-aviso-cuota.test.tsx` | 0022, enmienda 1 |
| A8 | P2 | Resuelto | `11965e0` (+ `23289d0`, S-v12-01) | `apps/worker/test/correcciones-a8-refresh-cookie-dispositivo.test.ts` › «sin cookie de dispositivo: el refresh la emite…» | 0018, enmienda 2 |
| A9 | P2 | Resuelto | `81aa189` | Documental: ADR 0021 y `docs/despliegue.md` §8 y §9.2 | 0021 |
| A10 | P2 | Resuelto | `f57c03f` | `apps/worker/test/correcciones-a10-runners.test.ts` › «todos los jobs corren en ubuntu-24.04» | — |
| A11 | P2 | Resuelto | `e2f01d5` (evidencia) | Disciplina de procesos y cierre verificado: `docs/evidencia/correcciones-v1.2.md`, sección A11 | — |

Los estados por ítem, con su hash, están también en `docs/correcciones-v1.2.md`.

## 3. Ítems nuevos

| Id | Prio. | Descripción | Estado | Commit |
|---|---|---|---|---|
| N1 | P1 | La concurrencia optimista de materiales, settings y asignaciones comparaba solo `updated_at` o el valor leído. Con escrituras en el mismo milisegundo había actualizaciones perdidas, y con un valor que volvía al anterior (ABA) se aplicaba un cambio con un `datos_antes` falso. Ahora la principal exige también la marca leída. Prueba: `correcciones-n1-concurrencia-optimista.test.ts`. | Resuelto | `6fbad17` (junto con A1) |
| N2 | P2 | R-v12-01 de la revisión de esquema. El reinicio de `intentos_fallidos` del login y el SQL de desbloqueo de emergencia no renovaban la marca de `users`. Prueba: `correcciones-n2-marca-users.test.ts`. | Resuelto | `d20436b` |
| N3 | P1 | Las pruebas que esperan el 429 al sexto intento de login dependían de la hora: el limitador de Miniflare cuenta por ventanas alineadas al reloj. Falló así en la primera corrida de gates finales. Prueba: `correcciones-n3-limitador-ventana.test.ts`, que fuerza la ráfaga a 1,5 s del cambio de ventana. | Resuelto | `947b69f` |
| S-v12-01 | Bajo | Revisión de seguridad. El refresh emitía una entrada de `mp_dispositivo` con nonce aleatorio por cada rotación: un refresh token robado daba un cupo `d:` nuevo por rotación. Ahora el nonce es determinista por familia. Prueba: `correcciones-s-v12-01-refresh-nonce.test.ts`. | Resuelto | `23289d0` (ADR `babb0e4`) |

## 4. A1 en detalle

**Mecanismo elegido** (ADR 0028, opción (b)): una marca de escritura que solo la sentencia principal de ese batch pudo escribir.

- Se descartaron `changes()` de SQLite (depende del orden interno de D1 y no se puede comprobar de forma estática), la auditoría previa con el mismo predicado (si los predicados se separan, el defecto vuelve en silencio), encadenar la principal al id de la auditoría y un `UNIQUE` en `audit_log`.
- Las marcas admitidas son cuatro, y solo las crean constructores de `apps/worker/src/auditoria/auditar.ts`:
  - `porMarca`: la columna `escritura_id`, con un UUID v7 nuevo por sentencia principal;
  - `porPkNueva`: una PK que genera el servidor en esa misma sentencia;
  - `porReserva`: el `reserva_id` de `login_cupos`;
  - `porAuditoria`: encadena a una fila de auditoría de ese mismo batch.
- El tipo es opaco (`CondicionDeEscritura`). Lo exige el compilador y además se comprueba en ejecución con un `WeakSet`. Las dependientes usan `sentenciaDependiente`, con un marcador único al final.
- La marca también sirve de testigo de concurrencia optimista (N1).

**Escrituras cubiertas:**

- **`porMarca`**:
  - evidencia subida;
  - consumo crear y editar, por REST y por `/sync/push`;
  - novedad crear, con sus evidencias encadenadas;
  - aprobar y rechazar: las dos auditorías y la lectura B11 sobre `validations.escritura_id`, porque el trigger `validations_aplica_decision` no fija la marca del consumo;
  - material editar;
  - orden crear (con sus materiales planeados encadenados), iniciar y finalizar;
  - tolerancia (`settings`);
  - cada cambio de asignación, con su propia marca;
  - edición de usuario por el admin;
  - `revocarFamilia` (logout y reutilización);
  - revocación de familias ajenas al iniciar sesión;
  - desbloqueo heredado y rehash en el login;
  - reinicio de `intentos_fallidos` en el login (N2).
- **`porPkNueva`**: rotación y reintento en la ventana de gracia del refresh (`emitirSucesor`), con el UPDATE del token de origen como dependiente.
- **`porReserva`**:
  - bloqueos que deja una reserva;
  - reinicio del cupo tras el login;
  - reinicio del admin, por tipo;
  - desbloqueo de `g` en el login correcto (A5).
- **`porAuditoria`**: revocar todas las sesiones y reiniciar cupos, como dependientes de `usuario.editar`.
- **`sentenciaDependiente(plan.aplicada)`**: la fila `aplicada` de `sync_mutations`. Es obligatoria: el push lanza un error si un plan no expone su marca.
- **Siguen incondicionales**, porque son `INSERT … VALUES`, que aborta el batch entero si la fila ya existe: `material.crear`, `usuario.crear`, `sesion.inicio` y `dispositivo.registro`.

**Migración**: `migrations/0009_marca_de_escritura.sql`, escrita a mano.

- Son 11 `ALTER TABLE … ADD COLUMN escritura_id TEXT`, anulables y sin valor por defecto.
- No reconstruye tablas ni toca triggers. Las filas existentes quedan en `NULL`, y ninguna condición compara con `NULL`.
- La columna es interna:
  - los tipos `Fila*` la omiten;
  - no sale por REST, sync, snapshot ni auditoría (`correcciones-a1-no-fuga.test.ts`);
  - el backup no la exporta (`columnasTecnicas`).
- Un respaldo estático (`correcciones-a1-estatica.test.ts`) impide volver a escribir:
  - un `INSERT INTO audit_log` fuera de `auditar.ts`;
  - un literal `{ sql:` pasado a los helpers;
  - un `EXISTS` con `_at = ?`.

**Lo que se decide después del batch**:

- `cambiosEsperados` y `principalAplico` leen `meta.changes` de su propia sentencia y no dependían de coincidencias.
- La lectura `filasEsperadas` (B11) y la condición de la fila `aplicada` del push sí dependían, y se corrigieron.

**Pendiente en staging** (`docs/pendientes-humanos.md`):

1. Aplicar la 0009 antes de desplegar el Worker v1.2 (`docs/despliegue.md` §4 y §6).
2. Repetir contra la D1 remota la prueba de B4 y dos ediciones concurrentes del mismo consumo.
3. Correr las consultas de detección de `docs/despliegue.md` §9.5 sobre la base existente.
4. Confirmar la atomicidad y la serialización de los batches de D1 remota.

## 5. Cambios de contrato entre cliente y servidor

| Cambio | Dirección | Compatibilidad con clientes v1.0 y v1.1 |
|---|---|---|
| `POST /auth/logout` no exige la versión mínima (A3) | servidor | Solo amplía: un cliente viejo puede cerrar sesión con la mínima subida. El refresh y el login siguen exigiéndola. |
| El refresh exitoso pone `mp_dispositivo` (A8, S-v12-01) | servidor → navegador | Una cookie HttpOnly más en la respuesta del refresh, con los mismos atributos que en el login. El cliente no la lee. |
| Token de página del snapshot v3, ligado a `user_id` y `rol` (A6) | interno al token opaco | Un token v2 (descarga a medias al desplegar) o de otra identidad recibe 400 `VALIDACION` campo `pagina`. El motor v1.1 lo trata empezando el snapshot de cero una vez (verificado en el tag `correcciones-v1.1`). El v1.0 tiene el mismo código de reinicio. |
| Aviso `actividad` y campo `motivo` en `BroadcastChannel('catmetal-sesion')`, más la clave `catmetal-sesion-actividad` de `localStorage` (A2) | entre pestañas del mismo navegador | Una pestaña con el código anterior ignora `actividad` y emite `bloqueo` sin `motivo`, que bloquea a todas, como antes. Dura hasta que se recarga. |
| `escritura_id` | interno | No es contrato: no sale del servidor. |

No hay cambios en los esquemas de `packages/shared`.

## 6. Gates finales

Todos ejecutados por el orquestador en `23289d0` (detalle en `docs/evidencia/correcciones-v1.2.md`):

| Gate | Resultado |
|---|---|
| `pnpm lint` | sin errores |
| `pnpm typecheck` | sin errores |
| `pnpm format:check` | sin errores |
| `pnpm test` | **2.365 pruebas, 0 fallidas**: shared 265 (100 % de líneas), web 662, worker 1.438 (**98,38 %** de líneas, 2500/2541) |
| `pnpm test:e2e` | **36 passed** (Chromium completo y WebKit `@humo`) |
| `pnpm audit --prod` | sin vulnerabilidades |
| `pnpm test:lighthouse` | todas las categorías ≥ 90; medianas de Performance 92, 100, 100, 100, 100 y 100 |
| 20 repeticiones de concurrencia | **20/20 sin fallos**, 41 pruebas por corrida (A1 dominio, push y sesiones, N1, N2, B4 y `fase3-push-concurrencia`) |

Al cerrar P1 también se corrieron los gates completos: 2.322 pruebas y 36 E2E.

## 7. Hallazgos de las revisiones de esta sesión

| Revisión | Veredicto | Hallazgos | Estado |
|---|---|---|---|
| Segunda opinión del ADR 0028 (`software-architect`) | Aprobar con cambios | R1 a R8 y 11 enmiendas al texto | Todos incorporados antes de implementar (`5632b44`) |
| Esquema de A1 (`database-specialist`) | Aprobado | R-v12-01 (bajo); R-v12-02 a R-v12-06 (info) | R-v12-01 → N2, resuelto. R-v12-04, R-v12-05 y R-v12-06 resueltos en `docs/despliegue.md`. R-v12-02 y R-v12-03 sin acción (correctos y documentados). |
| Seguridad de A1, A3, A5, A6 y A8 (`security-reviewer`) | Aprobado con observaciones | S-v12-01 (bajo); S-v12-02 a S-v12-04 (info) | S-v12-01 resuelto (`23289d0`). S-v12-02 y S-v12-03 sin acción. S-v12-04 (no alcanzable en la práctica) queda en `docs/pendientes-humanos.md`. |

No hubo hallazgos críticos, altos ni medios.

## 8. Procesos en segundo plano (A11)

- El orquestador no lanzó ningún shell en segundo plano. Todas sus esperas tuvieron un fin fijo, por debajo del tope de 10 min de la herramienta. Todos los comandos largos (`pnpm test`, E2E, Lighthouse, repeticiones) corrieron en primer plano con `timeout`.
- Cada brief exigió no dejar procesos vivos y poner tope a toda espera. Los 7 subagentes terminaron y confirmaron su cierre.
- Comprobación final con PowerShell: ningún `node.exe`, `workerd`, `wrangler`, `vitest` ni `playwright`. Solo procesos `msedge` del perfil normal del usuario, ajenos a la sesión.

## 9. Pendientes humanos

Actualizados en `docs/pendientes-humanos.md`:

- **Push de la rama y del tag**, cuando el equipo lo apruebe. Actualiza el PR #1 y vuelve a correr su CI:

  ```
  git push origin fix/auditoria-v1 --follow-tags
  ```

- **Staging (v1.2)**:
  - aplicar la migración 0009 antes del Worker;
  - repetir B4 y la edición concurrente contra la D1 remota;
  - correr las consultas de detección de §9.5;
  - confirmar la atomicidad y la serialización de los batches.
- **Despliegue (v1.2)**:
  - aplicar la 0009 y desplegar seguidos;
  - un snapshot a medias se reinicia una vez (A6);
  - el SQL de desbloqueo de emergencia se genera en el momento de usarlo (N2);
  - procedimiento para rotar `REFRESH_SECRET` (A8, `docs/despliegue.md` §3).
- **Seguridad**: S-v12-04 como mejora futura; S-02 sigue abierto.
- Siguen los pendientes anteriores: tablet real, WebKit en un dispositivo y verificaciones de staging de la v1.1.

## 10. Mapa de commits

`git log --oneline correcciones-v1.1..fix/auditoria-v1`, antes del commit de este informe:

```
e2f01d5 docs(evidencia): registrar los gates finales, las repeticiones y el cierre de procesos
23289d0 fix(seguridad): emitir en el refresh una sola entrada de dispositivo por familia
babb0e4 docs(adr): corregir la adr 0018 tras s-v12-01
2061fcb docs(auditoria): guardar la revisión de seguridad de la v1.2
947b69f test(auth): hacer deterministas las pruebas del limitador de login
8b71fea docs(correcciones): marcar a6 como resuelto
27de118 fix(web): descartar el área temporal del snapshot al purgar datos ajenos
a7cb43f docs(correcciones): marcar a7 y n2, y actualizar el progreso
7c8cf4f fix(sync): salir solo de un snapshot que no cabe en el almacenamiento
d20436b fix(auth): renovar la marca de escritura en las escrituras de users sin auditar
ed73c16 docs(correcciones): marcar a3, a4, a5, a8 y el servidor de a6
77f0612 fix(sync): ligar el token de página del snapshot al usuario y al rol
11965e0 fix(auth): renovar o emitir la cookie del dispositivo en un refresh exitoso
d0bdf03 fix(auth): impedir que un login correcto deje bloqueado el tope global
30641d4 fix(auth): dejar el logout fuera de la versión mínima del cliente
b5d777c docs(auditoria): guardar la revisión de esquema de a1 y atender sus hallazgos
6775a8a fix(sync): no contar intento ni espera si el refresh del push responde 426
5f6986b docs(correcciones): marcar a9 y a10, y registrar la evidencia del cierre de p1
81aa189 docs: corregir la adr 0021 y las tablas incompletas admitidas del backup
f57c03f ci: fijar la imagen ubuntu-24.04 en todos los jobs
b5d9b9f docs(adr): enmendar la adr 0022 para la cuota de almacenamiento agotada
8129096 docs(adr): registrar el token de página ligado al usuario y al rol
b0647aa docs(adr): enmendar la adr 0018 por el tope global y la cookie de dispositivo
8cd866b docs(adr): enmendar la adr 0026 para que el logout no exija la versión mínima
a47bff0 docs(correcciones): marcar a1, a2 y n1 como resueltos
8206366 fix(web): compartir la última actividad entre pestañas antes de bloquear
233015c docs(adr): anotar la implementación de la inactividad compartida
6fbad17 fix(api): condicionar la auditoría a una marca de escritura
d2ee8af docs(adr): anotar la implementación de la marca de escritura
5632b44 docs(adr): registrar la auditoría condicionada a una marca de escritura
c122104 docs(adr): enmendar la adr 0023 con la inactividad compartida entre pestañas
c669dd5 docs(plan): plan de correcciones v1.2
a749532 chore: alcance de correcciones v1.2
```

Después van el commit `docs: informe de correcciones v1.2` y el tag anotado local `correcciones-v1.2`.

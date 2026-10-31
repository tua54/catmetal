# Plan de la sesión de correcciones v1.2

- Fecha: 2026-10-30.
- Rama: `fix/auditoria-v1` (PR #1). Sin push.
- Alcance: `docs/correcciones-v1.2.md`. Orden: P1 (A1, luego A2) y después P2.
- Commit de arranque: C0 `a749532`.

## Reglas comunes a todos los ítems de código

- Primero la prueba de regresión **determinista** y la salida del fallo con el código actual. Después, la corrección.
- Prueba y corrección van en el mismo commit, con `Corrige: <id>` en el cuerpo.
- Gates por commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`. Al cerrar P1 y al final, además `pnpm test:e2e` y `pnpm format:check`.
- El orquestador revisa el diff real antes de cada commit. Máximo 3 rondas de devolución por ítem.
- Ningún subagente deja procesos en segundo plano. Toda espera lleva un tope (A11).

## Grupos de paralelismo

| Grupo | En paralelo | Por qué es seguro |
|---|---|---|
| 1 | A1 (Worker) ‖ A2 (web: `auth/inactividad.ts`, `auth/sesion.ts` y la E2E multipestaña) | Archivos disjuntos. Los commits van en orden: A1 y después A2. |
| 2 | Backend: A3 → A5 → A8 → A6-servidor (en secuencia, un solo agente) ‖ Cliente: A4 → A7 → A6-cliente (en secuencia, un solo agente) | Worker y web son disjuntos. Dentro de cada lado los ítems comparten archivos, por eso van en secuencia. |
| 3 | A9 y A10 (orquestador) | Solo documentos, workflows y una prueba estática nueva. |
| — | A11 | Disciplina de procesos de toda la sesión, más el cierre y la evidencia. |

Ningún ítem del Worker corre en paralelo con A1.

## Ítems

### A1 — Auditoría condicionada a una marca de escritura (P1)

- **Responsable**: `general-purpose` (backend). Segunda opinión del ADR: `software-architect`. Revisión de esquema al cerrar P1: `database-specialist`.
- **Diseño**: ADR 0028 (opción (b): columna `escritura_id` por plan), antes de implementar.
- **Archivos**: `apps/worker/src/**` (auditoría, `dominio/*`, `sync/push.ts`, `rutas/usuarios.ts`, `auth/sesiones.ts`, `auth/contrasenas.ts`; `auth/cupos.ts` solo si hiciera falta), `apps/worker/src/db/schema*`, `migrations/0009_*.sql` (nueva, a mano, solo `ALTER TABLE … ADD COLUMN`), `apps/worker/src/cron/tablas.ts`, `scripts/restauracion-nucleo.mjs` si la restauración lo exige, `apps/worker/test/**` (pruebas nuevas `correcciones-a1-*.test.ts` y la de B4).
- **Contrato**: sin cambios externos. `escritura_id` es interna: nunca sale por la API ni por `/sync/*`.
- **Dependencias**: ADR 0028 aceptado.
- **Prueba de regresión que fallará antes**: por cada familia (evidencia, consumo crear/editar por REST y por push, novedad duplicada, validar, materiales, órdenes, settings, asignaciones, usuarios, revocación de familias, contraseñas y bloqueo de cuenta), dos planes con el **mismo `ahora`** sobre el mismo estado inicial, ejecutados uno tras otro: hoy quedan 2 filas de auditoría (o la dependiente del perdedor). Más una prueba estática sobre `apps/worker/src`. Más una variante determinista de B4.
- **Aceptación**: la de `docs/correcciones-v1.2.md` §A1: exactamente 1 fila de auditoría por familia y ninguna del perdedor; prueba estática; B4 determinista; revisión de `filasEsperadas`, `cambiosEsperados` y `condicionAplicada`; consulta de detección en `docs/despliegue.md`; verificación en staging en `docs/pendientes-humanos.md`; 20 repeticiones al final.

### A2 — Inactividad compartida entre pestañas (P1)

- **Responsable**: `react-developer`.
- **Archivos**: `apps/web/src/auth/inactividad.ts`, `apps/web/src/auth/sesion.ts` (canal de sesión y `bloquear()`), sus pruebas (`*.test.ts` de `apps/web/src/auth/`), `e2e/sesion-multipestana.spec.ts`. ADR 0023 (enmienda, la escribe el orquestador).
- **Contrato**: mensaje nuevo `actividad` en `BroadcastChannel('catmetal-sesion')`, sin secretos, con límite de frecuencia. Compatible: una pestaña vieja ignora un tipo que no conoce (se verifica).
- **Dependencias**: ninguna con A1.
- **Prueba de regresión que fallará antes**: prueba de unidad con reloj y temporizadores simulados y dos vigilantes unidos por un canal en memoria. La pestaña B tiene actividad a los 9 min. Al minuto 10 vence el temporizador de A: hoy A bloquea y avisa a B. Debe no bloquear.
- **Aceptación**: §A2. La E2E cubre "con actividad en B, A no bloquea" y "sin actividad en ninguna, ambas se bloquean en menos de 2 s".

### A3 — Logout fuera de la versión mínima (P2)

- **Responsable**: `general-purpose` (backend), después de A1.
- **Archivos**: `apps/worker/src/middleware/version-cliente.ts`, `apps/worker/src/app.ts` si aplica, prueba nueva `apps/worker/test/correcciones-a3-*.test.ts`. ADR 0026 (enmienda, orquestador).
- **Contrato**: `POST /api/v1/auth/logout` deja de responder 426. Decisión sobre `/auth/refresh` en la enmienda.
- **Prueba que fallará antes**: con `VERSION_MINIMA_CLIENTE = 2` y un cliente v1, el logout responde 426 y la familia sigue vigente.
- **Aceptación**: §A3.

### A4 — 426 dentro del refresh del push (P2)

- **Responsable**: `react-developer`, después de A2.
- **Archivos**: `apps/web/src/sync/motor.ts`, `apps/web/src/auth/sesion.ts`, sus pruebas.
- **Prueba que fallará antes**: el push recibe 401, el refresh responde 426 `CLIENTE_DESACTUALIZADO`: hoy el lote cuenta un intento y aplica espera.
- **Aceptación**: §A4: el lote vuelve a `pendiente` sin contar el intento ni aplicar espera.

### A5 — Un login correcto no bloquea `g` (P2)

- **Responsable**: `general-purpose` (backend), después de A3.
- **Archivos**: `apps/worker/src/auth/cupos.ts`, prueba nueva `apps/worker/test/correcciones-a5-*.test.ts`. ADR 0018 (enmienda si cambia la regla).
- **Prueba que fallará antes**: `g` en `máximo − 1`; un login correcto desde dispositivo conocido deja `g` bloqueado.
- **Aceptación**: §A5.

### A6 — Snapshot reanudado tras la purga de S-03 (P2)

- **Responsables**: `general-purpose` (servidor: `apps/worker/src/sync/snapshot.ts` y el token de página) y `react-developer` (cliente: `apps/web/src/auth/sesion.ts`, `apps/web/src/datos/snapshot-temporal.ts`).
- **Contrato**: el token de página incluye rol y usuario. Un token emitido para otro rol o usuario se rechaza (código de error del contrato existente, documentado en la entrega). Un cliente v1.1 con un token viejo recibe el rechazo y reinicia el snapshot (se verifica).
- **Pruebas que fallarán antes**: servidor: un token de página del supervisor A usado por B (o tras cambiar de rol) continúa hoy. Cliente: tras `purgarAjenosSinVisibilidad`, el área temporal sigue con datos ajenos.
- **Aceptación**: §A6.

### A7 — Cuota llena durante el snapshot (P2)

- **Responsable**: `react-developer`, después de A4.
- **Archivos**: `apps/web/src/datos/snapshot-temporal.ts`, `apps/web/src/sync/motor.ts`, el aviso en la UI, pruebas.
- **Prueba que fallará antes**: `QuotaExceededError` simulado en una página y en el reemplazo: hoy el área temporal queda y el push del outbox se bloquea.
- **Aceptación**: §A7.

### A8 — El refresh renueva la cookie del dispositivo (P2)

- **Responsable**: `general-purpose` (backend), después de A5.
- **Archivos**: `apps/worker/src/auth/dispositivo.ts`, `apps/worker/src/rutas/auth.ts`, prueba nueva. ADR 0018 y `docs/despliegue.md` (orquestador).
- **Prueba que fallará antes**: un refresh exitoso sin cookie `mp_dispositivo` no la emite.
- **Aceptación**: §A8.

### A9 — Documentación (P2)

- **Responsable**: orquestador. **Archivos**: `docs/adr/0021-*.md`, `docs/despliegue.md` §9.2.
- **Prueba**: documental (sin código).

### A10 — Runners de CI fijados (P2)

- **Responsable**: orquestador. **Archivos**: `.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`, prueba estática nueva `apps/worker/test/correcciones-a10-runners.test.ts`.
- **Prueba que fallará antes**: la prueba estática encuentra `ubuntu-latest`.

### A11 — Procesos en segundo plano (P2)

- **Responsable**: orquestador.
- Toda espera con tope en los briefs y en los comandos propios. Antes del informe, listar y cerrar tareas y shells; comprobar que no queda `wrangler dev`, `vitest` ni `playwright`. Evidencia en `docs/evidencia/correcciones-v1.2.md`.

## Revisiones y cierre

1. Al cerrar P1: `database-specialist` revisa A1 (solo lectura) → `docs/auditoria/revision-esquema-v1.2.md`.
2. Al cerrar todo: `security-reviewer` revisa A1, A3, A5, A6 y A8 (solo lectura) → `docs/auditoria/seguridad-v1.2.md`.
3. Hallazgos altos o críticos se corrigen antes de cerrar.
4. Gates completos, `pnpm audit --prod`, `pnpm test:lighthouse` ≥ 90, 20 repeticiones de las pruebas de concurrencia (A1 y B4).
5. `docs/INFORME-CORRECCIONES-V1.2.md`, commit final y tag `correcciones-v1.2`.

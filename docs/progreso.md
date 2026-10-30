# Progreso de la sesión

> Después de una compactación de contexto o de un reinicio, **lee este archivo primero** y retoma desde "Siguiente paso".

## Estado actual

- Rama de trabajo: `fix/auditoria-v1`, desde `build/v1` (línea base en `main`: `bfa8975`).
- **Fases 0 a 6 cerradas** (tags `fase-0` a `fase-6`). Sesión v1 terminada: ver `docs/INFORME-FINAL.md`.
- **Sesión de correcciones v1.1 terminada** en la rama `fix/auditoria-v1`. Ver `docs/INFORME-CORRECCIONES.md`.
- **Sesión de correcciones v1.2 en curso** en `fix/auditoria-v1` (alcance: `docs/correcciones-v1.2.md`, plan: `docs/plan-correcciones-v1.2.md`).

## Siguiente paso

Sesión v1.2: P1 cerrado (A1+N1 `6fbad17`, A2 `8206366`), A9 y A10 confirmados. En curso: revisión de esquema de A1 (database-specialist), backend P2 (A3 → A5 → A8 → A6-servidor) y cliente P2 (A4; luego A7 y A6-cliente, uno a uno). Al recibir cada entrega: revisar diff, gates, commit por ítem.

## Sesión de correcciones v1.2

### Mapeo de subagentes

Verificado el 2026-10-30 en la lista de tipos de agente de la sesión. Todos los del mapeo de `CLAUDE.md` están disponibles; no se creó, editó ni copió ninguno.

| Rol | Subagente | Disponible | Notas |
|---|---|---|---|
| Backend (Worker, Hono, D1, auth, sync servidor) | `general-purpose` | Sí | Brief con el rol completo y el bloque de stack. A1, A3, A5, A6-servidor, A8. |
| Revisión de esquema SQL | `database-specialist` | Sí | Solo lectura. Revisión de A1 al cerrar P1. |
| Frontend y sync del cliente | `react-developer` | Sí | A2, A4, A6-cliente, A7. Brief extra detallado para la sync. |
| Sistema visual | `ui-ux-designer` | Sí | Solo si el aviso de A7 lo requiere. |
| QA | `test-engineer` | Sí | Bloque de stack. |
| Seguridad | `security-reviewer` | Sí | Solo lectura. A1, A3, A5, A6 y A8 al final. |
| Segunda opinión de arquitectura | `software-architect` | Sí | Solo lectura. ADR 0028 (A1). |
| Documentación | `documentation-researcher` / `deep-researcher` | Sí | Solo lectura. |

No se usan `mvc-dotnet-developer`, `angular-developer` ni `orchestrator`.

### Registro cronológico

- 2026-10-30. Estado verificado: rama `fix/auditoria-v1`, archivos del equipo sin confirmar (`CLAUDE.md`, `.claude/sesion.json` apuntando a `docs/INFORME-CORRECCIONES-V1.2.md`, `docs/correcciones-v1.2.md`, `docs/ARRANQUE-CORRECCIONES-V1.2.md`). C0 en `a749532`.
- Plan escrito en `docs/plan-correcciones-v1.2.md`. Borrador del ADR 0028 (A1, opción (b): marca `escritura_id` por plan, que generaliza el `reserva_id` de la ADR 0018) enviado a `software-architect`.
- Enmienda 1 del ADR 0023 (A2) en `c122104`. A2 delegado a `react-developer`.
- Segunda opinión de `software-architect` sobre el ADR 0028: aprobar con cambios (marca general, tipo opaco, columna fuera del backup, no fuga, auditorías con estado previo convertidas). Incorporada; ADR aceptado en `5632b44`. A1 delegado a `general-purpose`. Posible N1 (concurrencia optimista de materiales por `updated_at`) encargado para verificar.
- A10 y A9 preparados por el orquestador (prueba estática de runners: falla con `ubuntu-latest`, pasa con `ubuntu-24.04`). Se confirman después de A1 y A2.
- A2 entregado (646 pruebas web, E2E 3/3). A1 entregado (1411 pruebas worker, 98,41 %; N1 confirmado y corregido). Gates del orquestador sobre el árbol combinado: lint, typecheck, format:check OK; `pnpm test` 2322 pruebas sin fallos; `pnpm test:e2e` 36 passed. Commits: ADR 0028 notas `d2ee8af`, A1+N1 `6fbad17`, ADR 0023 notas `233015c`, A2 `8206366`, estados `a47bff0`.
- Enmiendas de ADR para P2: 0026 (`8cd866b`), 0018 (`b0647aa`), ADR 0029 nuevo para A6 (`8129096`), 0022 enmienda 1 para A7 (`b5d9b9f`). A10 `f57c03f`, A9 `81aa189`.

## Sesión de correcciones v1.1

### Mapeo de subagentes

Verificado el 2026-10-30 en la lista de tipos de agente de la sesión. Todos los del mapeo de `CLAUDE.md` están disponibles; no se creó, editó ni copió ninguno.

| Rol | Subagente | Disponible | Notas |
|---|---|---|---|
| Backend (Worker, Hono, D1, auth, sync servidor) | `general-purpose` | Sí | Brief con el rol completo y el bloque de stack. |
| Revisión de esquema SQL | `database-specialist` | Sí | Modo revisión, sin modificar archivos. Bloque de stack. |
| Frontend y sync del cliente | `react-developer` | Sí | Brief extra detallado para la sync. |
| Sistema visual | `ui-ux-designer` | Sí | |
| QA | `test-engineer` | Sí | Bloque de stack. |
| Seguridad | `security-reviewer` | Sí | Solo lectura. |
| Segunda opinión de arquitectura | `software-architect` | Sí | Solo lectura. M1 y M4. |
| Documentación | `documentation-researcher` / `deep-researcher` | Sí | Solo lectura. |

No se usan `mvc-dotnet-developer`, `angular-developer` ni `orchestrator`.

### Registro cronológico

- 2026-10-30. Se verificó el estado: rama `build/v1`, cambios del equipo sin confirmar (`CLAUDE.md`, `docs/spec.md`, `_mover-a-claude/` borrado, `.claude/` nuevo, `docs/correcciones-v1.1.md`, `docs/ARRANQUE-CORRECCIONES.md`). `.claude/` está instalado y `guardia.mjs` está activo: bloquea el push con exit 2.
- **Bloqueo**: `guardia.mjs` trata a la sesión principal como un subagente, porque el `"agent": "orchestrator"` global hace que llegue `agent_type`. Por eso bloquea `git switch`, `add`, `commit` y `tag`. No se rodeó. Ver `docs/BLOQUEO.md`.
- Se escribió `docs/plan-correcciones.md`.
- El equipo corrigió `guardia.mjs` (solo `agent_id`) y borró `docs/BLOQUEO.md`. Se creó `fix/auditoria-v1`. C1 quedó en `5e5cdcf`.

## Mapeo de subagentes

Verificado el 2026-10-29 en `~/.claude/agents/` y en la lista de tipos de agente de la sesión. Todos los subagentes del mapeo de `CLAUDE.md` están disponibles; no se creó, editó ni copió ninguno.

| Rol | Subagente | Disponible | Notas |
|---|---|---|---|
| Backend (Worker, Hono, Drizzle/D1, auth, sync servidor) | `general-purpose` | Sí | Herramientas completas. Brief con el rol completo. |
| Revisión de esquema SQL | `database-specialist` | Sí | Orientado a SQL Server/EF Core: brief con bloque de stack; en modo revisión no modifica archivos. |
| Frontend (PWA) | `react-developer` | Sí | |
| Sincronización (cliente) | `react-developer` | Sí | Brief extra detallado. |
| Sistema visual | `ui-ux-designer` | Sí | |
| QA | `test-engineer` | Sí | Orientado a .NET: brief con bloque de stack. |
| Seguridad | `security-reviewer` | Sí | Solo lectura (Read, Glob, Grep, Web). El orquestador guarda el informe. |
| Segunda opinión de arquitectura | `software-architect` | Sí | Solo lectura. |
| Documentación | `documentation-researcher` / `deep-researcher` | Sí | Solo lectura. |

No se usan `mvc-dotnet-developer`, `angular-developer` ni `orchestrator`.

## Prerrequisitos verificados (2026-10-29)

- Node.js v24.18.0, npm 11.16.0, git 2.45.2.windows.1, corepack 0.35.0.
- pnpm no estaba en el `PATH`. `corepack enable` falla sin permisos de administrador (`EPERM` en `C:\Program Files\nodejs`). Se instaló el shim de usuario con `corepack enable pnpm --install-directory %APPDATA%\npm` → pnpm 12.16.1. Ver `docs/notas-plataforma.md`.
- **`.claude/` no estaba instalado**: la configuración y los hooks siguen en `_mover-a-claude/` (paso 0 de `docs/ARRANQUE.md` sin ejecutar). Por la regla 7 el orquestador no crea `.claude/`. Los hooks `guardia.mjs` y `no-parar.mjs` **no están activos** en esta sesión; el orquestador cumple sus reglas de forma voluntaria y lo indica en cada brief. Registrado en `docs/pendientes-humanos.md`.
- El servidor MCP de Figma no está conectado: se trabaja con `docs/diseno/README.md` y las capturas.

## Registro cronológico

### Arranque

- Línea base en `main` (`chore: línea base de orquestación y especificación`), incluye `_mover-a-claude/` porque es la configuración entregada del proyecto.
- Rama `build/v1` creada.

### Fase 0 — Fundaciones (cerrada)

- 0.1 Monorepo y herramientas (general-purpose). Versiones: ADR 0001. pnpm 12 con `allowBuilds` y `minimumReleaseAge`.
- `documentation-researcher` verificó APIs de Cloudflare/Drizzle/Hono: `@cloudflare/vitest-pool-workers` está deprecado → se usa `@cloudflare/vitest-plugin` (desviación D1).
- 0.2 Contratos de `packages/shared` (general-purpose): 115 pruebas, 100 % de líneas.
- 0.4 Esqueleto de la PWA (react-developer), en paralelo con 0.2.
- 0.3 Worker, Wrangler, pruebas en el pool de Workers y `pnpm dev` (general-purpose). ADR 0004: `run_worker_first: true` para aplicar cabeceras a todo.
- 0.5 CI y README (general-purpose).
- `software-architect` revisó por adelantado las ADR de la Fase 1 (cursor, triggers, hashes, sesiones): 4 hallazgos altos incorporados (hidratación de órdenes recién asignadas, sobre laxo en /sync/push, user_id del autor en el sobre, época de sync) → ADR 0009 y ADR 0005/0006/0008 reescritas.
- Decisión menor: `sourcemap: true` en la web se revisa en la Fase 6.
- Evidencia: `docs/evidencia/fase-0.md`.
- Incidente (fase 0): el commit de cierre `4ef958b` dejó este registro con huecos por un error de comillas en bash (sustitución de comandos). Ningún comando dañino se ejecutó (solo falló un `pnpm dev\`). Corregido en el commit siguiente; desde entonces los documentos se editan con las herramientas de edición, no con heredocs.

### Fase 1 — Base de datos y auth (cerrada)

- 1.0 Contratos de shared endurecidos por ADR 0008/0009 (general-purpose).
- 1.1 Esquema Drizzle, migraciones 0000 (generada), 0001 (26 triggers a mano) y 0002 (settings iniciales con `sync_epoca` aleatoria por base) (general-purpose).
- 1.2 Seed local idempotente (general-purpose). Credenciales: `admin@catmetal.test`, `jefe@catmetal.test`, `supervisor1@catmetal.test`, `supervisor2@catmetal.test`, contraseña `SEED_PASSWORD` de `apps/worker/.dev.vars`.
- Decisión menor: en `audit_log`, las claves compuestas usan `entidad_id = '<order_id>:<user_id>'` (`order_supervisors`) y `'<order_id>:<material_id>'` (`order_planned_materials`); `settings` usa su `clave`.
- Decisión menor: el seed usa `ON CONFLICT DO NOTHING` en vez de `INSERT OR IGNORE` para no ocultar violaciones de CHECK.
- 1.3 Auth completa (general-purpose): login, refresh con rotación y ventana de gracia, bloqueo, CSRF, permisos, usuarios.
- 1.4 Matriz de permisos de la §3 (test-engineer): 48 pruebas.
- 1.5 Revisión del esquema (database-specialist): `docs/auditoria/revision-esquema-fase-1.md`.
- 1.7 Aplicación de la revisión (general-purpose): ADR 0010, migraciones 0003–0004, 34 triggers.
- Preguntas nuevas: P20 (lote obligatorio), P21 (fotos HEIC).
- Cierre: gates en verde, 466 pruebas. Evidencia: `docs/evidencia/fase-1.md`.

### Fase 2 — API de negocio (cerrada)

- 2.1 Infraestructura de comandos de dominio, materiales, settings, órdenes y asignaciones (general-purpose), en curso.
- **Tarea adelantada 4.1** (sistema visual y componentes base, `ui-ux-designer`, ADR 0011): se ejecuta en paralelo con la Fase 2 porque solo toca `apps/web/src/components/ui` y no depende del backend. Su commit lleva `Fase: 4`.
- 2.1 confirmada. 4.1 (adelantada) confirmada: 76 pruebas de componentes.
- En paralelo: 2.2 (consumos, novedades, evidencias), 2.4 (auditoría y reportes) y **tarea adelantada 3.3** (capa Dexie + outbox, `react-developer`, ADR 0012; solo toca `apps/web/src/datos`).
- 2.2, 2.3, 2.4 confirmadas (consumos/novedades/evidencias, validaciones, auditoría/reportes). 2.5 (test-engineer): 421 pruebas transversales, sin defectos.
- 2.6 revisión de seguridad: 0 críticos, 0 altos, 1 medio. `docs/auditoria/seguridad-fase-2.md`. ADR 0013 (auditoría de identidades solo para admin; sin correo en la auditoría). Correcciones en la tarea 2.8 (en curso).
- Tareas adelantadas confirmadas: 3.3 (Dexie + outbox) y 3.4 (cliente de auth, Dexie v2 con tabla `candados`).
- Decisión menor (3.4): el login cae al verificador offline solo ante error de red o 5xx del servidor; un rechazo del servidor (credenciales, bloqueo, origen) nunca abre la sesión offline. Se revisará en la seguridad de la Fase 4.
- `pnpm audit --prod`: sin vulnerabilidades conocidas.
- 2.8 correcciones de seguridad confirmadas (`2594d7e`).
- Cierre: 1.428 pruebas en verde; `pnpm audit --prod` sin vulnerabilidades. Evidencia: `docs/evidencia/fase-2.md`.

### Fase 3 — Sincronización (cerrada)

- Adelantadas y confirmadas: 3.3 (Dexie + outbox), 3.4 (cliente de auth), contrato `/sync/snapshot` (orquestador), 3.5 (motor de sync del cliente, `react-developer`).
- Decisión menor (3.5): sin conexión y sin pendientes, el indicador dice "Sin conexión · Todo sincronizado" (en vez de "0 por sincronizar").
- En curso: 3.1–3.2 servidor de sync (`general-purpose`), y **tarea adelantada 4.2** (shell PWA, login, layout, estado de sync; `react-developer`; plan de la Fase 4 ya confirmado).
- 3.1–3.2 servidor de sync confirmado (`8388341`); ADR 0015 (visibilidad de usuarios, revocación, errores).
- Adelantadas confirmadas: 4.2 (shell PWA, login, layout, estado de sync) y 6.1 (cron de backup, ADR 0014). Planes de las Fases 4, 5 y 6 confirmados por adelantado.
- En curso: 3.6 (revisión de protocolo y esquema, `database-specialist`), 4.3 (pantallas del supervisor) y 4.4a (infraestructura E2E, `test-engineer`).
- 3.6 revisión del protocolo (`docs/auditoria/revision-esquema-fase-3.md`): 3 altos. ADR 0016 (época en el push, retención de 30 días, idempotencia por clave natural, backup con continuaciones). Contrato de shared ajustado por el orquestador (`dc92e42`). Pregunta P24.
- 4.4a infraestructura E2E confirmada (18 pruebas, Chromium y WebKit; login offline ~280 ms en Chromium y ~1,5 s en WebKit).
- En curso: 3.8 (correcciones del servidor), 3.9 (correcciones del cliente), 4.3 (pantallas del supervisor).
- Pendiente menor: que `scripts/seed.mjs` acepte `SEED_PASSWORD` por variable de entorno para retirar `scripts/e2e-precarga-seed.mjs`.
- 3.8 (servidor) y 3.9 (cliente) corrigieron los hallazgos de la revisión 3.6. Pruebas inestables corregidas sin tocar aserciones (rate limiter y rutas lazy).
- Cierre: shared 209, worker 1.152, web 374 pruebas; audit sin vulnerabilidades. Evidencia: `docs/evidencia/fase-3.md`.

### Fase 4 — PWA del supervisor (cerrada)

- Adelantadas y confirmadas: 4.1, 4.2 (+4.2b), 4.3, 4.4a. En curso: 4.4b (E2E offline con foto y tablet compartida).
- **Tareas adelantadas de la Fase 5** en paralelo: 5.1–5.2 (pantallas del jefe, `react-developer`) y 5.3 (pantallas de admin, otro `react-developer`), con archivos separados; ambos tocan solo su bloque de `src/rutas/rutas.tsx`.
- 4.4b E2E offline con foto y tablet compartida; 4.5 revisión de seguridad (2 medios); ADR 0017; 4.7 correcciones (cliente `c6b442b`, servidor `c7b855e`); `wrangler.jsonc` sin invocation logs ni URLs públicas en producción.
- Cierre: 1.859 pruebas unitarias/integración y 25 E2E en verde; audit sin vulnerabilidades. Evidencia: `docs/evidencia/fase-4.md`.

### Fase 5 — PWA del jefe y del admin (cerrada)

- Ejecutada adelantada en paralelo con la Fase 4: 5.1–5.2 pantallas del jefe (`react-developer`), 5.3 administración (`react-developer`), 5.4 E2E (`test-engineer`).
- Cierre: mismos gates que la Fase 4. Evidencia: `docs/evidencia/fase-5.md`.

### Fase 6 — Endurecimiento y despliegue (cerrada)

- Adelantadas y confirmadas: 6.1 cron de backup; 6.4 `docs/despliegue.md`, `deploy-staging.yml` (solo manual) y `scripts/crear-admin-sql.mjs`; `wrangler.jsonc` sin invocation logs, producción sin workers.dev ni preview URLs.
- En curso: 6.3 instalabilidad, Lighthouse y axe automatizados (`test-engineer`); 6.2 endurecimiento de la UI (`ui-ux-designer`); M5 rendimiento del snapshot (`general-purpose`).
- 6.2 UI endurecida (`ui-ux-designer`), M5 snapshot, 6.3 instalabilidad/Lighthouse/axe (`test-engineer`), 6.5 revisión final (`security-reviewer`: 0 críticos, 0 altos, 1 medio), 6.7 correcciones (servidor, cliente, workflow por SHA, guía).
- Cierre: 1.926 pruebas, 33 E2E, Lighthouse ≥ 90, audit --prod sin vulnerabilidades. Evidencia: `docs/evidencia/fase-6.md`.
- C2 y N1 resueltos (e06919d). ADR 0019 (M2), 0023 (M7) y 0018 (M1, con la segunda opinión de software-architect: aprobar con cambios, todos incorporados).
- D9 (desviaciones) y P25 (preguntas abiertas) registradas para M1.
- ADR 0022 (M5/M6) aceptado (82b88ca); react-developer implementa. ADR 0020 (M3) y 0021 (M4) propuestos por general-purpose; segunda opinión de software-architect en curso. M1 en implementación.
- M1 resuelto (e8e5a27). N2 (seed y AUTOINCREMENT) resuelto (25c254a); D1 local recreada con seed --reset. N3 registrado (P2).
- M2-servidor (d498af3), M5/M6 (bf91c2f). M7 y M2-cliente encargados a react-developer. Decisión menor: B1 y B6 (P2, solo `apps/worker/src/auth/`) se adelantan en paralelo con el resto de P1, con archivos disjuntos, igual que D8 en la v1.
- M3/M4 (88c6afb), B1 (f5d4454), B6 (51a3ed3), B7 (231ad15; 0008 aplicada a la D1 local), B8 (8f24550). En curso: M7 y M2-cliente (react-developer), B3+B12+B11 y B4 (general-purpose).
- B4 (ea0f97d, ADR 0024), B3-servidor (f8b5c1b), B12 (65e4732, ADR 0025), B11 (69eb496). Revisión de esquema guardada (5bcfbc0): aprobado con cambios, R-01 alto. ADR 0026 (B5).
- M7 y M2-cliente (ea2b5df). El react-developer que los implementó quedó esperando un comando en segundo plano; el orquestador corrió los gates y la E2E y confirmó su trabajo. Gates de P1: format:check, y E2E 35/35.
- Revisión de seguridad (5ad5b39, d4b6d21) con seguimiento de M7: 0 críticos, altos o medios. S-02, S-05 y S-06 (53487c8), S-03 y S-09 (2c29a5d, d14566f, ADR 0027); S-01 se acepta para respetar la spec §5 (d).
- P2 del cliente: B3 (cc367e4), B9 (8045d1f), B10 (79f0999) y B5 (68dc60d).
- Gates finales en verde: 2.252 pruebas, 35 E2E, audit sin vulnerabilidades y Lighthouse 100. Informe y tag `correcciones-v1.1`.

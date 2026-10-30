# CLAUDE.md — Control de Materia Prima · Catmetal S.A.S. (100% Cloudflare)

## Misión de esta sesión: correcciones v1.2

Estado de partida:

- La v1 (Fases 0 a 6) está en `build/v1`.
- Las correcciones v1.1 están en `fix/auditoria-v1`, con el tag `correcciones-v1.1`.
- El equipo ya hizo **push** de todo y abrió el **PR #1** (`fix/auditoria-v1` → `main`).
- El CI del PR falló por un defecto real que solo aparece a veces (A1).

**Esta sesión corrige los ítems de `docs/correcciones-v1.2.md`, en orden: P1 (A1, luego A2) y después P2.** Todo en una sola sesión continua.

Eres el **arquitecto y orquestador**: planificas, delegas en subagentes, revisas, integras y verificas. Las decisiones las tomas tú, las registras como ADR y sigues. El equipo hará el push, que actualiza el PR #1. **Todo debe quedar trazable**: cada ítem cerrado tiene su prueba de regresión determinista, su commit y su línea en el informe.

No reabras ni rediseñes lo que ya está aprobado. Si al corregir encuentras otro defecto real, regístralo en `docs/correcciones-v1.2.md` con el id `N1`, `N2`, etc., en una sección "Nuevos". Corrígelo si es de P1 o está dentro del área que ya estás tocando. Si no, déjalo documentado.

## Fuentes de verdad

| Archivo | Para qué |
|---|---|
| `docs/correcciones-v1.2.md` | **Alcance de esta sesión**: ítems, ubicación, escenario y criterio de aceptación. |
| `docs/correcciones-v1.1.md` e `docs/INFORME-CORRECCIONES.md` | Contexto de la ronda anterior (no se reabren). |
| `docs/spec.md` | Requisitos del sistema (v2.1). Sin cambios en esta ronda. |
| `docs/diseno/README.md` | Guía visual: estructura del Figma + identidad de Catmetal. Obligatoria para todo trabajo de UI. |
| `docs/progreso.md` | Estado actual. **Después de una compactación de contexto o de un reinicio, lee este archivo primero** y retoma desde "Siguiente paso". |
| `docs/adr/` | Decisiones de arquitectura de la v1 (0001–0017), de la v1.1 (0018–0027) y las nuevas de esta sesión (0028 en adelante). Una ADR nueva puede reemplazar a una anterior: indícalo en ambas. |

Orden de precedencia: `docs/spec.md` > ADR aceptados > código existente. Si te apartas de la spec, escribe un ADR y una entrada en `docs/desviaciones.md`.

### Este archivo prevalece sobre las instrucciones personales de la máquina

En este repositorio, las siguientes reglas del proyecto reemplazan a las de `~/.claude/CLAUDE.md`:

- **Stack**: el stack por defecto de la máquina (ASP.NET Core MVC / .NET 10 / SQL Server) **no aplica**. Este proyecto es TypeScript sobre Cloudflare (ver `docs/spec.md`).
- **Sesión autónoma**: no pidas aclaraciones al usuario durante la sesión. Ante requisitos faltantes, aplica el supuesto más conservador, regístralo en `docs/preguntas-abiertas.md` o en un ADR y continúa.
- **Migraciones**: aplicar migraciones y el seed **contra la D1 local** (`--local` o el estado de `wrangler dev`) está autorizado y es parte del trabajo. Nunca contra D1 remota.
- **Operaciones destructivas**: borrar y recrear el estado local de desarrollo (`.wrangler/`, bases locales de prueba) está autorizado. Todo lo remoto y lo que reescriba el historial de git sigue prohibido.
- **Marcador de cierre** `ESTADO: FINALIZADO`: úsalo solo en la respuesta final, después de crear `docs/INFORME-FINAL.md`. Nunca con `BLOQUEO.md` ni con `PAUSA.md`.
- **Idioma**: la comunicación, los documentos y los mensajes de commit van en español. Los identificadores del dominio siguen los nombres de la spec (`consumptions.estado`, `cantidad`, etc.). Los nombres técnicos genéricos pueden ir en inglés.

Ante dudas sobre APIs o configuración de Cloudflare, Drizzle, Hono, Vite PWA, Dexie, Playwright o Claude Code, consulta la documentación oficial antes de suponer. Anota las particularidades de plataforma que descubras en `docs/notas-plataforma.md`.

## Reglas inviolables

1. **Nada remoto en Cloudflare.**
   - Prohibido: `wrangler deploy`, `wrangler versions …`, `wrangler secret …`, `wrangler login`, cualquier comando con `--remote`, crear o borrar D1, R2, KV o colas, y llamadas a `api.cloudflare.com`.
   - Todo se hace en local: `wrangler dev` y D1/R2/KV locales.
   - Un hook bloquea estos comandos. **Si te bloquea, no intentes rodearlo**: ni con `npx` o `pnpm exec`, ni con scripts, ni con otra sintaxis. Anota el comando en `docs/pendientes-humanos.md` y sigue.
2. **Git: commits sí, push nunca.**
   - **Nunca ejecutes `git push`** en ninguna forma, ni comandos `gh`. Tampoco cambies los remotos. El equipo humano audita y hace el push.
   - **Rama**: sigue en `fix/auditoria-v1`, la rama del PR #1. Así el push del equipo actualiza el PR. No crees otra rama. No hagas commits en `main` ni en `build/v1`.
   - **Primer commit de la sesión** (tarea C0): registra lo que el equipo dejó preparado. Son este `CLAUDE.md`, `.claude/sesion.json`, `docs/correcciones-v1.2.md` y `docs/ARRANQUE-CORRECCIONES-V1.2.md`. Mensaje: `chore: alcance de correcciones v1.2`, con `Agente: equipo`.
   - **Historial solo se agrega**: prohibido `commit --amend`, `rebase`, `reset --hard`, `filter-branch`, `push --force`, borrar ramas o tags. Si un commit tiene un error, corrígelo con un commit nuevo (`fix:` o `revert:`).
   - **Solo tú, el orquestador, ejecutas `git add`, `git commit` y `git tag`.** Los subagentes no hacen commits; el hook se lo impide.
   - Haz un commit por cada tarea terminada, después de que pasen los gates de esa tarea. Ningún commit puede dejar el repo sin compilar.
   - Formato **Conventional Commits** en español:

     ```
     <tipo>(<alcance>): <descripción en imperativo, minúscula, sin punto final>

     <cuerpo opcional: qué y por qué>

     Fase: correcciones-v1.2
     Tarea: <id del ítem: C0, A1, A7, N1…>
     Agente: <nombre del subagente que hizo el trabajo, u orquestador>
     ```

     - Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `style`, `revert`.
     - Alcances sugeridos: `shared`, `db`, `auth`, `api`, `sync`, `web`, `pwa`, `ui`, `infra`, `ci`, `seguridad`, `docs`.
     - Ejemplos: `feat(api): agregar aprobación y rechazo de consumos` · `test(sync): cubrir idempotencia de /sync/push` · `docs(adr): registrar decisión de formato de hash` · `fix(seguridad): validar mime de evidencias en el servidor`.
   - Al terminar, crea un tag anotado **local**: `git tag -a correcciones-v1.2 -m "Correcciones de la segunda auditoría"`. No toques los tags existentes (`fase-*` ni `correcciones-v1.1`).
   - Cada commit de código cita el ítem en el cuerpo: `Corrige: M3`.
   - Antes de cada commit, revisa `git diff --cached --stat`. Confirma que no van secretos, `.dev.vars`, `node_modules`, `.wrangler` ni bases locales.
3. **Secretos.**
   - Ningún secreto en el código ni en git.
   - `.dev.vars` se genera localmente con valores aleatorios y está en `.gitignore`.
   - `.dev.vars.example` lleva solo los nombres de las variables, sin valores.
4. **Nada de trampas con las pruebas.**
   - Prohibido para pasar un gate: `.skip`, `.only` o `.todo`; borrar o debilitar aserciones; añadir `@ts-ignore`, `@ts-expect-error` o `eslint-disable` sin un comentario que explique por qué; bajar umbrales de cobertura; o usar mocks de D1/R2 en pruebas de integración (se usan los reales locales de `@cloudflare/vitest-pool-workers`).
   - Si una prueba es incorrecta, corrígela y explica el cambio en el mensaje del commit.
5. **Integridad de datos.**
   - Nunca elimines ni debilites los triggers de inmutabilidad.
   - Nunca añadas `DELETE` sobre tablas de negocio.
   - Toda escritura de negocio va con su fila de auditoría en el mismo `db.batch()`.
6. **No inventes requisitos de negocio.** Si falta una definición, aplica el supuesto más conservador, regístralo en `docs/preguntas-abiertas.md` y sigue.
7. **No modifiques `.claude/`.** La configuración, los hooks y los subagentes los controla el equipo humano. Si crees que algo debe cambiar, escríbelo en `docs/pendientes-humanos.md`.

## Cómo decidir sin consultar

- **Criterio de prioridad**: integridad y no pérdida de datos de planta > seguridad > simplicidad y mantenibilidad > rendimiento > estética.
- **Decisiones no triviales**: van a `docs/adr/NNNN-titulo-corto.md`. Son no triviales las de arquitectura, librerías, formatos, protocolos, seguridad, interpretación de la spec, cambios de esquema y diseño visual. Cada ADR tiene estas secciones: Contexto, Opciones consideradas, Decisión, Consecuencias, Cómo revertir. Cada ADR va en su propio commit `docs(adr): …`.
- **Decisiones menores**: basta una línea en `docs/progreso.md`.
- **Versiones**: no actualices dependencias salvo que un ítem lo requiera. Si agregas o actualizas una, fíjala en el lockfile y regístrala en un ADR.
- **Entorno**: el equipo trabaja en **Windows**. Los scripts de `package.json` deben funcionar en Windows y en Linux (CI). Usa Node para scripts auxiliares, no bash ni PowerShell. Si algo de la plataforma se comporta distinto en Windows, anótalo en `docs/notas-plataforma.md`.

## Cuándo sí detenerse

Un hook no te deja terminar la sesión mientras no exista uno de estos archivos: `docs/INFORME-CORRECCIONES-V1.2.md`, `docs/BLOQUEO.md` o `docs/PAUSA.md`. Los informes de las rondas anteriores (`INFORME-FINAL.md` e `INFORME-CORRECCIONES.md`) ya existen y **no** cuentan para esta sesión.

- **Terminaste P1 y P2**: escribe `docs/INFORME-CORRECCIONES-V1.2.md` (ver al final) y termina.
- **Bloqueo total**: el siguiente paso requiere un recurso remoto, credenciales o una cuenta que no tienes, o el entorno impide continuar. Antes de rendirte, avanza todo lo que no dependa del bloqueo. Luego escribe `docs/BLOQUEO.md` con: qué intentaste, el error exacto, qué necesitas del equipo y el estado en que queda el repo. Haz commit y termina.
- **El humano te pide pausar**: escribe `docs/PAUSA.md` con el estado y el siguiente paso, haz commit y termina.

Si solo un ítem queda bloqueado, **no detengas la sesión**: márcalo como no resuelto en `docs/correcciones-v1.2.md` y en `docs/desviaciones.md`, y sigue con el siguiente. Si el humano te escribe durante la sesión, respóndele brevemente y continúa con el trabajo.

## Bucle de trabajo

1. **Planificar.** Escribe `docs/plan-correcciones-v1.2.md`. Por cada ítem indica: id, subagente responsable, archivos que puede tocar, contrato afectado, dependencias, la prueba de regresión determinista que fallará antes de corregir y el criterio de aceptación. Agrupa en paralelo solo ítems con archivos disjuntos. A1 toca muchos archivos del Worker: no pongas en paralelo con A1 otros ítems del Worker que toquen los mismos archivos. Haz commit: `docs(plan): plan de correcciones v1.2`.
2. **Por cada ítem:**
   1. **Primero la prueba de regresión.** El subagente la escribe y demuestra que **falla** con el código actual: copia la salida del fallo en su entrega. La prueba debe ser **determinista**. En concurrencia, fuerza la condición (por ejemplo, el mismo `ahora` inyectado o planes ejecutados sobre el mismo estado inicial) en vez de depender del azar.
   2. **Luego la corrección**, hasta que esa prueba y todos los gates pasen.
   3. **Revisa el diff real** (`git diff`), no solo el resumen del subagente. Si algo falla, devuélvelo con el error concreto. Máximo 3 rondas; después, decide tú.
   4. **Commit** del ítem: prueba más corrección en el mismo commit, con `Corrige: <id>` en el cuerpo.
   5. **Marca el ítem** en `docs/correcciones-v1.2.md` como `RESUELTO (<hash corto>)` o `NO RESUELTO (<motivo>)`.
3. **Las decisiones de diseño** (A1, A2 y cualquier otra no trivial) van en un ADR nuevo, o en una enmienda de un ADR existente, antes de implementar. Usa `software-architect` como segunda opinión para A1.
4. **Al terminar P1**:
   - Encarga a `database-specialist` una revisión de solo lectura de A1 (incluida la migración, si la hay) y guárdala en `docs/auditoria/revision-esquema-v1.2.md`.
   - Al terminar todo, encarga a `security-reviewer` una revisión de solo lectura de A1, A3, A5, A6 y A8 y guárdala en `docs/auditoria/seguridad-v1.2.md`.
   - Los hallazgos altos o críticos se corrigen antes de cerrar.
5. **Al terminar todo**:
   - Corre los gates completos.
   - Corre **20 veces seguidas** las pruebas de concurrencia (A1 y B4).
   - Deja la evidencia en `docs/evidencia/correcciones-v1.2.md`: comandos y resumen real de la salida (número de pruebas, fallidas, cobertura, E2E y repeticiones).

## Procesos en segundo plano (A11)

- Todo comando de espera lleva un tope de tiempo. No uses bucles `until`/`while` sin límite ni esperas indefinidas.
- No dejes mediciones largas en segundo plano sin un tope.
- Antes del informe final, lista tus tareas y shells en segundo plano y ciérralos todos. Comprueba que no queda ningún `wrangler dev`, `vitest` ni `playwright` corriendo. Deja constancia en la evidencia.

## Gates de calidad

- **Siempre**: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- **Al terminar P1 y al terminar todo**: además `pnpm test:e2e` y `pnpm format:check`.
- **Al final**: `pnpm audit --prod`. Ningún hallazgo high o critical sin justificación escrita en un ADR.
- **Antes del informe final**, corre `pnpm test:lighthouse` y confirma que sigue en 90 o más.
- **Cobertura mínima** de líneas en `apps/worker/src` y `packages/shared`: 80%. Ningún umbral se baja para pasar.

## Subagentes

Los subagentes **ya están instalados en esta máquina**. **No crees, edites ni copies definiciones de subagentes**: nada en `.claude/agents/` del proyecto ni en `~/.claude/agents/`. Un archivo de proyecto con el mismo nombre reemplazaría al del equipo.

Al iniciar la sesión, confirma que estos subagentes están disponibles y registra el mapeo en `docs/progreso.md`, en la sección "Sesión de correcciones v1.2". Si alguno no aparece, usa `general-purpose` con un brief completo del rol y anótalo.

| Rol | Subagente asignado | Responsabilidad en este proyecto |
|---|---|---|
| Backend | `general-purpose` | Worker API (Hono), esquema Drizzle/D1, migraciones, triggers, auth, permisos, auditoría, backups, `/sync/*` del servidor. No hay especialista de Cloudflare/TypeScript backend instalado. |
| Revisión de esquema SQL | `database-specialist` | Revisa (no escribe) A1 al terminar P1. |
| Frontend | `react-developer` | Pantallas, componentes, routing, formularios y estado de la PWA. |
| Sincronización (cliente) | `react-developer` | Dexie, outbox, motor de sync, Service Worker y subida de evidencias. Brief extra detallado: es la parte crítica. |
| Sistema visual | `ui-ux-designer` | Tokens de Tailwind, componentes base, accesibilidad, revisión visual contra `docs/diseno/`. |
| QA | `test-engineer` | Vitest (pool de Workers), Testing Library y Playwright E2E offline. |
| Seguridad | `security-reviewer` | Revisión de solo lectura de A1, A3, A5, A6 y A8 al terminar todo. Devuelve el informe y tú lo guardas en `docs/auditoria/`. |
| Segunda opinión de arquitectura | `software-architect` | Solo lectura. Obligatorio para el ADR de A1. |
| Documentación | `documentation-researcher` / `deep-researcher` | Verificar APIs y límites de Cloudflare, Drizzle, Hono, Workbox, Dexie y Playwright. |

No uses `mvc-dotnet-developer` ni `angular-developer`: no aplican a este stack. Nunca invoques `orchestrator` como subagente.

**Stack de este proyecto**: varios de estos subagentes tienen instrucciones pensadas para ASP.NET Core MVC / .NET / SQL Server. **Cada brief debe empezar con un bloque de contexto** como este:

> Stack de este proyecto: TypeScript, Cloudflare Workers + Hono, D1 (SQLite) con Drizzle, R2, KV, React + Vite PWA, Dexie, Vitest con `@cloudflare/vitest-pool-workers` y Playwright, con pnpm. No es .NET, no es SQL Server, no es EF Core. Ignora las convenciones de .NET de tus instrucciones generales y aplica las de este stack.

Reglas para todos los subagentes, sin importar su definición:

- **No hacen commits.** El hook se lo impide; los commits son del orquestador.
- Reciben el brief completo, porque no ven esta conversación.
- Los revisores (`security-reviewer`, `software-architect`, `database-specialist` en modo revisión) no modifican archivos.
- **Máximo 3 subagentes en paralelo**, y nunca dos sobre los mismos archivos.

### Plantilla de brief para un subagente

```
Objetivo: <qué debe quedar funcionando>
Ítem: <id> (ver docs/correcciones-v1.2.md y docs/plan-correcciones-v1.2.md)
Archivos que puedes tocar: <rutas>  ·  No toques: <rutas>
Contrato: <tipos/esquemas de packages/shared, endpoints, códigos de error>
Reglas de la spec aplicables: <secciones de docs/spec.md>
Criterio de aceptación: <copiado del ítem>
Primero: escribe la prueba de regresión DETERMINISTA y muestra que FALLA con el código actual (pega la salida).
Procesos: no dejes nada corriendo en segundo plano al entregar; toda espera lleva un tope.
Verificación: ejecuta <comandos> y reporta la salida resumida.
Entrega: lista de archivos cambiados, pruebas añadidas, comandos ejecutados con su resultado, decisiones tomadas, riesgos o pendientes.
Recuerda: no hagas commits; el orquestador los hace.
```

## Entregables de auditoría (mantenlos al día durante toda la sesión)

| Archivo | Contenido |
|---|---|
| `docs/progreso.md` | Sección "Sesión de correcciones v1.2": estado, siguiente paso y registro cronológico |
| `docs/plan-correcciones-v1.2.md` | Plan de la sesión |
| `docs/correcciones-v1.2.md` | Estado de cada ítem (RESUELTO con su hash / NO RESUELTO con su motivo) y los "Nuevos" |
| `docs/adr/0028-*.md` en adelante, y enmiendas | Decisiones nuevas o modificadas (0018, 0021, 0023, 0026) |
| `docs/desviaciones.md` | Entradas nuevas, si las hay |
| `docs/evidencia/correcciones-v1.2.md` | Gates, repeticiones de concurrencia y cierre de procesos |
| `docs/auditoria/revision-esquema-v1.2.md` y `seguridad-v1.2.md` | Revisiones |
| `docs/pendientes-humanos.md` | Actualizado (por ejemplo, la verificación en staging del mecanismo de A1) |
| `docs/despliegue.md` | Actualizado (A1 detección, A8 rotación de secreto, A9) |

## Al terminar

Escribe `docs/INFORME-CORRECCIONES-V1.2.md` con estas secciones:

1. Resumen.
2. **Tabla de ítems**: id, prioridad, estado (resuelto / no resuelto / parcial), commit, prueba de regresión (archivo y nombre de la prueba) y ADR si aplica.
3. Ítems nuevos encontrados (N1…) y su estado.
4. A1 en detalle: mecanismo elegido, todas las escrituras cubiertas (lista), migración si la hay y verificación pendiente en staging.
5. Cambios de contrato entre cliente y servidor, si los hay, y su compatibilidad con clientes v1.0 y v1.1.
6. Gates finales con números reales, más las 20 repeticiones de concurrencia.
7. Hallazgos de las revisiones de esta sesión y su estado.
8. Procesos en segundo plano cerrados (A11).
9. Pendientes humanos actualizados, incluido el push de `fix/auditoria-v1` y del tag `correcciones-v1.2`, que actualiza el PR #1.
10. Mapa de commits: `git log --oneline correcciones-v1.1..fix/auditoria-v1`.

Haz el commit final (`docs: informe de correcciones v1.2`) y crea el tag `correcciones-v1.2`. **No hagas push.** Termina.

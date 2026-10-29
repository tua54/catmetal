# CLAUDE.md — Control de Materia Prima · Catmetal S.A.S. (100% Cloudflare)

## Misión de esta sesión

Construye el sistema completo descrito en `docs/spec.md`, **Fases 0 a 6, en una sola sesión continua, sin detenerte entre fases**. Eres el **arquitecto y orquestador**: planificas, delegas en subagentes, revisas, integras y verificas.

Cuando aparezca una decisión, **la tomas tú** con criterio de arquitecto, la registras como ADR y sigues. No esperes confirmación humana salvo en los casos de "Cuándo sí detenerse". El equipo humano auditará todo al final, revisará los commits y hará el push él mismo. Por eso **todo debe quedar trazable**: cada decisión, cada desviación, cada prueba ejecutada y cada commit.

## Fuentes de verdad

| Archivo | Para qué |
|---|---|
| `docs/spec.md` | Requisitos del sistema. Léelo completo al empezar y relee la sección de cada fase antes de planificarla. |
| `docs/diseno/README.md` | Guía visual: estructura del Figma + identidad de Catmetal. Obligatoria para todo trabajo de UI. |
| `docs/progreso.md` | Estado actual. **Después de una compactación de contexto o de un reinicio, lee este archivo primero** y retoma desde "Siguiente paso". |
| `docs/adr/` | Decisiones de arquitectura tomadas durante la sesión. |

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
   - **Línea base**: el primer commit va en `main` e incluye solo los archivos que ya existen en el repo (este archivo, `docs/`, `.claude/`, `.gitignore`, `.gitattributes`). Mensaje: `chore: línea base de orquestación y especificación`. Inmediatamente después, crea la rama `build/v1` y trabaja ahí. No vuelvas a hacer commit en `main`.
   - **Historial solo se agrega**: prohibido `commit --amend`, `rebase`, `reset --hard`, `filter-branch`, `push --force`, borrar ramas o tags. Si un commit tiene un error, corrígelo con un commit nuevo (`fix:` o `revert:`).
   - **Solo tú, el orquestador, ejecutas `git add`, `git commit` y `git tag`.** Los subagentes no hacen commits; el hook se lo impide.
   - Haz un commit por cada tarea terminada, después de que pasen los gates de esa tarea. Ningún commit puede dejar el repo sin compilar.
   - Formato **Conventional Commits** en español:

     ```
     <tipo>(<alcance>): <descripción en imperativo, minúscula, sin punto final>

     <cuerpo opcional: qué y por qué>

     Fase: <N>
     Tarea: <N.x>
     Agente: <nombre del subagente que hizo el trabajo, u orquestador>
     ```

     - Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `style`, `revert`.
     - Alcances sugeridos: `shared`, `db`, `auth`, `api`, `sync`, `web`, `pwa`, `ui`, `infra`, `ci`, `seguridad`, `docs`.
     - Ejemplos: `feat(api): agregar aprobación y rechazo de consumos` · `test(sync): cubrir idempotencia de /sync/push` · `docs(adr): registrar decisión de formato de hash` · `fix(seguridad): validar mime de evidencias en el servidor`.
   - Al cerrar cada fase crea un tag anotado **local**: `git tag -a fase-N -m "Fase N completa"`.
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
- **Elección de versiones**: usa versiones estables actuales al momento de instalar y fíjalas en el lockfile. Registra las versiones principales en un ADR de la Fase 0.
- **Entorno**: el equipo trabaja en **Windows**. Los scripts de `package.json` deben funcionar en Windows y en Linux (CI). Usa Node para scripts auxiliares, no bash ni PowerShell. Si algo de la plataforma se comporta distinto en Windows, anótalo en `docs/notas-plataforma.md`.

## Cuándo sí detenerse

Un hook no te deja terminar la sesión mientras no exista uno de estos archivos: `docs/INFORME-FINAL.md`, `docs/BLOQUEO.md` o `docs/PAUSA.md`.

- **Terminaste la Fase 6**: escribe `docs/INFORME-FINAL.md` (ver al final) y termina.
- **Bloqueo total**: el siguiente paso requiere un recurso remoto, credenciales o una cuenta que no tienes, o el entorno impide continuar (por ejemplo, no puedes instalar dependencias). Antes de rendirte, avanza todo lo que no dependa del bloqueo. Luego escribe `docs/BLOQUEO.md` con: qué intentaste, el error exacto, qué necesitas del equipo y el estado en que queda el repo. Haz commit y termina.
- **El humano te pide pausar** durante la sesión: escribe `docs/PAUSA.md` con el estado y el siguiente paso, haz commit y termina.

Si solo una tarea queda bloqueada, **no detengas la sesión**: regístrala en `docs/desviaciones.md` y avanza con lo que no dependa de ella. Si el humano te escribe durante la sesión, respóndele brevemente y continúa con el trabajo.

## Bucle de trabajo por fase

1. **Planificar.** Relee la fase en `docs/spec.md` y escribe `docs/plan-fase-N.md`. Por cada tarea indica: id (`N.x`), subagente responsable, archivos que puede tocar, contrato que debe respetar (tipos de `packages/shared`, endpoints), dependencias y criterio de aceptación verificable. Haz commit del plan: `docs(plan): plan de la fase N`.
2. **Delegar.** Lanza en paralelo solo tareas que no toquen los mismos archivos. Usa la plantilla de brief.
3. **Revisar.**
   - **Lee el diff real** (`git diff`); no te bases solo en el resumen del subagente.
   - Ejecuta los gates. Si algo falla, devuélvelo al subagente con el error concreto.
   - Máximo 3 rondas por tarea. Si sigue fallando, decide tú: corrígelo directamente, o regístralo en `docs/desviaciones.md` y continúa con lo que no dependa de esa tarea.
   - Una fase no se declara completa con gates en rojo sin dejarlo explícito en la evidencia y en las desviaciones.
   - Cuando la tarea esté aprobada, haz su commit.
4. **Cerrar la fase.**
   - Gates en verde.
   - Revisión de seguridad en las Fases 2, 4 y 6, guardada en `docs/auditoria/seguridad-fase-N.md` con severidad y estado de cada hallazgo. Los hallazgos altos o críticos se corrigen antes de cerrar la fase, o se justifican en un ADR.
   - `docs/evidencia/fase-N.md` con los comandos ejecutados y un resumen real de su salida: número de pruebas, aprobadas, fallidas y cobertura.
   - Actualiza `docs/progreso.md`, haz commit (`docs(progreso): cierre de la fase N`) y crea el tag local `fase-N`.
5. **Continuar** con la siguiente fase sin esperar.

## Gates de calidad

- **Siempre**: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- **Desde la Fase 4**: además `pnpm test:e2e`.
- **Al cierre de las Fases 2, 4 y 6**: `pnpm audit --prod`. Ningún hallazgo high o critical sin justificación escrita en un ADR.
- **Cobertura mínima** de líneas en `apps/worker/src` y `packages/shared`: 80%. Ningún umbral se baja para pasar.

## Subagentes

Los subagentes **ya están instalados en esta máquina**. **No crees, edites ni copies definiciones de subagentes**: nada en `.claude/agents/` del proyecto ni en `~/.claude/agents/`. Un archivo de proyecto con el mismo nombre reemplazaría al del equipo.

Al iniciar la sesión, antes de la Fase 0, confirma que estos subagentes están disponibles y registra el mapeo en `docs/progreso.md`, en una sección "Mapeo de subagentes". Si alguno no aparece, usa `general-purpose` con un brief completo del rol y anótalo.

| Rol | Subagente asignado | Responsabilidad en este proyecto |
|---|---|---|
| Backend | `general-purpose` | Worker API (Hono), esquema Drizzle/D1, migraciones, triggers, auth, permisos, auditoría, backups, `/sync/*` del servidor. No hay especialista de Cloudflare/TypeScript backend instalado. |
| Revisión de esquema SQL | `database-specialist` | Revisa (no escribe) el esquema, los triggers, los índices y las migraciones antes de cerrar las Fases 1 y 3. |
| Frontend | `react-developer` | Pantallas, componentes, routing, formularios y estado de la PWA. |
| Sincronización (cliente) | `react-developer` | Dexie, outbox, motor de sync, Service Worker y subida de evidencias. Brief extra detallado: es la parte crítica. |
| Sistema visual | `ui-ux-designer` | Tokens de Tailwind, componentes base, accesibilidad, revisión visual contra `docs/diseno/`. |
| QA | `test-engineer` | Vitest (pool de Workers), Testing Library y Playwright E2E offline. |
| Seguridad | `security-reviewer` | Revisiones de las Fases 2, 4 y 6. Es de solo lectura: devuelve el informe y tú lo guardas en `docs/auditoria/`. |
| Segunda opinión de arquitectura | `software-architect` | Solo lectura. Úsalo para validar ADR de alto impacto (protocolo de sync, auth, modelo de datos). |
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
Fase / tarea: <N.x> (ver docs/plan-fase-N.md)
Archivos que puedes tocar: <rutas>  ·  No toques: <rutas>
Contrato: <tipos/esquemas de packages/shared, endpoints, códigos de error>
Reglas de la spec aplicables: <secciones de docs/spec.md>
Criterio de aceptación: <pruebas concretas que deben pasar>
Verificación: ejecuta <comandos> y reporta la salida resumida.
Entrega: lista de archivos cambiados, pruebas añadidas, comandos ejecutados con su resultado, decisiones tomadas, riesgos o pendientes.
Recuerda: no hagas commits; el orquestador los hace.
```

## Entregables de auditoría (mantenlos al día durante toda la sesión)

| Archivo | Contenido |
|---|---|
| `docs/progreso.md` | Estado actual, siguiente paso y registro cronológico por fase |
| `docs/plan-fase-N.md` | Plan de cada fase |
| `docs/adr/NNNN-*.md` | Decisiones de arquitectura |
| `docs/preguntas-abiertas.md` | Ambigüedades y el supuesto aplicado a cada una |
| `docs/desviaciones.md` | Lo que difiere de la spec o quedó incompleto, con su motivo |
| `docs/evidencia/fase-N.md` | Salida resumida de los gates de cada fase |
| `docs/auditoria/seguridad-fase-{2,4,6}.md` | Informes de seguridad |
| `docs/pendientes-humanos.md` | Comandos remotos y acciones que debe hacer una persona |
| `docs/notas-plataforma.md` | Particularidades encontradas en Cloudflare, Windows y las librerías |
| `docs/despliegue.md` | Guía de despliegue (Fase 6) |

## Al terminar la Fase 6

Escribe `docs/INFORME-FINAL.md` con estas secciones:

1. Resumen de lo construido.
2. Estado por fase: completa o parcial, con enlace a su evidencia.
3. Criterios de aceptación de la spec, uno por uno: cumplido / no cumplido / parcial, y dónde está la prueba que lo demuestra.
4. ADRs tomados (lista con una línea cada uno).
5. Desviaciones y problemas conocidos.
6. Preguntas abiertas que requieren decisión de negocio.
7. Hallazgos de seguridad abiertos.
8. Pendientes humanos, con los comandos exactos (incluido el push de `build/v1` y sus tags, para cuando el equipo apruebe).
9. Cómo verificar localmente, paso a paso, desde un clon limpio en Windows.
10. Mapa de commits: salida de `git log --oneline main..build/v1` agrupada por fase.

Haz el commit final (`docs: informe final de la sesión`) y crea el tag `fase-6` si no existe. **No hagas push.** Termina.

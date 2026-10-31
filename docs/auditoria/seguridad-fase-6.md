# Revisión de seguridad — cierre de la Fase 6 (revisión final)

- Revisor: `security-reviewer` (solo lectura), 2026-10-29, rama `build/v1`, HEAD `09dfe37`.
- Método: revisión estática de código, configuración, build (`apps/web/dist`), pruebas citadas y documentación de despliegue; particularidades de plataforma contrastadas con la documentación oficial. El revisor no ejecutó comandos: `pnpm audit` lo ejecuta el orquestador (`docs/evidencia/fase-6.md`).
- **Resultado: 0 críticos, 0 altos, 1 medio, 4 bajos, 4 informativos.**

## 1. Resumen ejecutivo

- **Apto para staging**, usando solo datos sintéticos o con todo el Worker de staging detrás de Cloudflare Access, y sin configurar un token de CI que alcance producción.
- **Apto para producción** con estas condiciones: `pnpm audit --prod` sin high/critical; F6-01 resuelto (token sin alcance sobre producción, acciones fijadas por SHA); F6-03 aplicado antes de crear el primer admin; verificaciones de staging (sección 6) en verde; política MDM y medición de PBKDF2 en la tablet real (ADR 0017); decisión del cliente sobre retención de datos personales (P7).
- Todas las correcciones previas (H-01 a H-13 de la Fase 2 y F4-01 a F4-12 de la Fase 4) están en el código y tienen pruebas. Lo nuevo (pantallas de jefe y admin, cron, snapshot v2, cabeceras, Zod `jitless`, CSP) no tiene vulnerabilidades explotables. El riesgo principal residual estaba en la cadena de despliegue.

## 2. Alcance

Correcciones de la Fase 4 (cliente y servidor), pantallas de jefe y admin, cron de backup y mantenimiento, snapshot v2, configuración y despliegue (`wrangler.jsonc`, workflows, `scripts/*.mjs`, `docs/despliegue.md`, `.gitignore`), archivos versionados (sin `.dev.vars`, `.wrangler/`, bases locales ni SQL con hashes; los únicos secretos escritos son de prueba en `apps/worker/vitest.config.mjs`).

## 3. Verificación de hallazgos anteriores

| Id | Estado verificado | Evidencia |
|---|---|---|
| H-01, H-02, H-03, H-05, H-06, H-07, H-10, H-12, H-13 | Verificado | `rutas/auth.ts`, `rutas/usuarios.ts`, `app.ts`, `middleware/{origen,secretos}.ts`, `scripts/{dev,e2e-servidor}.mjs`; `test/fase2-seguridad-correcciones.test.ts` |
| H-04 | Verificado por las pruebas | `test/fase2-seguridad-correcciones.test.ts`; ADR 0013 |
| H-08 | Aceptado | UUID v7 con CSPRNG |
| H-09 | Abierta (negocio, P23) | — |
| H-11 | Verificado (correo fuera de la auditoría; fotos sin EXIF por E2E) | — |
| Invocation logs (pendiente de la Fase 2) | Verificado | `wrangler.jsonc` (`invocation_logs: false`, heredado) |
| F4-01 a F4-05, F4-08, F4-09, F4-12 | Verificado | `apps/web/src/auth/*`, `datos/retencion.ts`, `sync/motor.ts`, `vite.config.ts`, `public/.assetsignore`; pruebas `*-seguridad.test.ts`, `inactividad.test.ts`, `retencion.test.ts` |
| F4-06 | Verificado; riesgo residual aceptado | `apps/worker/src/auth/sesiones.ts`; `test/auth-instalacion.test.ts` |
| F4-10 | Verificado en local; falta staging | `cabeceras.ts`; `test/handlers.test.ts` |
| F4-07, F4-11 | Aceptados | ADR 0017 |

## 4. Hallazgos nuevos

| # | Sev. | Hallazgo | Evidencia | Escenario | Recomendación |
|---|---|---|---|---|---|
| F6-01 | Media | El token de Cloudflare de CI probablemente alcanza producción, y en el job que lo recibe corren acciones fijadas por tags movibles y `pnpm install` | `.github/workflows/deploy-staging.yml`; `docs/despliegue.md` (token de cuenta) | Un tag de acción comprometido, un `postinstall` malicioso o un dispatch desde una rama modificada exfiltran el token → despliegue o lectura de la D1 y de los backups de producción | Cuenta de Cloudflare separada para staging (o token sin alcance sobre producción); acciones fijadas por SHA; `persist-credentials: false`; environment con política de ramas (solo `main`), revisores y sin auto-aprobación; sin caché en el job de despliegue; token mínimo con caducidad |
| F6-02 | Baja | Cloudflare Access en la guía: dato incorrecto (sí protege workers.dev), una regla sobre `/admin*` no protege la PWA instalada (el SW sirve el shell) y proteger `/api/v1/materials`/`settings` rompería a supervisor y jefe | `docs/despliegue.md` §11 | Falsa sensación de protección; staging público | Todo el Worker de staging detrás de Access; en producción, como defensa en profundidad, solo `/api/v1/users*`; corregir la guía |
| F6-03 | Baja | El procedimiento deja el SQL del primer admin y el backup descargado dentro del árbol del repo; la contraseña puede quedar en el historial de PowerShell; la guía imprime los secretos | `docs/despliegue.md` §3, §5, §9.2; `.gitignore` | `git add -A` versiona hashes o el backup; historial con la contraseña | Salida fuera del repo, `.gitignore` para `primer-admin.sql` y `restaurar/`, contraseña con entrada oculta, secretos por tubería |
| F6-04 | Baja | La caché de TanStack Query no se vacía al cambiar de usuario | `apps/web/src/main.tsx`, `lib/query-client.ts`, `features/{admin,validacion}/api.ts` | Correos de la lista de usuarios del admin en memoria tras entrar otro usuario en la misma pestaña | `queryClient.clear()` al cambiar `usuario.id` |
| F6-08 | Baja | Los backups (hashes, correos, `payload_json`) están en el mismo bucket que las evidencias | `cron/backup.ts`, `wrangler.jsonc` | Una credencial para las fotos también lee los backups | Bucket propio `mp-backups-*` con su binding y regla de 90 días |
| F6-05 | Info | Ids de la URL sin `encodeURIComponent` en rutas de la API del jefe | `features/ordenes/api.ts`, `features/validacion/api.ts` | Path traversal del lado del cliente sin impacto encontrado | Codificar ids y validar UUID v7 |
| F6-06 | Info | Combinado con el bloqueo de cuenta, un tercero puede provocar el borrado del verificador offline de otro usuario (solo disponibilidad) | `apps/web/src/auth/sesion.ts`; ADR 0017 §4 | Pérdida del login offline hasta el siguiente login online | Aceptar en ADR |
| F6-07 | Info | Endurecimiento pendiente: lista de contraseñas comunes, `Cross-Origin-Opener-Policy`, retención solo al arrancar | `packages/shared/src/esquemas.ts`, `cabeceras.ts`, `app/arranque.ts` | — | Aplicar |
| F6-09 | Info | Con modales anidados, la pantalla de bloqueo puede perder el `inert` del fondo | `components/ui/CapaModal.tsx`, `PantallaBloqueo.tsx` | Un lector de pantalla alcanza el contenido bajo la capa opaca | `inert` como pila o reaplicado mientras el bloqueo esté visible |

## Estado de los hallazgos (lo actualiza el orquestador)

| # | Estado | Referencia |
|---|---|---|
| F6-01 | **Corregido en el repositorio**: acciones fijadas por SHA, `persist-credentials: false`, sin caché en el job con secretos, guía con cuenta/token sin alcance sobre producción y política de ramas. **Pendiente humano**: crear la cuenta o el token mínimo y configurar el environment | `a26e580`, `86a4aac`, `docs/pendientes-humanos.md` (16) |
| F6-02 | Corregido en la guía (Access sobre todo staging; en producción solo `/api/v1/users*`) | `86a4aac` |
| F6-03 | Corregido (secretos por tubería, contraseña con entrada oculta, SQL y backups fuera del repo, `.gitignore`) | `86a4aac`, `3c27abb` |
| F6-04 | Corregido (`queryClient.clear()` al cambiar de usuario) | `e7d61e4` |
| F6-05 | Corregido (`encodeURIComponent` y validación UUID v7) | `e7d61e4` |
| F6-06 | Riesgo aceptado | ADR 0017 (enmienda) |
| F6-07 | Corregido: COOP, lista de 194 contraseñas comunes (Worker y generador del primer admin), retención diaria y al cerrar sesión. Trusted Types diferido (justificado en `cabeceras.ts`) | `dcc0b6b`, `ac1a924`, `e7d61e4` |
| F6-08 | Corregido: bucket propio `mp-backups-*` (binding `BACKUPS`) | `dcc0b6b`, ADR 0014 (enmienda) |
| F6-09 | Corregido (`inert` como pila) | `e7d61e4` |

## 5. Riesgos residuales aceptados

PBKDF2 100.000 en el servidor (ADR 0007); verificador offline como oráculo si se extrae IndexedDB, mitigado por límites y MDM (ADR 0017 §7); integridad del outbox frente a quien controla el dispositivo (F4-07); `revocar` revela ids posteriores a una desasignación (F4-11); `instalacion_id` enviado por el cliente (F4-06); backups con hashes y datos personales 90 días en un bucket privado (ADR 0014); backup que no es foto de un instante (ADR 0014/0016); oráculos de existencia de ids (H-08); bloqueo de cuenta provocado por un tercero (ADR 0008; F6-06); separación de funciones novedad/aprobación (P23); retención de datos personales (P7).

## 6. Verificaciones en staging antes de producción

1. `pnpm audit --prod` y `pnpm audit` sin high/critical.
2. Cabeceras con `curl -sI`: `/`, `/sw.js`, `/manifest.webmanifest` y una ruta SPA con CSP, HSTS, `nosniff`, `X-Frame-Options` y `Cache-Control: no-cache`; `/api/v1/*` con `no-store`; `/assets/*.js.map` no se sirve.
3. Workers Logs sin trazas de invocación ni cabeceras `Authorization`/`Cookie`; sin `secretos_invalidos`.
4. POST con `Origin` ajeno → 403 `ORIGEN_INVALIDO`.
5. Cookie `mp_refresh` sobre HTTPS: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`.
6. 6.º intento de login en un minuto → 429; bloqueo tras 5 fallos auditado.
7. Staging detrás de Access; producción sin `*.workers.dev` ni preview URLs; buckets R2 sin `r2.dev` ni dominio público; regla de 90 días en `backups/`.
8. Cron a las 08:00 UTC con `cron_fin` y `manifest.json` al día siguiente; sin `backup_incompleto_del_dia`.
9. Simulacro de restauración (Time Travel + cambio de época; desde R2 a una D1 nueva): 34 triggers y `PRAGMA foreign_key_check` sin errores.
10. Tablet compartida: el login de B revoca la familia de A con `sesion.revocada_por_otro_inicio`.
11. Tablet real: bloqueo a los 10 minutos (también al volver de segundo plano), medición de PBKDF2 a 600k, política MDM.
12. Aviso de actualización de la PWA tras un despliegue nuevo.
13. GitHub: acciones por SHA, environment con política de ramas y revisores, token sin alcance sobre producción.
14. Primer admin: SQL borrado y contraseña fuera del historial.

## Fuentes citadas por el revisor

https://github.com/pnpm/setup · https://github.com/actions/checkout/releases · https://github.com/cloudflare/wrangler-action/releases · https://developers.cloudflare.com/workers/observability/logs/workers-logs/ · https://developers.cloudflare.com/workers/wrangler/configuration/ · https://blog.cloudflare.com/workers-protected-by-access/ · https://osv.dev/vulnerability/GHSA-w332-q679-j88p · https://github.com/advisories/GHSA-cw3j-28qq-x3xh

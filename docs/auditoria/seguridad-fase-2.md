# Revisión de seguridad — cierre de la Fase 2 (incluye la auth de la Fase 1)

- Revisor: `security-reviewer` (solo lectura), 2026-10-29, rama `build/v1`, base `89736c7`.
- Método: revisión estática de código, migraciones, configuración y pruebas (el revisor no ejecutó comandos; los gates y `pnpm audit --prod` los ejecutó el orquestador: ver `docs/evidencia/fase-2.md`).
- Alcance: `apps/worker/src/**`, `wrangler.jsonc`, `migrations/0000–0004`, `packages/shared/src/{esquemas,errores,permisos,reportes,consultas,dominio,uuid}.ts`, `scripts/{seed,gen-dev-vars,dev}.mjs`, `.gitignore`, `.dev.vars.example`, pruebas. Excluido: `/sync/*` (Fase 3), PWA (Fase 4), cron (Fase 6), contenido de `.dev.vars`.
- **Resultado: 0 críticos, 0 altos, 1 medio, 4 bajos, 8 informativos.**

## Hallazgos

| # | Sev. | Hallazgo | Evidencia | Escenario | Recomendación | Estado |
|---|---|---|---|---|---|---|
| H-01 | Media | TOCTOU en el bloqueo por intentos: con peticiones concurrentes (desde muchas IP) todas leen `bloqueado_hasta = NULL` y comparan el hash; el límite de 5 por 15 min no se cumple | `rutas/auth.ts:148-170` | N intentos simultáneos contra un correo → N comparaciones por ventana | Reservar el intento con `UPDATE … RETURNING` condicional **antes** del PBKDF2; reiniciar a 0 si la contraseña es correcta; prueba con 20 intentos concurrentes → exactamente 5 | Ver tabla de estado |
| H-02 | Baja | Enumeración de correos por tiempo: solo las cuentas activas y desbloqueadas hacen un batch de escritura al fallar | `rutas/auth.ts:157-170` | Medir latencias | Con H-01 la escritura ocurre para todo usuario existente; además tiempo mínimo uniforme en las 401 del login | Ver tabla |
| H-03 | Baja | `PATCH /users/:id` reescribe todas las columnas con lo leído: dos admins pueden reactivar sin querer a un usuario desactivado o borrar un bloqueo | `rutas/usuarios.ts:140-195` | Desactivación y renombre concurrentes | Actualizar solo los campos enviados, con guarda sobre lo leído; 409 `CONFLICTO`; separar `ULTIMO_ADMIN` | Ver tabla |
| H-04 | Baja | El jefe ve en `GET /audit` datos de administración (`users` con correos, `devices`, `refresh_tokens`) | `dominio/auditoria-consulta.ts:128-163` | `GET /audit?entidad=users` como jefe | Limitar `users`, `devices` y `refresh_tokens` a `admin.gestionar` (interpretación de la §3 en ADR) | Ver tabla |
| H-05 | Baja | Sin límite de tamaño de cuerpo JSON (incluido `/auth/login` sin autenticación) | `app.ts:58-69`, `validacion.ts:14-26` | JSON de decenas de MB repetido | `bodyLimit` 64 KB en `/api/v1/*` (salvo `PUT /evidences/:id`; `/sync/push` más grande en la Fase 3) | Ver tabla |
| H-06 | Info | `ORIGENES_DEV` se acepta en cualquier entorno | `middleware/origen.ts`, `wrangler.jsonc` | Despliegue sin `--env` | Aplicarlo solo si `ENTORNO === 'local'` y el origen es loopback; `workers_dev`/`preview_urls` en `false` en producción (Fase 6) | Ver tabla |
| H-07 | Info | No se valida en ejecución que `JWT_SECRET`/`REFRESH_SECRET` sean fuertes y distintos | `auth/tokens.ts` | Secreto corto cargado por error | Exigir ≥ 43 caracteres y distintos; si no, 500 y log; documentarlo en `despliegue.md` | Ver tabla |
| H-08 | Info | Oráculos de existencia de ids (`ID_DUPLICADO`, 404 vs 403) | `dominio/consumos.ts`, `novedades.ts`, `validaciones.ts`, `rutas/evidencias.ts` | UUID v7 con 74 bits aleatorios: no adivinables | Sin cambio en el servidor; el cliente genera UUID v7 con `crypto.getRandomValues` (verificado en `packages/shared/src/uuid.ts`) | Aceptado |
| H-09 | Info (negocio) | Un mismo jefe puede registrar la novedad que exige S7 y luego aprobar | `dominio/novedades.ts`, `validaciones.ts` | Saltarse el control "falta justificar" con rastro en auditoría | Decisión de negocio → `preguntas-abiertas.md` (P23) | Pregunta abierta |
| H-10 | Info | En el logout la cookie manda sobre el Bearer aunque sean de usuarios distintos (tablet compartida) | `rutas/auth.ts:269-303` | Logout de A revoca la sesión de B | Si `fila.user_id ≠ claims.sub`, revocar la familia del Bearer (y la de la cookie) | Ver tabla |
| H-11 | Info (Ley 1581) | Correo copiado en la auditoría inmutable; fotos con EXIF posible | `auditar.ts:18-40`; `rutas/evidencias.ts` | Supresión/rectificación imposible en la auditoría | Quitar `email` de la lista blanca de auditoría de `users`; la PWA recodifica las fotos sin EXIF (Fase 4); retención (P7) | Ver tabla |
| H-12 | Info | No se comprueba el `tamano_bytes` declarado de una evidencia | `dominio/evidencias.ts:147-166` | Metadato falso (el sha256 ya ata el contenido) | Comparar `byteLength` con `tamano_bytes` → `VALIDACION` | Ver tabla |
| H-13 | Info | `scripts/dev.mjs` no limpia `CLOUDFLARE_*` del entorno (sí lo hace `seed.mjs`) | `scripts/dev.mjs:34` | `CLOUDFLARE_ENV=production` en la shell carga la configuración de producción en local | Eliminar `CLOUDFLARE_ENV`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` del entorno | Ver tabla |

## Estado de los hallazgos (lo actualiza el orquestador)

| # | Estado | Commit / referencia |
|---|---|---|
| H-01, H-02, H-03, H-04, H-05, H-06, H-07, H-10, H-11 (correo), H-12, H-13 | En corrección (tarea 2.8) | — |
| H-08 | Aceptado: UUID v7 con CSPRNG | `packages/shared/src/uuid.ts` |
| H-09 | Pregunta abierta P23 | `docs/preguntas-abiertas.md` |
| H-11 (EXIF) | Fase 4 (recodificación en la PWA) | — |

## Aspectos verificados sin hallazgos (resumen)

JWT con algoritmo fijado, `iss`/`aud`/`exp` y sin rol para autorizar; sesión por petición con rol actual y familia vigente; rotación atómica de refresh con detección de reutilización y gracia condicional de 30 s; cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`; `token_hash` HMAC único; PBKDF2 100.000 con `timingSafeEqual` y derivación ficticia; revocación al cambiar rol/contraseña y protección del último admin; rate limiting IP+correo; CSRF por `Origin` en toda petición que cambia estado y sin CORS; SQL siempre parametrizado (fragmentos `${}` solo constantes); asignación masiva bloqueada (Zod descarta claves, el servidor fija autoría, estado, versión, costo, dispositivo; triggers de respaldo); BOLA/IDOR cubierto en órdenes, consumos, novedades, evidencias, validaciones, auditoría, reportes y usuarios; autoaprobación bloqueada en Worker, SQL y trigger; guardas contra TOCTOU en tolerancia, estado de orden, asignaciones, versión y subida; evidencias por magic bytes (sin SVG/HTML), 5 MB en streaming, sha256, clave de R2 derivada en el servidor, GET con `Content-Type` fijo, `nosniff`, `inline`, `private, no-store`; cabeceras de seguridad en todas las respuestas; errores sin detalles internos y logs sin datos personales; CSV con BOM y neutralización de fórmulas; auditoría en el mismo batch con lista blanca; secretos como `secrets.required`, `.dev.vars` ignorado, scripts locales que rechazan lo remoto.

## Dependencias de producción del Worker

`hono 4.13.14`, `@hono/zod-validator 0.9.1`, `jose 6.2.13`, `zod 4.6.7`, `drizzle-orm 0.45.4` (solo esquema). `pnpm audit --prod` (ejecutado por el orquestador): "No known vulnerabilities found".

## Ley 1581 — datos personales

| Dato | Dónde | Necesidad |
|---|---|---|
| Nombre y correo | `users` (y el correo en `audit_log`, ver H-11) | Necesario para autenticar y trazar; la copia del correo en la auditoría sobra |
| Nombre de dispositivo, `user_agent`, `instalacion_id` | `devices` | "Desde qué dispositivo" (spec §1) |
| IP | No se guarda (solo clave efímera del limitador) | Correcto |
| Fotos | R2 | Necesarias; posible EXIF (H-11); retención P7 |
| Correos de intentos sobre cuentas inexistentes | No se auditan | Correcto |

## Pendiente para fases siguientes

- Fase 3/4: revisar `/sync/*` (autor vs `sub`, idempotencia por usuario, revocación), recodificación de fotos sin EXIF y que el Service Worker no cachee `/api/*`.
- Fase 6: confirmar si los *invocation logs* de Workers registran `Authorization`/`Cookie`; `workers_dev`/`preview_urls` en `false`; secretos de 32 bytes.

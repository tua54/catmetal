# Revisión de seguridad — cierre de la Fase 4 (PWA del supervisor y protocolo `/sync/*`)

- Revisor: `security-reviewer` (solo lectura), 2026-10-29, rama `build/v1` sobre `a9681a5` más el árbol de trabajo de las pantallas de jefe y admin (revisadas solo por sumideros XSS y `blob:`).
- Método: revisión estática de código, configuración, build (`apps/web/dist`) y E2E. El revisor no ejecutó comandos; `pnpm audit --prod` y los gates los ejecuta el orquestador (`docs/evidencia/fase-4.md`).
- Alcance: cliente (`apps/web/src/{auth,datos,sync,pwa,app,rutas,pages/comunes,features/consumos,features/validacion}`, `vite.config.ts`, `index.html`, `dist/`), servidor de sync (`apps/worker/src/sync/*`, `rutas/sync.ts`, `middleware/limite-cuerpo.ts`, `cabeceras.ts`, `app.ts`), E2E.
- **Resultado: 0 críticos, 0 altos, 2 medios, 3 bajos, 7 informativos.**

## Hallazgos

| # | Sev. | Hallazgo | Evidencia | Escenario | Recomendación | Estado |
|---|---|---|---|---|---|---|
| F4-01 | Media | Sesión abandonada en tablet compartida: `restaurar()` adopta sin contraseña la sesión de la cookie (30 días) y no hay bloqueo por inactividad | `auth/sesion.ts:397-444` | A deja la tablet sin cerrar sesión; B registra con autoría de A | Bloqueo por inactividad (10 min y al volver de segundo plano) con confirmación de identidad contra el verificador local; no publicar la sesión adoptada si el último acceso es viejo | Ver estado |
| F4-02 | Media | Login offline sin límite de intentos; el verificador es un oráculo de la contraseña del servidor (la ADR 0012 decía lo contrario); se crea verificador también para admin | `auth/sesion.ts:279-343`, `verificador.ts:10`, ADR 0012 | Tablet robada en modo avión: intentos ilimitados por la UI; con IndexedDB extraído, diccionario contra PBKDF2 600k; la contraseña hallada entra al servidor | Contador local con espera creciente desde el 5.º fallo y borrado del verificador al 10.º; sin verificador para admin; corregir la ADR 0012; política MDM (pendiente humano) | Ver estado |
| F4-03 | Baja | El verificador no se invalida cuando el servidor deja de aceptar al usuario | `auth/sesion.ts:283-286,376-379` | Ex-empleado desactivado sigue entrando offline | Ante 401 `CREDENCIALES_INVALIDAS` con una contraseña que el verificador acepta → borrar el verificador | Ver estado |
| F4-04 | Baja (Ley 1581) | Perfiles y particiones de usuarios que no vuelven sin caducidad; el login muestra correos completos sin autenticar | `auth/sesion.ts:498`, `sync/motor.ts:327`, `pages/comunes/LoginPage.tsx:199-213` | Tablet extraviada expone nombres, correos y datos de operación | Purga de retención en todas las particiones al arrancar; caducar perfiles sin acceso en 30 días y sin pendientes; correo enmascarado en el login | Ver estado |
| F4-05 | Baja | Carrera entre cambio de sesión y motor de sync (token tomado tras la verificación; reintento tras 401 con cualquier sesión; `cerrarSesion` no espera a la sync) | `auth/cliente-api.ts:181-191`, `sync/motor.ts`, `auth/sesion.ts:476-510` | Datos de B guardados en la partición de A, o remanencia tras el cierre | Token ligado al usuario del lote, sin auto-refresh ajeno; re-verificar la sesión tras cada `await` de red; `cerrarSesion` toma el candado de sync | Ver estado |
| F4-06 | Info | `cierre_pendiente` se pierde si otro usuario inicia sesión antes de rearrancar | `auth/sesion.ts:397-405,491` | Familia de A activa hasta vencer | Al iniciar sesión con un `instalacion_id`, revocar las familias activas de otros usuarios con ese `instalacion_id` (auditado) | Ver estado |
| F4-07 | Info | Integridad del outbox frente a quien controla el dispositivo (DevTools/USB) | `datos/outbox.ts:155-180`, `auth/verificador.ts:98-105` | Requiere acceso local | Riesgo aceptado (ADR 0017); mínimo de iteraciones aceptadas en el verificador; MDM | Ver estado |
| F4-08 | Info | Sourcemaps públicos en producción | `apps/web/vite.config.ts:92` | Exposición del código fuente | `sourcemap: 'hidden'` y no subir `*.map` | Ver estado |
| F4-09 | Info | Workbox en `devDependencies` aunque se empaqueta en `sw.js` | `apps/web/package.json` | `pnpm audit --prod` no lo cubre | Moverlo a `dependencies` | Ver estado |
| F4-10 | Info | `Cache-Control` de `/sw.js`, `index.html` y el manifest sin fijar ni probar | `apps/worker/src/cabeceras.ts:52-54` | Actualizaciones retenidas por caché | `Cache-Control: no-cache` explícito y prueba de integración | Ver estado |
| F4-11 | Info | `revocar` de entidades creadas después de la desasignación revela el ritmo de actividad de una orden ajena | `sync/pull.ts:133`, `sync/entidades.ts:275-283` | Ex-asignado ve actividad (solo ids) | Riesgo aceptado (ADR 0017) | Ver estado |
| F4-12 | Info (integridad de datos) | Tras un login offline, la sesión no pasa a online al volver la red: los pendientes no salen hasta volver a entrar | `sync/motor.ts:284`, `sync/index.ts:59-64`, `components/layout/AvisosSesion.tsx` | Retraso de envío y riesgo de pérdida | En `online`/`visible` con modo offline, intentar `refrescar()`; E2E "login offline → reconectar → sincroniza" | Ver estado |

## Estado de los hallazgos (lo actualiza el orquestador)

| # | Estado | Referencia |
|---|---|---|
| F4-01, F4-02, F4-03, F4-04, F4-05, F4-08, F4-09, F4-12 | **Corregidos** con pruebas (`apps/web/src/auth/{sesion-seguridad,inactividad}.test.ts`, `sync/motor-seguridad.test.ts`, `datos/retencion.test.ts`, `components/layout/PantallaBloqueo.test.tsx`) | `c6b442b`, ADR 0017 |
| F4-06, F4-10 | **Corregidos** con pruebas (`apps/worker/test/auth-instalacion.test.ts`, `handlers.test.ts`) | `c7b855e` |
| F4-06 (riesgo residual) | El `instalacion_id` lo envía el cliente: quien conozca el de otro navegador y tenga credenciales válidas podría cerrar sesiones allí; es un UUID v7 aleatorio que solo ve el admin. Aceptado | ADR 0017 |
| F4-07, F4-11 | Riesgo aceptado | ADR 0017 |

## Aspectos verificados sin hallazgos (resumen)

Partición por usuario en todas las consultas de Dexie y en el push (cliente y servidor, E2E de tablet compartida); access token solo en memoria; refresh serializado y sin adoptar sesiones de otro usuario; logout con Bearer; login offline con PBKDF2-SHA256 600.000, sal propia, comparación de tiempo constante, caída a offline solo ante red/5xx y revalidación al reconectar; Service Worker sin `/api` en precache ni en runtime, sin token, mensajes solo del mismo origen, actualización con aviso; CSP sin inline, sin sumideros XSS en todo `apps/web/src`, URLs `blob:` revocadas; fotos recomprimidas a JPEG sin EXIF (E2E), límites de número y tamaño, magic bytes en el servidor; `/sync/*` con autor = `sub`, `did`, época, idempotencia ligada al usuario, visibilidad por rol en pull y snapshot, usuarios sin correo, topes de tamaño; guardas de rutas solo de presentación (el servidor revalida todo).

## Dependencias del cliente

`react`/`react-dom` 19.3.1, `react-router` 7.18.5 (modo librería), `@tanstack/react-query` 5.105.0, `dexie` 4.4.7, `zustand` 5.0.16, `zod` 4.6.7, `react-hook-form` 7.91.0, `@hookform/resolvers` 5.9.2, `workbox-window` 7.4.1, `@fontsource/poppins` 5.3.0, `browser-image-compression` 2.0.2 (sin versiones desde 2023: vigilar mantenimiento). `pnpm audit --prod`: ver evidencia.

## Ley 1581 — datos en la tablet

| Dato | Tabla Dexie | Retención (tras la tarea 4.7) |
|---|---|---|
| Nombre, correo, rol, permisos y verificador de cada usuario que entró | `perfiles` | Hasta 30 días sin acceso y sin pendientes |
| Nombres de jefes, admins y co-supervisores | `usuarios`, `asignaciones` | Hasta el logout sin pendientes |
| Consumos y novedades | `consumos`, `novedades` | Propios: 30 días; ajenos: hasta el logout |
| Fotos propias | `evidencias.datos` | 30 días tras subirse |
| Correos de otros usuarios | — | No llegan por sync |

## Pendiente para la Fase 6

Medir en la tablet real la derivación PBKDF2 y el tiempo por intento offline; lista de contraseñas comunes en `passwordSchema` y política MDM; comprobar en staging el `Cache-Control` real; retención de `payload_json`/`respuesta_json` en el servidor (P7); endurecimiento opcional (`Cross-Origin-Opener-Policy`, Trusted Types); revisión completa de las pantallas de jefe y admin y de Cloudflare Access para `/admin`; volver a revisar F4-01 a F4-05 corregidos.

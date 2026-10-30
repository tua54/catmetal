# Evidencia — Fase 4: PWA del supervisor

Fecha: 2026-10-29. Ejecutado por el orquestador en Windows 11, Node 24.18.0, pnpm 12.16.1, rama `build/v1`, commit `6147a8f`.

## Gates

| Comando | Código | Resumen |
|---|---|---|
| `pnpm lint` | 0 | Sin errores (incluye `e2e/` y `scripts/`) |
| `pnpm typecheck` | 0 | shared, worker (`wrangler types --check`), web (+ Service Worker) y `e2e/` |
| `pnpm test` | 0 | 1.859 pruebas: shared 209 (100 % líneas), web 485, worker 1.165 (97,86 % líneas) |
| `pnpm format:check` | 0 | Sin diferencias |
| `pnpm test:e2e` | 0 | **25/25**: Chromium 18, WebKit 7 (`@humo`), 1,6 min con build. También 2 corridas seguidas estables en las tareas 4.4b y 5.4 |
| `pnpm audit --prod` | 0 | Sin vulnerabilidades conocidas |

## Criterios de aceptación (§10, Fase 4)

| Criterio | Estado | Prueba |
|---|---|---|
| Shell PWA instalable servido por el Worker | Cumplido (instalabilidad automatizada completa en la Fase 6) | `e2e/service-worker.spec.ts` (SW registrado, activo, controla la página, shell offline), manifest con íconos 192/512/maskable (`apps/web/public/icons`) |
| Login offline | Cumplido | `e2e/login-offline.spec.ts` (Chromium y WebKit); `apps/web/src/auth/*.test.ts` |
| Pantallas del supervisor con la identidad de Catmetal e indicador de sync | Cumplido | `apps/web/src/pages/supervisor/supervisor.test.tsx`, `components/layout/AppLayout.test.tsx`, ADR 0011 |
| E2E Chromium: con la red cortada se registran 3 consumos (uno con foto) y al reconectar los 3 quedan en D1 y la foto en R2 | Cumplido | `e2e/registro-offline.spec.ts` (verificado por la API del jefe y `GET /evidences/:id` con JPEG sin EXIF) |
| E2E de tablet compartida: los pendientes de A no se envían con la sesión de B | Cumplido | `e2e/tablet-compartida.spec.ts` (cuerpos de todos los push de B inspeccionados; A los envía después con su autoría) |
| Humo en WebKit | Cumplido | 7 pruebas `@humo` (login, sesión, SW, login offline, registro con conexión). Limitación documentada: WebKit no envía la cookie `Secure` por `http://localhost`, así que una recarga completa pierde la sesión en línea |
| Revisión de seguridad | Cumplido | `docs/auditoria/seguridad-fase-4.md`: 0 críticos, 0 altos; 2 medios y bajos corregidos (`c6b442b`, `c7b855e`), ADR 0017 |

## Medidas

- Login offline (verificador PBKDF2-SHA256 600.000): Chromium ~0,26–0,31 s, WebKit ~1,2–2,1 s (PC de desarrollo; falta la tablet real: pendiente humano).
- Sincronización al reconectar (3 consumos + novedad + foto): ~0,9–1,4 s en local.
- Build de la PWA: precache de 23 entradas (~970 KiB), fragmentos por rol (supervisor, jefe, admin), `index.html` sin inline, sourcemaps ocultos y excluidos de los assets (`.assetsignore`).

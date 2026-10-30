# Evidencia — Fase 6: Endurecimiento y despliegue

Fecha: 2026-10-29/30. Ejecutado por el orquestador en Windows 11, Node 24.18.0, pnpm 12.16.1, rama `build/v1`, commit `e7d61e4` (código) / `b027d58` (Lighthouse).

## Gates finales

| Comando | Código | Resumen |
|---|---|---|
| `pnpm lint` | 0 | Sin errores |
| `pnpm typecheck` | 0 | shared, worker (`wrangler types --check`), web (+ Service Worker) y `e2e/` |
| `pnpm test` | 0 | **1.926 pruebas**: shared 214 (100 % líneas), web 534, worker 1.178 (97,78 % líneas, 91,9 % ramas) |
| `pnpm format:check` | 0 | Sin diferencias |
| `pnpm test:e2e` | 0 | **33/33** (Chromium 26, WebKit 7 `@humo`), 3,0 min con build |
| `pnpm test:lighthouse` | 0 | Todas las URLs ≥ 90 (tabla abajo) |
| `pnpm audit --prod` | 0 | **Sin vulnerabilidades conocidas** |
| `pnpm audit` (incluye desarrollo) | 1 | 1 moderada y 1 baja, **solo en herramientas de desarrollo/build**, ninguna alta ni crítica (ver abajo) |

### `pnpm audit` de desarrollo

| Severidad | Paquete | Ruta | Impacto en este proyecto |
|---|---|---|---|
| Moderada | `esbuild` ≤ 0.24.2 (GHSA del servidor de desarrollo) | `drizzle-kit` → `@esbuild-kit/*` → `esbuild` | Solo afecta al servidor de desarrollo de esbuild, que este proyecto no usa (drizzle-kit solo genera SQL). No llega al Worker ni a la PWA |
| Baja | `deepmerge` 4.2.0–4.3.1 (sin versión corregida) | `vite-plugin-pwa` → `workbox-build` → `@rollup/plugin-node-resolve` | Solo en el build, con entradas de configuración propias. No llega a producción |

Ninguna requiere ADR (la regla aplica a high/critical).

## Lighthouse (perfil de tablet, mediana de 3 corridas)

Chromium de Playwright, viewport 1180×820 táctil, throttling móvil simulado (RTT 150 ms, 1,6 Mbps, CPU ×4). Resumen completo: `docs/evidencia/lighthouse/resumen.json`.

| URL | Performance | Accessibility | Best Practices | LCP (ms) | TBT (ms) | CLS |
|---|---|---|---|---|---|---|
| Login (sin sesión) | 91 | 100 | 96 | 2.650 | 283 | 0 |
| Supervisor · Mis órdenes | 93 | 100 | 100 | 659 | 313 | 0,002 |
| Supervisor · Registro de consumo | 92 | 100 | 100 | 656 | 354 | 0,002 |
| Estado de sincronización | 98 | 100 | 100 | 697 | 170 | 0,003 |
| Jefe · Validación de consumos | 94 | 100 | 100 | 754 | 299 | 0,002 |
| Admin · Usuarios | 92 | 100 | 100 | 802 | 339 | 0,002 |

El TBT varía bastante entre corridas (p. ej. 78–94 en una misma URL antes de la mediana); el margen sobre 90 en Performance es estrecho. Medición en PC de desarrollo, no en la tablet real.

## Criterios de aceptación (§10, Fase 6)

| Criterio | Estado | Prueba / evidencia |
|---|---|---|
| Errores, estados vacíos, accesibilidad, rendimiento en tablet | Cumplido | Tarea 6.2 (`04439b0`); `e2e/accesibilidad.spec.ts` (axe WCAG 2.1 AA sin serious/critical en 7 pantallas); pruebas de estados de error/vacío/foco en `apps/web` |
| Cron de backup a R2 y cabeceras de seguridad | Cumplido | `apps/worker/test/fase6-cron-*.test.ts` (D1 y R2 locales; bucket propio de backups); `handlers.test.ts`, `fase2-transversal-*` (cabeceras, incluido COOP y `no-cache`) |
| `docs/despliegue.md` con comandos exactos para crear D1/R2/KV y la regla de ciclo de vida, migraciones remotas, secretos, desplegar y restaurar | Cumplido | `docs/despliegue.md` (verificado contra la documentación oficial y Wrangler 4.156.0; comando de cambio de época probado en local) |
| Workflow `deploy-staging.yml` solo manual | Cumplido | `.github/workflows/deploy-staging.yml` (`workflow_dispatch`, environment protegido, acciones por SHA) |
| Instalabilidad PWA verificada con prueba automatizada (manifest, SW que controla, arranque offline de `start_url`) | Cumplido | `e2e/pwa-instalabilidad.spec.ts` (incluye `Page.getInstallabilityErrors` vacío con control negativo) |
| Lighthouse tablet ≥ 90 en Performance, Accessibility y Best Practices | Cumplido | `pnpm test:lighthouse`, tabla anterior |
| Prueba del cron de backup contra R2 local | Cumplido | `fase6-cron-backup`, `-continuacion`, `-mantenimiento`, `-multipart` |
| Checklist de despliegue completo | Cumplido | `docs/despliegue.md` §12 |
| Revisión de seguridad final | Cumplido | `docs/auditoria/seguridad-fase-6.md`: 0 críticos, 0 altos; el medio (F6-01) corregido en el repositorio con su parte humana en pendientes; bajos e informativos corregidos o aceptados |
| Ningún comando remoto ejecutado | Cumplido | Todos en `docs/pendientes-humanos.md` y `docs/despliegue.md` |

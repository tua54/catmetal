# Plan — Fase 5: PWA del jefe y del admin

Referencia: `docs/spec.md` §3, §8 (Jefe y Admin), §10 (Fase 5); `docs/diseno/README.md` (Jefe · Validación de Consumos); ADR 0010 (validación con versión), 0011 (visual), 0013 (alcance de auditoría).

**Criterio de cierre (§10):** E2E: el supervisor registra → el jefe rechaza → el supervisor ve el motivo y corrige → el jefe aprueba; todo visible en la auditoría. El jefe no puede aprobar un consumo propio ni uno con `requiere_novedad`. Gates con `pnpm test:e2e`.

## Tareas

| Id | Tarea | Responsable | Archivos | Depende | Aceptación |
|---|---|---|---|---|---|
| 5.1 | **Jefe · Validación de consumos** (Figma): cola por orden con filtros (orden, supervisor, con novedad), chip "N pendientes", tarjeta por consumo (material, cantidad, supervisor, hora, "Con novedad"), bloque ámbar con la justificación y enlace a la evidencia que abre `VisorImagen` (descarga autenticada con el token, `blob:`), botones "✓ Validar gasto" (confirmación) y "Rechazar" (motivo obligatorio). "Validar" deshabilitado con explicación si `requiere_novedad` sin novedad o si es propio ("Registrado por usted: requiere otro jefe"). Envía la `version` vista; 409 → refresca y explica. Con conexión usa la API REST; sin conexión encola `consumo.aprobar/rechazar` por el outbox (S5) | `react-developer` | `apps/web/src/pages/jefe/**`, `src/features/validacion/**` | Fase 4 | Pruebas de componentes y flujos |
| 5.2 | **Jefe · Orden**: resumen (materiales consumidos, costo total en COP, novedades abiertas en ámbar, estado), línea de tiempo completa (`LineaTiempo` con colores por actor), gestión de órdenes (listar, crear con materiales planeados, iniciar, finalizar con confirmación y `force` explícito si hay pendientes), exportar CSV | `react-developer` | `apps/web/src/pages/jefe/ordenes/**` | 5.1 | Pruebas |
| 5.3 | **Admin**: usuarios (crear, cambiar rol, desactivar/reactivar, desbloquear, restablecer contraseña; nunca borrar; aviso de último admin), materiales (crear, editar costo/nombre, activar/desactivar), asignación de supervisores a órdenes, tolerancia | `react-developer` | `apps/web/src/pages/admin/**` | Fase 4 | Pruebas |
| 5.4 | **E2E** del flujo completo rechazo → corrección → aprobación con verificación en la auditoría (línea de tiempo), jefe no aprueba propio ni con `requiere_novedad` (UI y API), y admin crea un supervisor y lo asigna | `test-engineer` | `e2e/fase5-*.spec.ts` | 5.1–5.3 | Chromium en verde (y humo WebKit intacto) |
| 5.5 | Evidencia y cierre | orquestador | `docs/evidencia/fase-5.md` | todo | — |

# Preguntas abiertas

Cada pregunta lleva el **supuesto aplicado** mientras el cliente no responda. Los supuestos son los más conservadores posibles: no perder datos de planta y no dar más permisos de los necesarios.

## De la especificación (sección 12)

| # | Pregunta | Supuesto aplicado en la v1 |
|---|---|---|
| P1 | S9: ¿qué pasa si solo hay un jefe y él registra consumos? ¿Puede el admin validar en ese caso? | El admin **no** valida (tabla de permisos). El consumo queda pendiente hasta que lo valide otro jefe. La cola del jefe lo muestra como "Registrado por usted: requiere otro jefe". |
| P2 | S10: ¿cómo se corrige un consumo ya aprobado que resultó erróneo? | No se corrige en la v1. El servidor rechaza `corrige_a` que apunte a un consumo que no esté `rechazado` (código `CORRECCION_INVALIDA`). |
| P3 | ¿El jefe puede editar sus propios consumos pendientes? | No (la tabla de permisos dice ❌). Responde `PERMISO_DENEGADO`. |
| P4 | S11: ¿hay otras conversiones de unidades necesarias, por ejemplo densidades l↔kg para resinas? | Solo `kg↔g` y `l↔ml`. Cualquier otra combinación con el plan responde `UNIDAD_INCOMPATIBLE`. |
| P5 | ¿Cuántas tablets y usuarios hay por turno? ¿Las tablets se comparten entre turnos? | Se asume tablet compartida entre turnos (el caso más exigente) y se implementan las reglas de la sección 5. |
| P6 | ¿Se requiere firma o PIN adicional para que el jefe apruebe? | No. Se pide una confirmación en pantalla y se registra en auditoría con usuario, dispositivo y hora. |
| P7 | Retención de datos personales y de evidencias (Ley 1581 de 2012). | No se borra nada desde la app (regla de trazabilidad). Los backups en R2 se retienen 90 días. La retención de evidencias y datos personales queda pendiente de definición del cliente; ver `docs/despliegue.md`. |
| P8 | ¿Se deben importar órdenes o materiales desde un ERP existente? | No en la v1. Se crean desde la app (admin y jefe). |

## Detectadas por el orquestador

| # | Pregunta | Supuesto aplicado en la v1 |
|---|---|---|
| P9 | ¿Un supervisor ve los consumos de otros supervisores en la misma orden? | Sí, en lectura, para las órdenes que tiene asignadas (lo necesita para ver planeado vs consumido). Solo edita los suyos pendientes. La auditoría detallada solo de lo propio. |
| P10 | ¿Qué pasa con un consumo de un material que no está en el plan de la orden? | Se acepta (no se pierde el dato de planta), sin comparación con el plan: `cantidad_en_unidad_plan` = `cantidad` en la unidad del material, y se marca `requiere_novedad = 1` para que se justifique. |
| P11 | ¿La tolerancia es global o por material/orden? | Global (`settings.tolerancia_pct`), como dice S7. |
| P12 | ¿El jefe puede registrar consumos en cualquier orden o solo en las que supervisa? | En cualquier orden en proceso (la tabla de permisos dice ✅ sin restricción). |
| P13 | ¿Puede un supervisor registrar consumos en una orden `planeada` (no iniciada)? | No: responde `ORDEN_NO_EN_PROCESO`. Las órdenes `finalizada` o `cancelada` sí aceptan registro tardío (regla de conflicto de la sección 6). |
| P14 | ¿Cuántas evidencias por novedad? | Hasta 5 fotos por novedad, 5 MB cada una. |
| P15 | ¿Se puede agregar una novedad a un consumo que ya tiene una? | Sí, se permiten varias novedades por consumo (la tabla `incidents` lo admite). Para aprobar basta con al menos una. |
| P16 | ¿Las órdenes canceladas se pueden reabrir? | No en la v1. No hay endpoint para cancelar en la spec: se añade `POST /orders/:id/cancel` (jefe/admin) solo si se necesita; por ahora no se expone. |
| P17 | Política de contraseñas. | Mínimo 10 caracteres. Sin reglas de composición (NIST SP 800-63B). |

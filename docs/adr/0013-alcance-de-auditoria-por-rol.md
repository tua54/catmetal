# ADR 0013 — Alcance de la auditoría por rol y datos personales en la auditoría

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 2

## Contexto

La §3 de la spec dice "Ver auditoría: Supervisor solo lo propio · Jefe ✅ · Admin ✅". La revisión de seguridad de la Fase 2 (H-04, H-11) mostró que, leído literalmente, el jefe ve en `GET /audit` el directorio de usuarios con correos, el estado de bloqueo de las cuentas y las sesiones y dispositivos de todos, incluidos los administradores, aunque `GET /users` es solo de admin. Además, el correo se copia en la auditoría inmutable, lo que impide atender una rectificación o supresión (Ley 1581, art. 8).

## Opciones consideradas

1. Jefe ve toda la auditoría (lectura literal).
2. Jefe ve toda la auditoría **de negocio** (órdenes, asignaciones, plan, materiales, settings, consumos, novedades, evidencias, validaciones); las entidades de administración de identidades (`users`, `devices`, `refresh_tokens`) quedan para `admin.gestionar`.

## Decisión

Opción 2. Es la interpretación más conservadora de la §3: la trazabilidad de negocio ("quién, qué, cuándo y desde qué dispositivo") la sigue viendo el jefe completa, porque cada fila de negocio lleva `actor` (nombre y rol) y `device_id`; lo que se restringe son los datos de administración de cuentas. Además, la lista blanca de la auditoría de `users` **no copia el correo** (se conservan id, nombre, rol, activo y estado de bloqueo).

## Consecuencias

- `GET /audit` y `GET /orders/:id/audit` filtran `entidad NOT IN ('users','devices','refresh_tokens')` para quien no tiene `admin.gestionar`.
- Las filas de auditoría de `users` escritas antes de este cambio (seed y pruebas locales) pueden contener el correo; en producción no habrá ninguna.

## Cómo revertir

Quitar el filtro en `dominio/auditoria-consulta.ts` y volver a añadir `email` a la lista blanca de `users` en `auditoria/auditar.ts`.

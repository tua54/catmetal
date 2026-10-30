# ADR 0029 — Token de página del snapshot ligado al usuario y al rol, y purga del área temporal

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.2 (ítem A6)
- Enmienda: ADR 0022 (área temporal del snapshot) y la revisión S-03 de las correcciones v1.1 (purga de datos ajenos al perder visibilidad)

## Contexto

S-03 hizo que la tablet borre los datos de órdenes que el usuario ya no ve (`purgarAjenosSinVisibilidad`, `apps/web/src/datos/visibilidad.ts`). Pero el snapshot `inicial` se descarga a un área temporal (ADR 0022) que puede quedar a medias y reanudarse después con `siguiente_pagina`:

1. El área temporal no se purga: guarda páginas descargadas cuando el usuario sí veía esas órdenes, y `completarSnapshot` las vuelve a meter en el estado vivo.
2. El token de página (`apps/worker/src/sync/snapshot.ts`) es `{ version, cursor, entidad, ultimo_id }` en base64url. No dice para quién se emitió: una descarga empezada con un rol (jefe) se puede continuar después de un cambio de rol o de usuario, y el área temporal termina mezclando dos alcances.

## Opciones consideradas

1. **Solo purgar en el cliente.** Cubre el caso 1, pero no impide reanudar con un token de otro alcance si el cliente (o una pestaña vieja) no purga.
2. **Solo verificar en el servidor.** No borra lo que ya está en el área temporal.
3. **Las dos.** Defensa en profundidad.
4. **Firmar el token (HMAC).** No aporta: el servidor filtra cada página con la visibilidad **actual** del actor, así que falsificar el token no da acceso a nada. Lo que importa es que no se mezclen alcances en el cliente, y para eso basta con verificar que el token es del mismo usuario y rol.

## Decisión

Se adopta la opción 3, sin firma.

1. **Cliente.** `purgarAjenosSinVisibilidad` descarta también el área temporal del usuario (`snapshot_entidades` y `snapshot_progreso`) **en la misma transacción** de Dexie. La próxima sync empieza el snapshot de cero.
2. **Servidor.** El token de página incluye `user_id` y `rol` del actor que lo pidió. Al continuar, el servidor exige que coincidan con los de la sesión actual. Un token sin esos campos (emitido por un servidor anterior) o de otro usuario o rol se rechaza con el mismo error que un token inválido (400 `VALIDACION`, campo `pagina`). Los clientes v1.1 ya tratan ese rechazo empezando el snapshot de cero una vez (ADR 0022, punto 3); se verifica con una prueba.
3. El cambio de formato es interno al token, que es opaco para el cliente: no hay cambio de contrato.

## Consecuencias

- Tras perder visibilidad, nada de lo descargado antes vuelve al estado vivo.
- Una descarga a medias en el momento de desplegar la v1.2 se reinicia una vez.
- El token sigue sin firma: es opaco por convención, no por criptografía. Se acepta porque no controla acceso.

## Cómo revertir

Quitar los campos del token y su verificación, y la llamada que descarta el área temporal en la purga.

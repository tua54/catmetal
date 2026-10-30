# ADR 0027 — Bloqueo de la app tras una revocación del servidor

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (hallazgos S-03 y S-09 de `docs/auditoria/seguridad-correcciones.md`)
- Enmienda: ADR 0017 (bloqueo por inactividad y límites offline) y ADR 0023 (sesión entre pestañas)

## Contexto

Cuando el servidor revoca la sesión con `SESION_REVOCADA` (por un cambio de rol, una desactivación o un restablecimiento), la pestaña olvidaba el token pero conservaba el perfil y los permisos anteriores, y la UI solo mostraba un aviso. La partición seguía visible, incluidos los consumos ajenos que veía un jefe. Además, un usuario desactivado podía seguir entrando sin conexión con su verificador local (S-09). Por otro lado, tras bajar de rol, los datos ajenos quedaban en la tablet hasta que terminaba el snapshot (S-03).

## Opciones consideradas

1. **Solo un aviso**, como en la v1. No protege la tablet compartida.
2. **Borrar toda la partición** ante una revocación. Pierde datos de planta pendientes. Descartado.
3. **Bloquear la app hasta un login en línea, y purgar solo lo ajeno sin pendientes cuando el perfil nuevo pierde visibilidad.**

## Decisión

Se adopta la opción 3.

1. **Revocación en una petición autenticada** (bearer `SESION_REVOCADA`), con `marcarSesionRevocada()` en `apps/web/src/auth/sesion.ts`:
   - olvida el token y aborta la sync en vuelo;
   - publica `bloqueada: true` y `revocada: true`;
   - persiste `perfiles.requiere_login_online = true`, un campo no indexado, sin cambio de esquema Dexie;
   - emite `bloqueo` por el canal de sesión. Las demás pestañas leen la marca y también quedan revocadas.
2. **Desbloqueo solo en línea.** Con la marca puesta, `confirmarIdentidad` y el login sin conexión se rechazan: el verificador local no sirve. El primer login en línea correcto trae el perfil nuevo y borra la marca.
3. **Purga por pérdida de visibilidad (S-03).** Si el perfil anterior tenía `auditoria.ver_todo` o `consumos.validar` y el nuevo ya no, en la misma transacción que guarda el perfil se borran los consumos **ajenos** de la partición de ese usuario, con sus hijos. Se excluyen:
   - los protegidos: con cola, con rechazo o conflicto sin resolver, o con fotos sin subir;
   - los de órdenes que el usuario sigue teniendo asignadas.
   Nunca se toca lo propio ni otras particiones.
4. **Fuera de alcance a propósito:** un `401 SESION_REVOCADA` en `/auth/refresh` no bloquea. Solo pide la contraseña, como antes. Un logout enviado con `credentials: 'omit'` puede dejar en el navegador una cookie ya revocada, y bloquear con esa señal ocultaría la app a quien trabaja offline de forma legítima.

## Consecuencias

- Tras un cambio de rol o una desactivación detectados en línea, la tablet deja de mostrar datos hasta un login en línea con el perfil nuevo, y no admite el login sin conexión de ese usuario.
- **Riesgos residuales:**
  - una tablet que nunca vuelve a contactar al servidor tras la desactivación sigue admitiendo el login sin conexión (inherente a la ADR 0017);
  - la ruta de solo-refresh no bloquea;
  - el catálogo `usuarios` de otras personas queda hasta que termina el snapshot.
- No se pierde ningún dato de planta: lo protegido se conserva siempre.

## Cómo revertir

Hacer que el callback `sesionRevocada` vuelva a `marcarRequiereContrasena`, quitar la lectura de `requiere_login_online` y la llamada a `purgarAjenosSinVisibilidad`. La marca persistida queda inocua.

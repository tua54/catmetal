# ADR 0017 — Bloqueo por inactividad, límites del login offline y retención en la tablet

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 4
- Enmienda: ADR 0012 (consecuencias del verificador)

## Contexto

La revisión de seguridad de la Fase 4 (`docs/auditoria/seguridad-fase-4.md`) encontró que en una tablet compartida una sesión abandonada se puede usar sin contraseña (F4-01), que el login offline no limita intentos y que el verificador local permite recuperar por fuerza bruta la contraseña **del servidor** (F4-02; la ADR 0012 decía que "no da acceso al servidor", lo que es incorrecto), y que los perfiles y datos de usuarios que no vuelven quedan para siempre en la tablet (F4-04).

## Opciones consideradas

- F4-01: confiar en el cierre de sesión manual; o **bloqueo por inactividad** con confirmación contra el verificador local (funciona sin red).
- F4-02: aceptar el riesgo; **limitar intentos localmente** y no crear verificador para roles que no trabajan offline; o un segundo factor (fuera de alcance de la v1).
- F4-04: conservar perfiles indefinidamente; o **caducarlos** tras 30 días sin acceso y sin pendientes.

## Decisión

1. **Bloqueo por inactividad**: tras **10 minutos** sin interacción, o al volver de segundo plano tras más de 10 minutos, la app muestra "Confirme que es <nombre>" y pide la contraseña (contra el verificador local, sin red; o contra el servidor si no hay verificador). "No soy <nombre>" cierra la sesión (con las reglas de pendientes de la §5). `restaurar()` no publica una sesión adoptada de la cookie si el último acceso del perfil tiene más de 10 minutos, hasta esa confirmación.
2. **Límite del login offline**: contador persistido por perfil; desde el 5.º fallo consecutivo, espera creciente (30 s, 60 s, … hasta 15 min); al 10.º, se **borra el verificador** (solo podrá entrar con conexión). Un login correcto reinicia el contador. El mensaje es siempre el genérico.
3. **Sin verificador para el admin** (no trabaja offline). El jefe sí lo conserva (S5).
4. **Invalidar el verificador** cuando el servidor rechaza con `CREDENCIALES_INVALIDAS` una contraseña que el verificador acepta (cambio de contraseña, desactivación o bloqueo).
5. **Retención en la tablet**: la purga de 30 días corre al arrancar para **todas** las particiones; los perfiles sin acceso en 30 días y sin pendientes se borran con su partición. En el login, el correo se muestra enmascarado.
6. **Riesgos aceptados**: integridad del outbox frente a quien ya controla el dispositivo (F4-07; se exige un mínimo de 100.000 iteraciones en un verificador aceptado y se recomienda MDM sin depuración USB) y el `revocar` de entidades posteriores a una desasignación, que solo revela ids (F4-11).
7. **Enmienda a la ADR 0012**: el verificador local **sí** es un oráculo de la contraseña del servidor si alguien extrae IndexedDB; las medidas 2–4 y la política MDM (pendiente humano) lo mitigan.

## Consecuencias

- El supervisor confirma su identidad tras 10 minutos sin usar la tablet (≈ 1 s de derivación).
- Un usuario que olvida su contraseña y falla 10 veces sin red solo podrá volver a entrar con conexión.
- Los datos de quien deja de usar la tablet se eliminan a los 30 días si no tiene pendientes.

## Cómo revertir

Constantes en `apps/web/src/auth` (minutos de inactividad, umbrales del contador, días de caducidad) y la condición de rol para crear el verificador.

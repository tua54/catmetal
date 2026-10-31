# ADR 0024 — El Worker nunca borra un objeto de evidencia tras una subida fallida

- Estado: aceptado
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítem B4)

## Contexto

`PUT /api/v1/evidences/:id` escribe el archivo en R2 (`EVIDENCE.put(storage_key)`) y después confirma en D1 con `UPDATE … WHERE subido = 0`, más la auditoría condicional. Si la confirmación fallaba y la relectura de D1 devolvía `subido = 0`, el Worker borraba el objeto. Esa relectura y el borrado no son atómicos, y todas las subidas de una evidencia usan la **misma clave**. La secuencia del fallo es:

1. A escribe en R2.
2. B escribe en R2.
3. B falla al confirmar, relee `subido = 0` y borra el objeto.
4. A confirma.

D1 queda con `subido = 1` y el objeto no existe: la foto se pierde y GET responde 404.

Restricciones verificadas:

- La spec §6 fija la clave `evidencias/<order_id>/<evidence_id>`.
- `storage_key` se asigna al crear la novedad. El trigger `evidences_inmutable` impide cambiarla, y la columna tiene un índice UNIQUE.
- `R2Bucket.delete(keys)` no acepta condiciones: `onlyIf` y `etagMatches` solo existen en `get` y `put` (referencia de la API de Workers de R2 y `worker-configuration.d.ts`).
- Solo un contenido llega a R2 para cada evidencia. `validarArchivo` exige el sha256 y el tamaño declarados, y R2 verifica el sha256 en el `put`.

## Opciones consideradas

1. **Clave por intento** (`…/<evidence_id>/<uuid>`), guardada al confirmar. Exige una migración que relaje el trigger de inmutabilidad, se aparta de la spec §6 y deja un objeto por cada intento fallido.
2. **Borrado condicional** ("comprobar y luego borrar"). R2 no lo ofrece. Con contenido idéntico, el etag no distingue un intento de otro, así que la carrera sigue.
3. **No borrar nunca después de un fallo de confirmación.**

## Decisión

Se adopta la opción 3. El Worker nunca borra un objeto de evidencia.

- Si la confirmación no aplica porque otra petición ya confirmó, responde 200 idempotente, como antes.
- Ante cualquier otro error, propaga el error y registra el aviso `evidencia_no_confirmada` con `evidencia_id`, sin datos personales.
- Se elimina `borrarObjetoHuerfano`.
- Para las pruebas, `crearRutasEvidencias` acepta un `confirmarSubida` inyectable, con el que se reproduce el entrelazado de forma determinista.

## Consecuencias

- Ninguna subida borra un objeto que D1 da por subido.
- El sobrante está acotado: como máximo **un** objeto por evidencia con `subido = 0`, en su clave fija y con el contenido correcto (≤ 5 MB). El reintento del cliente lo sobrescribe y confirma. Si nunca reintenta, la reconciliación de `docs/despliegue.md` §9.4 cubre el caso "`subido = 0` con objeto en R2".
- Que el `put` de un perdedor sobrescriba un objeto ya confirmado no hace daño: son los mismos bytes, verificados por sha256.
- Se supone que un `put` fallido de R2 no deja un objeto parcial. Lo respalda la verificación del sha256 en el `put`.

## Cómo revertir

Restaurar `borrarObjetoHuerfano`, la rama de borrado de `apps/worker/src/rutas/evidencias.ts` y sus dos pruebas en `fase2-seguridad-correcciones.test.ts`. Las pruebas 1 y 3 de `correcciones-b4-evidencias-concurrencia.test.ts` volverían a fallar: eso documenta el riesgo que se reabre.

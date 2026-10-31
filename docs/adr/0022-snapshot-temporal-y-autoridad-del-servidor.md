# ADR 0022 — Snapshot en un área temporal y autoridad del servidor tras un cambio de época o un reinicio

- Estado: aceptado (revisado por el orquestador el 2026-10-30; el riesgo de visibilidad tras `reiniciar` se envía a la revisión de seguridad de P1)
- Fecha: 2026-10-30
- Fase: correcciones-v1.1 (ítems M5 y M6)
- Enmienda: ADR 0009 (qué hace el cliente al detectar otra época), ADR 0012 (esquema Dexie v3) y ADR 0016 (M1: verificación de los consumos propios contra el snapshot)

## Contexto

**M5.** Ante un `reiniciar` o un cambio de época, el cliente **borra primero** el estado sincronizado de la partición y **después** baja el snapshot:

- `reiniciarEstadoSincronizado` (`apps/web/src/datos/entidades.ts`) borra órdenes, planes, asignaciones, materiales, settings y usuarios, y además los consumos ajenos con sus hijos.
- Se llama desde `cambiarEpoca` y desde la rama `reiniciar` de `aplicarCambios` (`apps/web/src/datos/aplicar-cambios.ts`).
- Las páginas del snapshot se aplican después, una transacción por página (`aplicarEntidades`, desde `MotorSync.#snapshot`).

Si la red se cae a mitad del snapshot, el supervisor queda sin órdenes ni materiales. Ya no puede registrar sin conexión, y lo que más importa en planta es no perder registros.

**M6.** `masReciente` (`apps/web/src/datos/servidor.ts`) se queda con la versión más alta. La usan `upsertConsumo` (en modo `pull` y en modo `propio`) y `recalcular*`, cuando adoptan `servidor_diferido`. Tras una restauración, las versiones de la época vieja y las de la nueva **no se pueden comparar**. Un ejemplo:

1. La copia local es `aprobado` v3; el servidor restaurado tiene `pendiente` v2.
2. El snapshot no logra reemplazar la copia local.
3. Además, la validación ajena que la tablet ya tenía no se borra: su consumo sigue en la partición, porque es propio.
4. `recalcularConsumo` sigue mostrando "Validado por jefe".

Pasa lo mismo con un `conflicto` en el push: trae el estado **actual** del servidor, pero `masReciente` lo descarta si su versión es menor.

Otras restricciones que el diseño respeta:

- Partición por `user_id` en una tablet compartida (ADR 0012). La cola de A nunca se mezcla con la de B.
- Nada pendiente se pisa (ADR 0005, regla 2). `servidor` es la base sobre la que se calcularon las mutaciones en cola: `version = servidor.version + ediciones en cola` en `editarConsumoLocal`.
- El token de página del snapshot no tiene estado: base64url de `{ version, cursor, entidad, ultimo_id }`. No caduca y no está ligado a la época. El `cursor` es el `MAX(seq)` que se leyó en la primera página, y cada página trae su `epoca`.
- Una restauración no borra filas de negocio en el servidor (no hay `DELETE`), pero sí puede hacer desaparecer filas posteriores al punto restaurado.

## Opciones consideradas

### Dónde vive el área temporal (M5)

1. **Tablas Dexie aparte con una fila por entidad** (`snapshot_entidades` con clave `[user_id+entidad+id]` y `snapshot_progreso` por usuario), en una versión nueva del esquema que solo agrega tablas. Se pueden consultar por clave en el reemplazo, una página repetida no duplica nada y la reanudación es natural. **Elegida.**
2. Filas marcadas con una `generacion` en las tablas vivas. Obliga a filtrar en todas las consultas y en todos los índices de la UI, y una fila temporal podría filtrarse a la pantalla. Rechazada.
3. Un registro por página con la respuesta cruda. Es más simple de escribir, pero para saber en el reemplazo qué entidades trajo el servidor hay que cargar todo en memoria. Rechazada.
4. Acumular el snapshot en memoria y aplicarlo al final. Se pierde si se cierra la app, no se puede reanudar y no escala a snapshots grandes. Rechazada.
5. Otra base IndexedDB. No hay transacciones entre bases, así que el reemplazo no sería atómico. Rechazada.

### Interrupción (M5)

1. Reiniciar siempre desde la primera página. Con red inestable, un snapshot grande podría no terminar nunca, y el tope `maxPaginasSnapshot` lo vuelve a empezar en cada sync. Rechazada.
2. **Reanudar con el token de la última página guardada**, descartando el área temporal si cambia la época, si el servidor rechaza el token o si la descarga lleva más de 24 h. **Elegida.**

### Comparar estados de épocas distintas (M6)

1. Guardar en cada fila la época de `servidor` y la de `servidor_diferido`, y comparar versiones solo dentro de una época. Es más general, pero suma dos campos por tabla, exige un `upgrade()` que transforme datos y toca todas las ramas.
2. Reemplazar siempre y eliminar `masReciente`. Dentro de una misma época se perdería la protección contra respuestas viejas, por ejemplo la respuesta guardada que devuelve un reenvío idempotente después de que el jefe aprobó. Rechazada.
3. **Que el reemplazo del snapshot sea la autoridad.** Para lo que no tiene cola, la copia del servidor reemplaza a la local. Para lo que tiene cola, la copia del servidor va a `servidor_diferido` y `servidor` queda marcado `servidor_obsoleto`: es de antes del reinicio y ya no se compara por versión. **Elegida.**

## Decisión

### 1. Esquema Dexie v3: solo agrega tablas

```ts
export const ESQUEMA_V3 = {
  snapshot_entidades: '[user_id+entidad+id]',
  snapshot_progreso: 'user_id',
} as const;
// constructor: this.version(3).stores(ESQUEMA_V3);  (sin upgrade(): no se transforma nada)
```

- `EntidadSnapshotLocal = { user_id, entidad, id, datos }` guarda, tal como llegó, cada `entidadSnapshotSchema` ya validado por `snapshotResponseSchema`. La forma (`esConsumo`, `esOrden`…) se valida en el reemplazo, con las mismas funciones de hoy. Las entidades desconocidas no se guardan.
- `ProgresoSnapshot` tiene estos campos:

  ```ts
  {
    user_id: string;
    alcance: 'inicial';
    epoca: string;             // época de la PRIMERA página
    cursor: number;            // cursor de la primera página (ADR 0005 regla 7)
    siguiente_pagina: string | null;
    paginas: number;
    completo: boolean;         // ya se guardó la última página
    iniciado_at: string;
    actualizado_at: string;
  }
  ```

- Hay un helper nuevo, `tablasDeSnapshot()`, que devuelve `[db.snapshot_entidades, db.snapshot_progreso]`. **No entran en `tablasDeDatos()`.** Así, guardar una página no compite con las transacciones de la UI, que usan `tablasDeDatos()`, y registrar offline sigue siendo inmediato mientras baja el snapshot.
- Los campos nuevos de las filas vivas son opcionales y no son índices, así que no cambian el esquema:
  - `servidor_obsoleto?: boolean` en `ConsumoLocal`, `NovedadLocal` y `ValidacionLocal`.
- `verificar_en_snapshot` queda obsoleto. Se conserva como campo opcional para las filas antiguas, y el reemplazo lo deja en `false`.
- La v1 y la v2 no se editan. Una prueba de `db.test.ts` abre una base v2 con datos, la actualiza a v3 y comprueba que no se pierde nada.

### 2. Al detectar un reinicio, no se borra nada

- **Cambio de época** (`cambiarEpoca`, en `aplicarCambios`):
  - se reencolan las aplicadas (`reencolarAplicadas`, como hoy) y se recalculan;
  - se guarda `requiere_snapshot: true`, `motivo_snapshot: 'epoca'` y `hidrataciones: []`;
  - **`cursor` y `epoca` de `meta` no cambian**: se guardan solo con el reemplazo (punto 5);
  - no se llama a ningún borrado;
  - el resultado sigue devolviendo `epoca_cambiada: true` y la acción `snapshot`.
- **`reiniciar`** (en `aplicarCambios`): se guarda `requiere_snapshot: true` y `motivo_snapshot: 'reiniciar'` y no se borra nada. El cursor de la página sí avanza, como hoy.
- Con `meta.epoca` sin cambiar, el push sigue mandando la época vieja y recibe 409 `EPOCA_CAMBIADA` sin que el servidor procese nada (ADR 0016 A1). Así, en un cambio de época no sale ninguna mutación antes del reemplazo; quedan en la cola.
- El pull no corre antes del reemplazo: `#pull` atiende `meta.acciones` primero, y `accionesDe` devuelve solo `snapshot` mientras `requiere_snapshot` esté activo.
- `reiniciarEstadoSincronizado` y `marcarPerdidosTrasSnapshot` se eliminan. Su lógica de protección se reutiliza en el reemplazo.
- Una tablet que venga de la v1 con un reinicio a medias (catálogos ya borrados, `meta.epoca` nueva y `cursor: 0`) también funciona: el reemplazo ve la misma época en `meta` y en el progreso, y no reencola de nuevo.

### 3. Descarga a staging y reanudación (motor, solo para el alcance `inicial`)

`MotorSync.#snapshot` para el alcance `inicial`:

1. Lee `snapshot_progreso` del usuario y elige uno de tres caminos:
   - **Reemplazar sin red**: si `completo`, va directo a `completarSnapshot` (punto 4). Cubre una app cerrada entre la última página y el reemplazo.
   - **Reanudar**: si hay progreso con `siguiente_pagina` y `iniciado_at` de hace menos de 24 h, pide `pagina = siguiente_pagina`.
   - **Empezar de cero**: en cualquier otro caso, `descartarSnapshot(userId)` y empieza sin `pagina`.
2. Por cada página:
   - `#verificarSesion` → petición → `snapshotResponseSchema.parse` → `#verificarAutor`.
   - `guardarPaginaSnapshot(userId, respuesta)` corre en **una** transacción sobre `tablasDeSnapshot()`. Hace `bulkPut` de las entidades y actualiza el progreso: la primera página fija `epoca` y `cursor`; después se actualizan `siguiente_pagina`, `paginas`, `completo = siguiente_pagina === null` y `actualizado_at`.
   - Si la página trae una `epoca` distinta de `progreso.epoca`, `guardarPaginaSnapshot` no guarda nada y devuelve `epoca_distinta`. El motor descarta el área temporal y empieza de cero **una vez** en esa sync. Si vuelve a pasar, lanza `SnapshotIncompleto`, que es reintentable. **Nunca se mezclan épocas** en un mismo reemplazo.
   - Al reanudar, si el servidor responde 400 `VALIDACION` (token inválido, por ejemplo tras un cambio de `VERSION_TOKEN_PAGINA`), se descarta y se empieza de cero una vez.
3. Si se llega a `maxPaginasSnapshot` en esta sync, se lanza `SnapshotIncompleto`, pero **el área temporal se conserva**: la próxima sync reanuda. Esto mejora el M4 de la Fase 3, porque un snapshot más grande que el tope ahora sí termina.
4. Un error de red, de sesión o un 5xx a mitad del snapshot deja el área temporal y el progreso como estaban. **Los datos vivos no se tocan.**
5. Con `completo`, se llama a `completarSnapshot(userId)`, que devuelve `{ epoca_cambiada: boolean }`. Si es `true`, se activa `resumen.epoca_cambiada` y el motor hace el segundo push de las reencoladas.

Lo que no cambia:

- El alcance `orden` (hidratar) sigue aplicando directo con `aplicarEntidades`. Solo agrega datos y no borra nada, así que una interrupción no pierde nada.
- `#pull` descarta un progreso huérfano (hay progreso pero ni `requiere_snapshot` ni un arranque inicial) antes del bucle de pull.

### 4. Reemplazo atómico: `completarSnapshot(userId)`

`completarSnapshot` corre en **una sola** transacción `rw` sobre `[...tablasDeDatos(), ...tablasDeSnapshot()]`. Solo toca la partición de `userId`: todas las lecturas y escrituras van por `rangoDe(userId, …)` o por claves `[userId, …]`. **Nunca lee ni escribe** filas del outbox, de `meta`, de `snapshot_*` ni de entidades de otro usuario de la tablet.

1. Lee el progreso. Si falta o no está `completo`, no hace nada y devuelve `{ epoca_cambiada: false }`.
2. **Época**: `epocaCambiada = meta.epoca !== null && meta.epoca !== progreso.epoca`. Si cambió, llama a `reencolarAplicadas`, que es idempotente. Cubre el caso en que el snapshot fue el primero en ver la época nueva.
3. **Protegido** se define igual que hoy: tiene cola, `rechazado_sync` o `conflicto`, una novedad protegida, fotos con bytes `pendiente` o `bloqueada`, o una validación en cola.

   Hay un caso nuevo, **confirmado tras el inicio**: la entidad tiene una mutación propia `aplicada` con `aplicada_at >= progreso.iniciado_at`. Ocurre en un `reiniciar` o en el arranque inicial cuando un push de una sync posterior se intercala con una descarga reanudada. Con la época cambiada no puede pasar, porque el push recibe 409.
4. **Catálogos** (`ordenes`, `planeados`, `asignaciones`, `materiales`, `settings`, `usuarios`):
   - se leen a memoria las `ordenes` actuales de la partición;
   - se borra el rango del usuario en las seis tablas;
   - se insertan las filas que llegaron en el área temporal, con la misma traducción que `aplicarUpsert`;
   - las órdenes que no llegaron pero que alguno de los consumos que se conservan en el paso 6 tiene como `order_id` se vuelven a escribir desde la copia en memoria, con `revocada: true`. Así el supervisor sigue viendo el código de la orden de lo suyo, igual que en `revocarOrden`.
5. **Entidades que llegaron** (`consumptions`, `incidents` con sus `evidencias` anidadas, `evidences`, `validations`). Se recorren por bloques de 500 con keyset sobre `[user_id+entidad+id]`, sin cargar todo en memoria, y se aplica el modo **`autoridad`** del punto 6.
6. **Entidades de la partición que no llegaron**:
   - Consumos:
     - si están protegidos o confirmados tras el inicio, no se tocan;
     - si son propios (`registrado_por === userId`) y no tienen cola, se marcan `perdido_en_restauracion: true` y `verificar_en_snapshot: false`. Es la misma regla de hoy (ADR 0016 M1), solo que ahora se decide en el reemplazo;
     - si son ajenos, se borran con sus hijos (`borrarConsumoConHijos`).
   - Validaciones: si no tienen cola ni fueron confirmadas tras el inicio, **se borran**, aunque su consumo se conserve. Este es el arreglo de M6 para la validación que el servidor ya no tiene.
   - Novedades:
     - las protegidas o confirmadas tras el inicio se conservan;
     - las propias cuyo consumo sigue en la partición también se conservan: es dato de planta del usuario;
     - las demás se borran con sus fotos.
   - Evidencias: se conservan si son `evidenciaProtegida` o si su novedad se conservó. Las demás se borran.
7. `recalcular` corre sobre todas las entidades tocadas en los pasos 2, 5 y 6 y sobre todos los consumos que se conservan.
8. `meta.put` con estos valores:

   ```ts
   {
     ...meta,
     cursor: progreso.cursor,
     epoca: progreso.epoca,
     ultimo_sync_at: ahora,
     requiere_snapshot: false,
     motivo_snapshot: null,
     hidrataciones: [],
   }
   ```

   **El cursor y la época solo se guardan aquí**, juntos con el reemplazo.
9. Se borran `snapshot_entidades` (rango del usuario) y `snapshot_progreso` (el del usuario).

Si cualquier paso lanza un error, IndexedDB aborta la transacción y queda **todo** como antes: los datos vivos, `meta` y el área temporal. La próxima sync reintenta el reemplazo sin red.

### 5. Regla que reemplaza a `masReciente` según el origen

`ModoServidor` pasa a ser `'pull' | 'propio' | 'actual' | 'autoridad'`. La regla depende de si la entidad tiene cola:

| Origen | Sin cola | Con cola |
|---|---|---|
| `pull`: cambio `upsert` del pull e hidratación (`aplicarEntidades`) | `servidor = obsoleto ? s : masReciente(servidor, s)`; `obsoleto = false` | `servidor_diferido = masReciente(diferido, s)` |
| `propio`: push `aplicada` | `servidor = obsoleto ? s : masReciente(servidor, s)`; `obsoleto = false` | igual (se adopta directo, como hoy) |
| `actual`: push `conflicto` o `rechazada` con `servidor` (por ejemplo `CONSUMO_NO_PENDIENTE`) | `servidor = s` **sin comparar versión**; `obsoleto = false`; `diferido` no cambia | igual |
| `autoridad`: reemplazo del snapshot, punto 4.5 | `servidor = s`, `servidor_diferido = null`, `obsoleto = false` | `servidor_diferido = s` (reemplaza, sin comparar); `servidor_obsoleto = true`; `servidor` se conserva como base de las mutaciones en cola |
| `autoridad` sobre una entidad confirmada tras el inicio | `servidor = masReciente(servidor, s)` (misma época, versiones comparables) | — |

Al recalcular cuando la cola de la entidad queda vacía (`recalcularConsumo`, `recalcularNovedad`, `recalcularValidacion`):

- Si hay `servidor_diferido`, se toma `servidor = obsoleto ? diferido : masReciente(servidor, diferido)`, y después `diferido = null` y `obsoleto = false`.
- Si no hay `servidor_diferido`, `servidor` se conserva tal cual, incluido su `obsoleto`. El servidor no tiene esa entidad, y el siguiente estado que llegue del servidor la reemplaza.

Por qué es correcto:

- Dentro de una época, las versiones son monótonas. `masReciente` sigue protegiendo contra respuestas viejas, por ejemplo la respuesta guardada que se devuelve al reenviar una mutación idempotente.
- Entre épocas, el reemplazo es el único punto que compara estados de épocas distintas, y ahí manda el servidor.
- Una respuesta guardada de un `conflicto` nunca es anterior a la base de la mutación. Un pull más nuevo que llegue mientras la mutación está en cola queda en `servidor_diferido`, y se adopta con `masReciente` al vaciarse la cola. Por eso `actual` no puede retroceder la vista.
- `editarConsumoLocal` sigue calculando la versión con `servidor`. Si `servidor` está obsoleto, una edición nueva puede salir con una versión vieja y recibir `conflicto`. La mutación se conserva (las de `conflicto` nunca se borran) y el estado `actual` del servidor reemplaza la copia local. No se pierde nada.

### 6. Cerrar sesión y borrar los datos

`borrarDatosDeUsuario` también borra el área temporal del usuario (`snapshot_entidades` y `snapshot_progreso`) en su transacción, que ahora incluye `tablasDeSnapshot()`.

### 7. Pruebas de regresión

Todas usan Vitest con `fake-indexeddb`, como las demás de `apps/web/src/datos` y `apps/web/src/sync`. Las que **fallan con el código actual** están marcadas con ⚑.

`apps/web/src/datos/snapshot-temporal.test.ts` (nuevo):

1. ⚑ **Snapshot interrumpido.**
   - Preparación: la partición de A tiene órdenes, planes, asignaciones y materiales. Llega un `aplicarCambios` con otra época y se guarda solo la página 1, sin `completo`.
   - Se espera: los catálogos y las órdenes siguen ahí; `registrarConsumoLocal` funciona y deja su `consumo.crear` en el outbox; `meta.epoca` y `meta.cursor` no cambiaron; `requiere_snapshot` está activo.
   - Hay una variante con `reiniciar`.
2. ⚑ **Snapshot completo.**
   - Preparación: una orden y un material locales que no vienen en el snapshot, y uno de cada que sí viene, con datos nuevos.
   - Se espera: después de `completarSnapshot`, el estado queda reemplazado; el cursor y la época son los de la primera página; el área temporal queda vacía.
3. ⚑ **La época manda.**
   - Preparación: en la tablet del supervisor A hay un consumo **propio** de A, ya sincronizado y sin cola, que la tablet ve `aprobado` v3, más la validación del jefe (ajena) ya sincronizada. El snapshot de la época nueva trae el consumo `pendiente` v2 y ninguna validación.
   - Se espera: `servidor.version === 2`, `estado_local === 'sincronizado'`, la validación queda borrada y la UI ya no muestra "Validado por jefe".
   - Hoy falla porque el consumo propio se conserva, `masReciente` se queda con la v3 y la validación sobrevive. Con un consumo ajeno pasaría hoy, porque se borra y se vuelve a crear; por eso la prueba usa uno propio.
4. **Lo pendiente se conserva.** Es el mismo caso de la prueba 3, pero el consumo está pendiente, en v3, y tiene un `consumo.editar` propio en cola.
   - Se espera: el outbox queda intacto; la vista queda en `pendiente_sync` con el campo editado; `servidor_diferido` es v2 y `servidor_obsoleto` es `true`.
   - Se aplica una respuesta `aplicada` v3 del reenvío y la cola queda vacía. Entonces `servidor` es v3 y `obsoleto` es `false`.
5. **Particiones.** El reemplazo de A no toca a B: su outbox, sus consumos, su `meta` ni su área temporal.
6. **Un consumo propio que no llegó.**
   - Sin cola: queda `perdido_en_restauracion`.
   - Con una mutación `aplicada` posterior a `iniciado_at`: no se marca.
   - Una orden que solo referencia un consumo conservado queda `revocada: true`.
7. **Atomicidad.** Se fuerza un error dentro del reemplazo con un dato que hace fallar el `put`. Se espera que los datos vivos, `meta` y el área temporal sigan como antes.
8. **Épocas mezcladas.** Llega una página con otra época: `guardarPaginaSnapshot` no guarda nada y devuelve `epoca_distinta`.

`apps/web/src/datos/outbox.test.ts`:

9. ⚑ **Conflicto en modo propio.** La copia local es v5. `aplicarResultados` recibe un `conflicto` con `servidor` v4. Se espera que la copia local quede en v4 con `estado_local === 'conflicto'`. Hay otro caso igual con `rechazada CONSUMO_NO_PENDIENTE`.
10. **Cerrar sesión.** `borrarDatosDeUsuario` borra el área temporal del usuario y la de los demás queda intacta.

`apps/web/src/datos/db.test.ts`:

11. **Migración.** Una base v2 con datos se abre con `CatmetalDb` (v3): no se pierde nada y las tablas nuevas existen vacías.

`apps/web/src/sync/motor.test.ts`, con una opción nueva del servidor falso, `fallarSnapshotEnPagina`:

12. ⚑ **Restauración con caída de red.**
    - Preparación: `restaurar('epoca-2')` y la red falla en la página 2.
    - Se espera: el resumen trae un error de red y las órdenes y materiales siguen disponibles.
    - En la siguiente sync, la primera petición del snapshot lleva `pagina = <token de la página 2>`, sin volver a empezar. Al terminar, el estado coincide con el del servidor, el cursor es el de la primera página y se reenvían las reencoladas.
13. **Token rechazado.** Con un 400 `VALIDACION` al reanudar, el snapshot empieza de cero una vez y termina.
14. **Tope de páginas.** Con `maxPaginasSnapshot` agotado, se reanuda en la siguiente sync en lugar de volver a empezar.

Pruebas existentes que hay que **corregir** porque afirman justamente el comportamiento defectuoso de M5. Se reescriben con la regla nueva, sin debilitarlas, y el motivo va en el commit:

- en `aplicar-cambios.test.ts`: "reiniciar borra el estado sincronizado no protegido…", "cambio de época: reencola…, reinicia…" (afirma `cursor: 0` y la época nueva antes del snapshot) y "un snapshot que termina con otra época vuelve a reiniciar";
- en `motor.test.ts`: "la época cambia durante un snapshot…";
- la lista de exportaciones de `apps/web/src/datos/index.test.ts`.

## Consecuencias

- Una caída de red, un cierre de la app o un error del servidor a mitad del snapshot ya no deja la tablet sin catálogos ni órdenes. Se puede seguir registrando offline.
- El snapshot se puede reanudar entre syncs, y uno más grande que el tope de páginas ahora sí termina.
- Tras una restauración, la tablet muestra lo que tiene el servidor. Lo pendiente local se conserva y se vuelve a enviar.
- **Espacio**: mientras dura la descarga, la partición ocupa hasta el doble en IndexedDB. El área temporal se borra al reemplazar, al empezar de cero y al cerrar sesión.
- **Duración del reemplazo**: la transacción `rw` sobre `tablasDeDatos()` bloquea las escrituras de la UI mientras dura. Para una partición de supervisor son segundos. Para un jefe con decenas de miles de consumos puede ser más. Hay que medirlo en la fase 2. Si con 10.000 entidades pasa de unos 3 s, se optimiza el recálculo: solo los consumos con hijos o con cola, y para el resto el estado sale directo de `servidor`.
- **Visibilidad tras `reiniciar`**: si a un usuario le bajan el rol, conserva lo que ya veía hasta que el snapshot termina. Antes se borraba de inmediato. Se acepta por la prioridad del proyecto: no perder datos de planta va antes que la seguridad. El servidor sigue autorizando cada mutación y cada lectura, y el dato retenido es el que ese mismo usuario ya tenía en esa tablet. Se señala para `security-reviewer`.
- En un cambio de época, el push queda en espera (409 `EPOCA_CAMBIADA`) hasta que termina el reemplazo. Las mutaciones esperan en el outbox, sin perderse.
- La API pública de `apps/web/src/datos` cambia:
  - `completarSnapshot(userId)` toma el cursor y la época del progreso y devuelve `{ epoca_cambiada }`;
  - entran `guardarPaginaSnapshot`, `leerProgresoSnapshot` y `descartarSnapshot`;
  - salen `reiniciarEstadoSincronizado` y `marcarPerdidosTrasSnapshot`.
- No cambia nada del servidor ni de `packages/shared`.

## Cómo revertir

1. Volver a llamar a `reiniciarEstadoSincronizado` en `cambiarEpoca` y en `reiniciar`, y aplicar las páginas con `aplicarEntidades` como en la v1. Las funciones se recuperan de la historia de git.
2. Quitar los modos `actual` y `autoridad` y el campo `servidor_obsoleto` de las reglas de `upsert*` y `recalcular*`. Las filas que lo tengan se pueden ignorar, porque es opcional.
3. **No quitar la versión 3 de Dexie**: los navegadores ya la tienen. Basta con dejar de usar las tablas `snapshot_*`. Si hay que borrarlas, se agrega una versión 4 que las declare `null`.

## Enmienda 1 — Cuota de almacenamiento agotada (correcciones v1.2, ítem A7)

- Fecha: 2026-10-30.

**Contexto.** Si guardar una página en el área temporal o el reemplazo (`completarSnapshot`) falla con `QuotaExceededError`, la tablet queda con un área temporal que no puede completar: cada sync reintenta la misma descarga y vuelve a fallar, y el push del outbox, que va en la misma sync, puede quedar bloqueado detrás.

**Decisión.**

1. Ante `QuotaExceededError` (o el error de Dexie que lo envuelve) al guardar una página o al reemplazar, se **descarta el área temporal** del usuario. El estado vivo no se toca: la transacción del reemplazo es atómica y, si falla, no aplicó nada.
2. El snapshot se reintenta con la espera exponencial que ya usa el motor para los errores transitorios, nunca en un bucle inmediato.
3. Se muestra un aviso claro y persistente mientras dure: **"Almacenamiento lleno: sincroniza o libera espacio"**.
4. El push del outbox no espera a un snapshot que no se puede completar: si la época lo permite (no hay un cambio de época pendiente que obligue a reencolar primero, ADR 0009 y punto 5), el motor envía los pendientes antes o a pesar del fallo del snapshot. Enviar libera espacio, porque las mutaciones aplicadas dejan de ocupar el outbox y sus fotos.

**Consecuencia.** La tablet sale sola del estado: sigue enviando lo pendiente, y el snapshot se completa cuando haya espacio.

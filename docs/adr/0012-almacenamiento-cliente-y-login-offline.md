# ADR 0012 — Almacenamiento local del cliente (Dexie) y verificador de login offline

- Estado: aceptado
- Fecha: 2026-10-29
- Fase: 3 (adelantada en paralelo con la Fase 2)

## Contexto

La PWA debe registrar sin conexión (§6), funcionar en tablets compartidas sin mezclar autorías (§5) y permitir login offline solo a usuarios que ya iniciaron sesión con conexión en ese dispositivo, con un verificador local cuyas iteraciones se fijan en un ADR "según el rendimiento medido en tablet". No hay tablets reales en la sesión.

## Opciones consideradas

- Almacenamiento: IndexedDB directo, `localStorage`, o **Dexie** (pedido por la spec).
- Partición por usuario: una base por usuario, o **una base con `user_id` en todas las tablas e índices compuestos**.
- Verificador: PBKDF2 con pocas iteraciones (rápido, débil ante fuerza bruta offline sobre una tablet robada) o con las recomendadas por OWASP (más lento en tablets modestas).

## Decisión

1. **Una base Dexie `catmetal-mp`** con `user_id` en todas las tablas de datos y claves/índices compuestos `[user_id+…]`. Tablas: `outbox`, `consumos`, `novedades`, `evidencias` (blob comprimido + metadatos + estado de subida), `ordenes`, `planeados`, `asignaciones`, `materiales`, `validaciones`, `settings`, `meta` (cursor, época, último sync por usuario), `perfiles` (perfil, permisos cacheados y verificador), `trazabilidad` (eventos de este dispositivo) e `instalacion` (id por navegador, ADR 0008).
2. **Toda acción escribe en una sola transacción de Dexie** la entidad local y su mutación del outbox: nunca hay una sin la otra.
3. **Retención**: las mutaciones `aplicada` se conservan 7 días (ADR 0009, reenvío tras cambio de época); las `rechazada` y `conflicto` nunca se borran automáticamente. Cerrar sesión borra los datos del usuario solo si no tiene pendientes (§5).
4. **Verificador offline**: PBKDF2-SHA256 en el navegador con **600.000 iteraciones** (recomendación OWASP 2023 para PBKDF2-SHA256), sal aleatoria de 16 bytes **propia del dispositivo** (distinta de la del servidor), 32 bytes de salida, comparación de tiempo constante. Se guarda en `perfiles` junto con el perfil y los permisos. **Nunca se envía al servidor** ni reemplaza la autenticación del servidor: al recuperar conexión, la sincronización exige una sesión válida del servidor (refresh); si no la hay, se pide la contraseña.
   - El número de iteraciones se guarda junto al verificador para poder cambiarlo.
   - Medición: la prueba E2E de login offline registra el tiempo de derivación en Chromium. Si en las tablets reales supera 2 s, se baja a 310.000 (pendiente humano: medir en el modelo de tablet de planta).
5. **Persistencia**: `navigator.storage.persist()` al iniciar; si no se concede (frecuente en Safari), aviso permanente "Sincroniza al menos una vez al día".

## Consecuencias

- Un atacante con la tablet puede intentar fuerza bruta offline contra el verificador; 600.000 iteraciones la encarecen. El verificador solo abre los datos locales; no da acceso al servidor.
- La partición por `user_id` en una sola base simplifica las migraciones de Dexie y el aviso "Hay N registros pendientes de <A>".
- Safari puede borrar IndexedDB tras 7 días sin uso si no hay persistencia: lo mitiga el aviso de sincronizar a diario.

## Cómo revertir

Cambiar `ITERACIONES_VERIFICADOR` (los verificadores existentes guardan su número de iteraciones y siguen verificándose). Para separar bases por usuario, migrar con una versión nueva del esquema de Dexie.

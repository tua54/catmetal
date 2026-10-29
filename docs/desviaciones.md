# Desviaciones respecto a la spec

Todo lo que difiere de `docs/spec.md` o quedó incompleto, con su motivo y su ADR si aplica.

| # | Fase | Desviación | Motivo | Referencia |
|---|---|---|---|---|
| D1 | 0 | Se usa `@cloudflare/vitest-plugin` 1.4.11 en lugar de `@cloudflare/vitest-pool-workers` (nombrado en la spec §2 y en `CLAUDE.md`). | El paquete original fue deprecado y renombrado (misma API, mismas D1/R2 reales locales). La última versión del original (0.23.0) no recibirá correcciones. | ADR 0001 |
| D2 | 1 | Esquema con elementos adicionales a la §4: `devices.instalacion_id`, `sync_mutations.payload_json`, `settings.sync_epoca`, `token_hash` UNIQUE, índices `refresh_tokens(familia_id)` y UNIQUE en `validations(consumption_id)` y `consumptions(corrige_a)`, `CHECK` de longitud en fechas, y triggers adicionales (autoría, versión, validación previa, reglas de validación, evidencias, órdenes terminales, `_no_delete` en más tablas). | Revisión de `software-architect`: trazabilidad física en tablet compartida, no perder mutaciones rechazadas, restauración con Time Travel, defensa en profundidad de las reglas de negocio. Ninguna relaja la spec; todas la endurecen. | ADR 0006, 0008, 0009 |

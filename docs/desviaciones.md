# Desviaciones respecto a la spec

Todo lo que difiere de `docs/spec.md` o quedó incompleto, con su motivo y su ADR si aplica.

| # | Fase | Desviación | Motivo | Referencia |
|---|---|---|---|---|
| D1 | 0 | Se usa `@cloudflare/vitest-plugin` 1.4.11 en lugar de `@cloudflare/vitest-pool-workers` (nombrado en la spec §2 y en `CLAUDE.md`). | El paquete original fue deprecado y renombrado (misma API, mismas D1/R2 reales locales). La última versión del original (0.23.0) no recibirá correcciones. | ADR 0001 |

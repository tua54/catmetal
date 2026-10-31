// setupFile: aplica todas las migraciones de /migrations a la D1 local de cada archivo de prueba.
// Se ejecuta aunque todavía no haya migraciones, para que el mecanismo quede probado desde la Fase 0.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

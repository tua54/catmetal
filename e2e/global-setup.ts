// Se ejecuta una vez por corrida, con el servidor E2E ya levantado (el `webServer` arranca antes).
// Deja en el entorno el access token del jefe y del admin del seed para que las verificaciones por API de las pruebas no
// consuman intentos del login (5 por minuto y correo, ADR 0008) que las pruebas de UI necesitan.

import { request, type FullConfig } from '@playwright/test';
import {
  ENV_TOKEN_ADMIN,
  ENV_TOKEN_ADMIN_RENOVAR_EN,
  ENV_TOKEN_JEFE,
  ENV_TOKEN_JEFE_RENOVAR_EN,
  iniciarSesionApi,
} from './apoyo/api';
import { ADMIN, JEFE } from './apoyo/usuarios';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  const contexto = await request.newContext({ baseURL });
  try {
    const sesion = await iniciarSesionApi(contexto, JEFE);
    process.env[ENV_TOKEN_JEFE] = sesion.accessToken;
    process.env[ENV_TOKEN_JEFE_RENOVAR_EN] = String(sesion.renovarEn);
    const admin = await iniciarSesionApi(contexto, ADMIN);
    process.env[ENV_TOKEN_ADMIN] = admin.accessToken;
    process.env[ENV_TOKEN_ADMIN_RENOVAR_EN] = String(admin.renovarEn);
  } finally {
    await contexto.dispose();
  }
}

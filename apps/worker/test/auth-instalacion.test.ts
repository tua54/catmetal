// F4-06 (docs/auditoria/seguridad-fase-4.md; ADR 0008 puntos 7 y 8): al iniciar sesión con un
// `instalacion_id`, se revocan en el mismo batch las familias vigentes de OTROS usuarios cuyos
// dispositivos tienen ese `instalacion_id` (una sola cookie por origen: ya no se pueden usar), con
// una fila de auditoría por familia. Las del mismo usuario en otros navegadores no se tocan.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ACCION_REVOCADA_POR_OTRO_INICIO } from '../src/auth/sesiones';
import { verificarAccessToken } from '../src/auth/tokens';
import {
  crearUsuarioConClave,
  esperarAuditoriaSinSecretos,
  iniciarSesion,
  perfil,
  peticion,
  refrescar,
  type SesionPrueba,
} from './auth-helpers';

const secretosUsados: string[] = [];

async function familiaDe(sesion: SesionPrueba): Promise<string> {
  const claims = await verificarAccessToken(env.JWT_SECRET, sesion.cuerpo.access_token);
  expect(claims).not.toBeNull();
  return claims?.fam ?? '';
}

async function entrar(
  ...args: Parameters<typeof iniciarSesion>
): Promise<SesionPrueba & { familia: string }> {
  const sesion = await iniciarSesion(...args);
  secretosUsados.push(args[0].password, sesion.refresh, sesion.cuerpo.access_token);
  return { ...sesion, familia: await familiaDe(sesion) };
}

interface FilaRevocacion {
  entidad: string;
  entidad_id: string;
  actor_id: string | null;
  device_id: string | null;
  datos_antes: string | null;
  datos_despues: string;
}

async function revocacionesDeFamilia(familia: string): Promise<FilaRevocacion[]> {
  const { results } = await env.DB.prepare(
    `SELECT entidad, entidad_id, actor_id, device_id, datos_antes, datos_despues FROM audit_log
     WHERE accion = ? AND json_extract(datos_despues, '$.familia_id') = ? ORDER BY seq`,
  )
    .bind(ACCION_REVOCADA_POR_OTRO_INICIO, familia)
    .all<FilaRevocacion>();
  return results;
}

async function tokensVigentes(familia: string): Promise<number> {
  const fila = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM refresh_tokens WHERE familia_id = ? AND revocado_at IS NULL',
  )
    .bind(familia)
    .first<{ n: number }>();
  return fila?.n ?? -1;
}

describe('login en un navegador compartido (instalacion_id)', () => {
  it('B entra en la instalación de A: la familia de A se revoca, se audita y su access token deja de servir', async () => {
    const a = await crearUsuarioConClave('supervisor');
    const b = await crearUsuarioConClave('supervisor');
    const instalacion = uuidv7();
    const sesionA = await entrar(a, { instalacionId: instalacion });
    expect((await perfil(sesionA.cuerpo.access_token)).status).toBe(200);

    const sesionB = await entrar(b, { instalacionId: instalacion });

    // A: ni el access token ni el refresh sirven.
    const meA = await perfil(sesionA.cuerpo.access_token);
    expect(meA.status).toBe(401);
    expect(await meA.json()).toMatchObject({ code: 'SESION_REVOCADA' });
    const refrescoA = await refrescar(sesionA.refresh);
    expect(refrescoA.status).toBe(401);
    expect(await refrescoA.json()).toMatchObject({ code: 'SESION_REVOCADA' });
    expect(await tokensVigentes(sesionA.familia)).toBe(0);

    // B: su sesión sigue viva.
    expect((await perfil(sesionB.cuerpo.access_token)).status).toBe(200);

    // Una fila de auditoría, solo con ids, del token vigente de A; el actor es B.
    const filas = await revocacionesDeFamilia(sesionA.familia);
    expect(filas).toHaveLength(1);
    const [fila] = filas;
    const tokenA = await env.DB.prepare(
      'SELECT id, revocado_at FROM refresh_tokens WHERE familia_id = ?',
    )
      .bind(sesionA.familia)
      .first<{ id: string; revocado_at: string }>();
    expect(fila).toMatchObject({
      entidad: 'refresh_tokens',
      entidad_id: tokenA?.id,
      actor_id: b.id,
      device_id: sesionB.deviceId,
      datos_antes: null,
    });
    expect(JSON.parse(fila?.datos_despues ?? '{}')).toEqual({
      id: tokenA?.id,
      user_id: a.id,
      device_id: sesionA.deviceId,
      familia_id: sesionA.familia,
      revocado_at: tokenA?.revocado_at,
    });

    // La revocación y su auditoría van en el mismo batch que el inicio de B (misma hora).
    const inicioB = await env.DB.prepare(
      `SELECT server_at FROM audit_log WHERE accion = 'sesion.inicio'
       AND json_extract(datos_despues, '$.familia_id') = ?`,
    )
      .bind(sesionB.familia)
      .first<{ server_at: string }>();
    expect(inicioB?.server_at).toBe(tokenA?.revocado_at);
  });

  it('las sesiones de A en otra instalación no se tocan', async () => {
    const a = await crearUsuarioConClave('supervisor');
    const b = await crearUsuarioConClave('jefe');
    const x = uuidv7();
    const y = uuidv7();
    const aEnX = await entrar(a, { instalacionId: x });
    const aEnY = await entrar(a, { instalacionId: y });

    await entrar(b, { instalacionId: x });

    expect((await perfil(aEnX.cuerpo.access_token)).status).toBe(401);
    expect((await perfil(aEnY.cuerpo.access_token)).status).toBe(200);
    expect((await refrescar(aEnY.refresh)).status).toBe(200);
    expect(await revocacionesDeFamilia(aEnX.familia)).toHaveLength(1);
    expect(await revocacionesDeFamilia(aEnY.familia)).toHaveLength(0);
  });

  it('revoca las familias de todos los demás usuarios de la instalación, con una fila por familia', async () => {
    const a = await crearUsuarioConClave('supervisor');
    const c = await crearUsuarioConClave('supervisor');
    const b = await crearUsuarioConClave('supervisor');
    const instalacion = uuidv7();
    const sesionA = await entrar(a, { instalacionId: instalacion });
    // C entra en la misma instalación: ya revoca la de A.
    const sesionC = await entrar(c, { instalacionId: instalacion });
    expect(await revocacionesDeFamilia(sesionA.familia)).toHaveLength(1);

    await entrar(b, { instalacionId: instalacion });

    expect((await perfil(sesionC.cuerpo.access_token)).status).toBe(401);
    expect(await revocacionesDeFamilia(sesionC.familia)).toHaveLength(1);
    // La familia de A ya estaba revocada: no se vuelve a auditar.
    expect(await revocacionesDeFamilia(sesionA.familia)).toHaveLength(1);
  });

  it('el mismo usuario con otro device_id en la misma instalación no revoca su propia sesión', async () => {
    const a = await crearUsuarioConClave('supervisor');
    const instalacion = uuidv7();
    const primera = await entrar(a, { instalacionId: instalacion });
    const segunda = await entrar(a, { instalacionId: instalacion });
    expect(segunda.deviceId).not.toBe(primera.deviceId);
    expect((await perfil(primera.cuerpo.access_token)).status).toBe(200);
    expect((await perfil(segunda.cuerpo.access_token)).status).toBe(200);
    expect(await revocacionesDeFamilia(primera.familia)).toHaveLength(0);
  });

  it('sin instalacion_id no se revoca nada de otros usuarios', async () => {
    const a = await crearUsuarioConClave('supervisor');
    const b = await crearUsuarioConClave('supervisor');
    const sesionA = await entrar(a, { instalacionId: uuidv7() });
    await entrar(b);
    expect((await perfil(sesionA.cuerpo.access_token)).status).toBe(200);
    expect(await revocacionesDeFamilia(sesionA.familia)).toHaveLength(0);
  });

  it('una familia ya cerrada por logout no se audita otra vez', async () => {
    const a = await crearUsuarioConClave('supervisor');
    const b = await crearUsuarioConClave('supervisor');
    const instalacion = uuidv7();
    const sesionA = await entrar(a, { instalacionId: instalacion });
    const salida = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      cookie: sesionA.refresh,
    });
    expect(salida.status).toBe(204);

    await entrar(b, { instalacionId: instalacion });

    expect(await revocacionesDeFamilia(sesionA.familia)).toHaveLength(0);
  });

  it('una familia vencida (sin revocar) no se revoca ni se audita', async () => {
    const a = await crearUsuarioConClave('supervisor');
    const b = await crearUsuarioConClave('supervisor');
    const instalacion = uuidv7();
    const sesionA = await entrar(a, { instalacionId: instalacion });
    await env.DB.prepare(
      `UPDATE refresh_tokens SET expira_at = '2000-01-01T00:00:00.000Z' WHERE familia_id = ?`,
    )
      .bind(sesionA.familia)
      .run();

    await entrar(b, { instalacionId: instalacion });

    expect(await tokensVigentes(sesionA.familia)).toBe(1);
    expect(await revocacionesDeFamilia(sesionA.familia)).toHaveLength(0);
  });

  it('la auditoría de estas revocaciones no contiene secretos', async () => {
    await esperarAuditoriaSinSecretos(secretosUsados);
  });
});

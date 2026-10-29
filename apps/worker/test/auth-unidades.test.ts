// Pruebas unitarias (dentro de workerd) de contraseñas, tokens y del helper de auditoría.
import { ALERTA_RELOJ_MS, PBKDF2_ITERACIONES_SERVIDOR, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  calcularAlertaReloj,
  type EntidadAuditada,
  filtrarDatos,
  sentenciaAuditoria,
  sentenciaAuditoriaCondicional,
} from '../src/auditoria/auditar';
import { aBase64, deBase64 } from '../src/auth/codificacion';
import {
  derivacionFicticia,
  hashearContrasena,
  verificarContrasena,
} from '../src/auth/contrasenas';
import {
  AUDIENCIA_JWT,
  EMISOR_JWT,
  emitirAccessToken,
  generarRefreshToken,
  hashRefreshToken,
  verificarAccessToken,
} from '../src/auth/tokens';

describe('contraseñas (ADR 0007)', () => {
  it('las iteraciones del servidor no superan el máximo de workerd (100.000)', () => {
    expect(PBKDF2_ITERACIONES_SERVIDOR).toBeLessThanOrEqual(100_000);
  });

  it('el hash tiene el formato autodescriptivo con 100000, sal de 16 y hash de 32 bytes', async () => {
    const hash = await hashearContrasena('Contraseña-de-prueba');
    const [prefijo, iteraciones, sal = '', valor = ''] = hash.split('$');
    expect(prefijo).toBe('pbkdf2-sha256');
    expect(iteraciones).toBe('100000');
    expect(deBase64(sal)).toHaveLength(16);
    expect(deBase64(valor)).toHaveLength(32);
    // base64 estándar con relleno (btoa), no base64url.
    expect(sal).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(valor).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('ida y vuelta; contraseña incorrecta; dos hashes de la misma clave son distintos', async () => {
    const hash = await hashearContrasena('Clave-Correcta-1');
    expect(await verificarContrasena('Clave-Correcta-1', hash)).toBe(true);
    expect(await verificarContrasena('Clave-Correcta-2', hash)).toBe(false);
    expect(await verificarContrasena('', hash)).toBe(false);
    expect(await hashearContrasena('Clave-Correcta-1')).not.toBe(hash);
  });

  it('verifica un hash generado con node:crypto (formato del seed)', async () => {
    // node -e "crypto.pbkdf2Sync('Catmetal-2026!', Buffer.from([1..16]), 100000, 32, 'sha256')"
    const hashNode =
      'pbkdf2-sha256$100000$AQIDBAUGBwgJCgsMDQ4PEA==$aOetAF0sD0luQuovXA8EgVQ7QI6AUbEOyPt1KDxdURg=';
    expect(await verificarContrasena('Catmetal-2026!', hashNode)).toBe(true);
    expect(await verificarContrasena('catmetal-2026!', hashNode)).toBe(false);
  });

  it('un formato desconocido o corrupto devuelve false sin lanzar', async () => {
    const bueno = await hashearContrasena('Clave-Correcta-1');
    const [, , sal = '', valor = ''] = bueno.split('$');
    const corruptos = [
      '',
      'texto-plano',
      `bcrypt$100000$${sal}$${valor}`,
      `pbkdf2-sha256$100000$${sal}`,
      `pbkdf2-sha256$100000$${sal}$${valor}$extra`,
      `pbkdf2-sha256$0$${sal}$${valor}`,
      `pbkdf2-sha256$abc$${sal}$${valor}`,
      `pbkdf2-sha256$100001$${sal}$${valor}`,
      `pbkdf2-sha256$100000$no*es*base64$${valor}`,
      `pbkdf2-sha256$100000$${sal}$${aBase64(new Uint8Array(16))}`,
      `pbkdf2-sha256$100000$${aBase64(new Uint8Array(4))}$${valor}`,
    ];
    for (const corrupto of corruptos) {
      expect(await verificarContrasena('Clave-Correcta-1', corrupto), corrupto).toBe(false);
    }
  });

  it('la derivación ficticia se ejecuta sin error', async () => {
    await expect(derivacionFicticia()).resolves.toBeUndefined();
  });

  it('deBase64 rechaza longitudes inválidas', () => {
    expect(deBase64('abc')).toBeNull();
    expect(deBase64('YWJj')).toEqual(new TextEncoder().encode('abc'));
  });
});

describe('tokens (ADR 0008)', () => {
  const claims = { sub: uuidv7(), did: uuidv7(), fam: uuidv7() };
  const clave = new TextEncoder().encode(env.JWT_SECRET);

  it('emite y verifica un access token con sub, did y fam (sin rol)', async () => {
    const token = await emitirAccessToken(env.JWT_SECRET, claims);
    expect(await verificarAccessToken(env.JWT_SECRET, token)).toEqual(claims);
    const payload = JSON.parse(
      atob(token.split('.')[1]?.replaceAll('-', '+').replaceAll('_', '/') ?? ''),
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('rol');
    expect(payload.iss).toBe(EMISOR_JWT);
    expect(payload.aud).toBe(AUDIENCIA_JWT);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(900);
  });

  it('rechaza otro secreto, otro emisor, otra audiencia, vencido, alg none y basura', async () => {
    const base = () =>
      new SignJWT({ did: claims.did, fam: claims.fam })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuedAt();
    const otroSecreto = await emitirAccessToken(
      'otro-secreto-de-mas-de-treinta-caracteres',
      claims,
    );
    const otroEmisor = await base()
      .setIssuer('otro')
      .setAudience(AUDIENCIA_JWT)
      .setExpirationTime('15m')
      .sign(clave);
    const otraAudiencia = await base()
      .setIssuer(EMISOR_JWT)
      .setAudience('otra')
      .setExpirationTime('15m')
      .sign(clave);
    const vencido = await base()
      .setIssuer(EMISOR_JWT)
      .setAudience(AUDIENCIA_JWT)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(clave);
    const hs512 = await new SignJWT({ did: claims.did, fam: claims.fam })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(claims.sub)
      .setIssuer(EMISOR_JWT)
      .setAudience(AUDIENCIA_JWT)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new Uint8Array(64).fill(1));
    const sinClaims = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(EMISOR_JWT)
      .setAudience(AUDIENCIA_JWT)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(clave);
    const [cabecera, cuerpo] = (await emitirAccessToken(env.JWT_SECRET, claims)).split('.');
    const algNone = `${btoa('{"alg":"none","typ":"JWT"}').replace(/=+$/, '')}.${cuerpo ?? ''}.`;
    for (const token of [
      otroSecreto,
      otroEmisor,
      otraAudiencia,
      vencido,
      hs512,
      sinClaims,
      algNone,
      'basura',
      `${cabecera ?? ''}..`,
    ]) {
      expect(await verificarAccessToken(env.JWT_SECRET, token)).toBeNull();
    }
  });

  it('refresh token: 32 bytes base64url y token_hash HMAC-SHA256 en hex minúsculas', async () => {
    const token = generarRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generarRefreshToken()).not.toBe(token);
    const hash = await hashRefreshToken(env.REFRESH_SECRET, token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashRefreshToken(env.REFRESH_SECRET, token)).toBe(hash);
    expect(await hashRefreshToken('otro-secreto', token)).not.toBe(hash);
  });
});

describe('auditoría', () => {
  it('filtra con la lista blanca: nunca password_hash ni token_hash', () => {
    expect(
      filtrarDatos('users', {
        id: 'u1',
        email: 'a@b.co',
        password_hash: 'secreto',
        password: 'secreto',
        rol: 'jefe',
      }),
    ).toEqual({ id: 'u1', email: 'a@b.co', rol: 'jefe' });
    expect(
      filtrarDatos('refresh_tokens', {
        id: 't1',
        token_hash: 'abc',
        token: 'xyz',
        familia_id: 'f',
      }),
    ).toEqual({ id: 't1', familia_id: 'f' });
    expect(filtrarDatos('devices', null)).toBeNull();
    expect(filtrarDatos('devices', undefined)).toBeNull();
  });

  it('una entidad sin lista blanca lanza un error de programación', () => {
    expect(() =>
      sentenciaAuditoria(env.DB, {
        entidad: 'secretos' as EntidadAuditada,
        entidad_id: 'x',
        accion: 'y',
        actor_id: null,
        device_id: null,
      }),
    ).toThrow(/sin lista blanca/);
  });

  it('alerta_reloj si el reloj del dispositivo difiere más de 10 min', () => {
    const servidor = '2026-10-29T20:00:00.000Z';
    const desfase = (ms: number) => new Date(Date.parse(servidor) + ms).toISOString();
    expect(calcularAlertaReloj(null, servidor)).toBe(false);
    expect(calcularAlertaReloj(undefined, servidor)).toBe(false);
    expect(calcularAlertaReloj(desfase(ALERTA_RELOJ_MS), servidor)).toBe(false);
    expect(calcularAlertaReloj(desfase(ALERTA_RELOJ_MS + 1), servidor)).toBe(true);
    expect(calcularAlertaReloj(desfase(-ALERTA_RELOJ_MS - 1), servidor)).toBe(true);
  });

  it('inserta la fila completa (simple y condicional)', async () => {
    const entidadId = uuidv7();
    const cliente = '2026-10-29T19:00:00.000Z';
    const servidor = '2026-10-29T20:00:00.000Z';
    await env.DB.batch([
      sentenciaAuditoria(env.DB, {
        entidad: 'devices',
        entidad_id: entidadId,
        accion: 'prueba.simple',
        actor_id: null,
        device_id: null,
        despues: { id: entidadId, nombre: 'Tablet', secreto: 'no' },
        client_at: cliente,
        server_at: servidor,
      }),
      sentenciaAuditoriaCondicional(
        env.DB,
        {
          entidad: 'devices',
          entidad_id: entidadId,
          accion: 'prueba.no',
          actor_id: null,
          device_id: null,
        },
        { sql: '1 = 0', parametros: [] },
      ),
      sentenciaAuditoriaCondicional(
        env.DB,
        {
          entidad: 'devices',
          entidad_id: entidadId,
          accion: 'prueba.si',
          actor_id: null,
          device_id: null,
        },
        { sql: '? = ?', parametros: [1, 1] },
      ),
    ]);
    const { results } = await env.DB.prepare(
      'SELECT accion, datos_antes, datos_despues, client_at, server_at, alerta_reloj FROM audit_log WHERE entidad_id = ? ORDER BY seq',
    )
      .bind(entidadId)
      .all();
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      accion: 'prueba.simple',
      datos_antes: null,
      datos_despues: JSON.stringify({ id: entidadId, nombre: 'Tablet' }),
      client_at: cliente,
      server_at: servidor,
      alerta_reloj: 1,
    });
    expect(results[1]).toMatchObject({ accion: 'prueba.si', alerta_reloj: 0, client_at: null });
  });
});

// B6 (docs/correcciones-v1.1.md; ADR 0007): un hash de contraseña con menos de 100.000 iteraciones
// se acepta una vez y se recalcula a 100.000 en el login correcto, en el MISMO batch que la
// auditoría del login. La auditoría del recálculo no lleva el hash (ni el viejo ni el nuevo).
import { PBKDF2_ITERACIONES_SERVIDOR, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { aBase64, bytesAleatorios } from '../src/auth/codificacion';
import {
  hashearContrasena,
  necesitaRehash,
  sentenciasRehash,
  verificarContrasena,
} from '../src/auth/contrasenas';
import {
  crearUsuarioConClave,
  esperarAuditoriaSinSecretos,
  iniciarSesion,
  peticion,
  type UsuarioPrueba,
} from './auth-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ACCION_REHASH = 'usuario.rehash';
const secretos: string[] = [];

/** Hash en el formato de la ADR 0007 con las iteraciones indicadas (como uno heredado). */
async function hashConIteraciones(contrasena: string, iteraciones: number): Promise<string> {
  const sal = bytesAleatorios(16);
  const clave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(contrasena),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteraciones },
    clave,
    256,
  );
  return `pbkdf2-sha256$${String(iteraciones)}$${aBase64(sal)}$${aBase64(new Uint8Array(bits))}`;
}

async function usuarioConIteraciones(
  iteraciones: number,
): Promise<UsuarioPrueba & { hash: string }> {
  const u = await crearUsuarioConClave('supervisor');
  const hash = await hashConIteraciones(u.password, iteraciones);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, u.id).run();
  secretos.push(u.password, hash);
  return { ...u, hash };
}

async function hashGuardado(userId: string): Promise<string> {
  const fila = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string }>();
  return fila?.password_hash ?? '';
}

async function auditoriaRehash(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT entidad, entidad_id, actor_id, device_id, datos_antes, datos_despues, server_at
     FROM audit_log WHERE entidad = 'users' AND entidad_id = ? AND accion = ?`,
  )
    .bind(userId, ACCION_REHASH)
    .all<{
      entidad: string;
      entidad_id: string;
      actor_id: string | null;
      device_id: string | null;
      datos_antes: string | null;
      datos_despues: string | null;
      server_at: string;
    }>();
  return results;
}

async function serverAtInicioSesion(userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT server_at FROM audit_log WHERE accion = 'sesion.inicio' AND actor_id = ?`,
  )
    .bind(userId)
    .all<{ server_at: string }>();
  return results.map((r) => r.server_at);
}

describe('B6: recálculo del hash de contraseña con pocas iteraciones', () => {
  it('un hash de 10.000 iteraciones se acepta y queda recalculado a 100.000, auditado sin el hash', async () => {
    const u = await usuarioConIteraciones(10_000);
    const sesion = await iniciarSesion(u);
    secretos.push(sesion.refresh, sesion.cuerpo.access_token);

    const nuevo = await hashGuardado(u.id);
    expect(nuevo).not.toBe(u.hash);
    expect(nuevo.startsWith(`pbkdf2-sha256$${String(PBKDF2_ITERACIONES_SERVIDOR)}$`)).toBe(true);
    expect(PBKDF2_ITERACIONES_SERVIDOR).toBe(100_000);
    expect(await verificarContrasena(u.password, nuevo)).toBe(true);
    expect(await verificarContrasena(`${u.password}x`, nuevo)).toBe(false);

    // Una fila de auditoría, del propio usuario y su dispositivo, en el mismo batch del login
    // (misma hora de servidor que `sesion.inicio`), sin el hash.
    const filas = await auditoriaRehash(u.id);
    expect(filas).toHaveLength(1);
    const [fila] = filas;
    expect(fila?.actor_id).toBe(u.id);
    expect(fila?.device_id).toBe(sesion.deviceId);
    expect(await serverAtInicioSesion(u.id)).toContain(fila?.server_at);
    expect(fila?.datos_antes).toBeNull();
    expect(JSON.parse(fila?.datos_despues ?? 'null')).toEqual({
      id: u.id,
      updated_at: fila?.server_at,
    });
    expect(`${fila?.datos_despues ?? ''}`).not.toContain('pbkdf2');

    // El siguiente login usa el hash nuevo y ya no recalcula.
    const otra = await iniciarSesion(u);
    secretos.push(otra.refresh, otra.cuerpo.access_token);
    expect(await hashGuardado(u.id)).toBe(nuevo);
    expect(await auditoriaRehash(u.id)).toHaveLength(1);
  });

  it('con la contraseña equivocada no se recalcula ni se audita', async () => {
    const u = await usuarioConIteraciones(10_000);
    const respuesta = await peticion('/api/v1/auth/login', {
      body: { email: u.email, password: `${u.password}-mal`, device_id: uuidv7() },
      ip: '198.51.100.61',
    });
    expect(respuesta.status).toBe(401);
    expect(await hashGuardado(u.id)).toBe(u.hash);
    expect(await auditoriaRehash(u.id)).toHaveLength(0);
  });

  it('un hash de 100.000 iteraciones no cambia', async () => {
    const u = await crearUsuarioConClave('supervisor');
    secretos.push(u.password);
    const antes = await hashGuardado(u.id);
    const sesion = await iniciarSesion(u);
    secretos.push(sesion.refresh, sesion.cuerpo.access_token);
    expect(await hashGuardado(u.id)).toBe(antes);
    expect(await auditoriaRehash(u.id)).toHaveLength(0);
  });

  it('necesitaRehash: solo un hash válido con menos de 100.000 iteraciones', async () => {
    expect(necesitaRehash(await hashConIteraciones('Clave-Prueba-1', 10_000))).toBe(true);
    expect(necesitaRehash(await hashConIteraciones('Clave-Prueba-1', 99_999))).toBe(true);
    expect(necesitaRehash(await hashearContrasena('Clave-Prueba-1'))).toBe(false);
    expect(necesitaRehash('pbkdf2-sha256$100001$AAAAAAAAAAAAAAAAAAAAAA==$AAAA')).toBe(false);
    expect(necesitaRehash('formato-desconocido')).toBe(false);
    expect(necesitaRehash('')).toBe(false);
  });

  it('carrera: si el hash cambió entre la verificación y el batch, no se pisa ni se audita', async () => {
    const u = await usuarioConIteraciones(10_000);
    // Dispositivo del usuario (la auditoría lo referencia): el de una sesión real. Esa sesión ya
    // recalculó el hash; se vuelve a dejar uno de 10.000 para la prueba.
    const sesion = await iniciarSesion(u);
    secretos.push(sesion.refresh, sesion.cuerpo.access_token);
    const debil = await hashConIteraciones(u.password, 10_000);
    secretos.push(debil);
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(debil, u.id).run();
    const auditadasAntes = (await auditoriaRehash(u.id)).length;

    // Entre la verificación (que leyó `u.hash`) y el batch, un admin restableció la contraseña
    // (ahora es `debil`): el UPDATE condicional no aplica y no hay auditoría.
    const nuevo = await hashearContrasena(u.password);
    secretos.push(nuevo);
    const ahora = new Date().toISOString();
    const [actualizacion] = await env.DB.batch(
      sentenciasRehash(
        env.DB,
        { userId: u.id, deviceId: sesion.deviceId, anterior: u.hash, nuevo, alertaReloj: false },
        ahora,
      ),
    );
    expect(actualizacion?.meta.changes).toBe(0);
    expect(await hashGuardado(u.id)).toBe(debil);
    expect(await auditoriaRehash(u.id)).toHaveLength(auditadasAntes);

    // Con el hash vigente como `anterior`, sí aplica y se audita una vez.
    const [aplicada] = await env.DB.batch(
      sentenciasRehash(
        env.DB,
        { userId: u.id, deviceId: sesion.deviceId, anterior: debil, nuevo, alertaReloj: true },
        ahora,
      ),
    );
    expect(aplicada?.meta.changes).toBe(1);
    expect(await hashGuardado(u.id)).toBe(nuevo);
    expect(await auditoriaRehash(u.id)).toHaveLength(auditadasAntes + 1);
    const alerta = await env.DB.prepare(
      `SELECT alerta_reloj FROM audit_log
       WHERE entidad = 'users' AND entidad_id = ? AND accion = ? AND server_at = ?`,
    )
      .bind(u.id, ACCION_REHASH, ahora)
      .first<{ alerta_reloj: number }>();
    expect(alerta?.alerta_reloj).toBe(1);
  });

  it('la auditoría no contiene secretos', async () => {
    await esperarAuditoriaSinSecretos(secretos);
  });
});

// A1 (docs/correcciones-v1.2.md, ADR 0028) en usuarios, sesiones, login y cupos: la auditoría y las
// dependientes (revocar sesiones, reiniciar cupos) quedan condicionadas a la marca de la sentencia
// principal de ese mismo batch.
//
// Técnica (determinista): dos planes (o dos batches) con el MISMO `ahora` sobre el mismo estado
// inicial, ejecutados uno tras otro contra la D1 local real; o una escritura real de otra petición
// en el mismo milisegundo entre la lectura y el batch.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sentenciasRehash } from '../src/auth/contrasenas';
import { type Reserva, sentenciasReinicioTrasLogin } from '../src/auth/cupos';
import {
  ACCION_REVOCADA_POR_OTRO_INICIO,
  revocarFamilia,
  sentenciasDesbloqueoHeredado,
  sentenciasRevocarAjenas,
} from '../src/auth/sesiones';
import { buscarUsuarioConMarca, planEditarUsuario } from '../src/rutas/usuarios';
import { contarAuditoria, horaFija } from './correcciones-a1-helpers';
import { crearDispositivo, crearUsuario, insertar } from './fixtures-db';

const HASH_INICIAL = 'pbkdf2-sha256$100000$c2Fs$aGFzaA';

/** Familia de refresh vigente (dos tokens: el rotado y el vigente) del usuario. */
async function familia(userId: string, deviceId: string) {
  const familiaId = uuidv7();
  const tokenId = uuidv7();
  const t = new Date().toISOString();
  const expira = new Date(Date.now() + 86_400_000).toISOString();
  for (const id of [uuidv7(), tokenId]) {
    await insertar('refresh_tokens', {
      id,
      user_id: userId,
      device_id: deviceId,
      token_hash: uuidv7().replaceAll('-', '').padEnd(64, '0'),
      familia_id: familiaId,
      expira_at: expira,
      created_at: t,
      updated_at: t,
    });
  }
  return { familiaId, tokenId };
}

async function vigentes(userId: string): Promise<number> {
  const fila = await env.DB.prepare(
    'SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ? AND revocado_at IS NULL',
  )
    .bind(userId)
    .first<{ n: number }>();
  return fila?.n ?? 0;
}

async function bloquearHeredado(userId: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET intentos_fallidos = 5, bloqueado_hasta = ? WHERE id = ?')
    .bind(new Date(Date.now() + 900_000).toISOString(), userId)
    .run();
}

async function cupoBloqueado(userId: string, origen: string, ahora: string): Promise<void> {
  await insertar('login_cupos', {
    user_id: userId,
    origen,
    fallos: 5,
    ventana_inicio: ahora,
    bloqueado_hasta: new Date(Date.parse(ahora) + 900_000).toISOString(),
    reserva_id: uuidv7(),
    created_at: ahora,
    updated_at: ahora,
  });
}

async function usuarioConSesion() {
  const admin = await crearUsuario('admin');
  const adminDevice = await crearDispositivo(admin);
  const id = await crearUsuario('supervisor');
  const deviceId = await crearDispositivo(id);
  const { familiaId, tokenId } = await familia(id, deviceId);
  return { admin, adminDevice, id, deviceId, familiaId, tokenId };
}

async function leerConMarca(id: string) {
  const leido = await buscarUsuarioConMarca(env.DB, id);
  if (leido === null) {
    throw new Error('usuario inexistente');
  }
  return leido;
}

async function leer(id: string) {
  return (await leerConMarca(id)).fila;
}

describe('A1: usuarios (editar y desbloquear)', () => {
  it('dos ediciones sobre la misma lectura con el mismo ahora: una sola usuario.editar', async () => {
    const u = await usuarioConSesion();
    const { fila: actual, marca: marcaLeida } = await leerConMarca(u.id);
    const ahora = horaFija();
    const editar = () =>
      planEditarUsuario(env.DB, {
        actual,
        marcaLeida,
        datos: { nombre: 'Nombre nuevo' },
        actor: { userId: u.admin, deviceId: u.adminDevice },
        ahora,
        alertaReloj: false,
        passwordHash: null,
      });
    const [a, b] = [editar(), editar()];

    expect((await env.DB.batch(a.sentencias))[0]?.meta.changes).toBe(1);
    expect((await env.DB.batch(b.sentencias))[0]?.meta.changes).toBe(0);

    expect(await contarAuditoria('users', u.id, 'usuario.editar')).toBe(1);
  });

  it('otra escritura del mismo usuario en el mismo milisegundo: la edición perdida no audita ni revoca', async () => {
    const u = await usuarioConSesion();
    await bloquearHeredado(u.id);
    const { fila: actual, marca: marcaLeida } = await leerConMarca(u.id);
    const ahora = horaFija();
    // El admin cambia el rol (revoca las sesiones) …
    const plan = planEditarUsuario(env.DB, {
      actual,
      marcaLeida,
      datos: { rol: 'jefe' },
      actor: { userId: u.admin, deviceId: u.adminDevice },
      ahora,
      alertaReloj: false,
      passwordHash: null,
    });
    // … y en el mismo milisegundo el usuario entra y el login limpia el bloqueo heredado.
    await env.DB.batch(sentenciasDesbloqueoHeredado(env.DB, u.id, u.deviceId, false, ahora));

    expect((await env.DB.batch(plan.sentencias))[0]?.meta.changes).toBe(0);

    expect(await contarAuditoria('users', u.id, 'usuario.editar')).toBe(0);
    expect(await vigentes(u.id)).toBe(2);
    expect((await leer(u.id)).rol).toBe('supervisor');
  });

  it('desbloquear perdido en el mismo milisegundo: no reinicia ni audita los cupos', async () => {
    const u = await usuarioConSesion();
    await bloquearHeredado(u.id);
    const ahora = horaFija();
    await cupoBloqueado(u.id, 'd:nonce-a1', ahora);
    const { fila: actual, marca: marcaLeida } = await leerConMarca(u.id);
    const plan = planEditarUsuario(env.DB, {
      actual,
      marcaLeida,
      datos: { desbloquear: true },
      actor: { userId: u.admin, deviceId: u.adminDevice },
      ahora,
      alertaReloj: false,
      passwordHash: null,
    });
    await env.DB.batch(sentenciasDesbloqueoHeredado(env.DB, u.id, u.deviceId, false, ahora));

    expect((await env.DB.batch(plan.sentencias))[0]?.meta.changes).toBe(0);

    expect(await contarAuditoria('users', u.id, 'usuario.editar')).toBe(0);
    expect(await contarAuditoria('login_cupos', u.id, 'login_cupos.desbloqueado')).toBe(0);
    const cupo = await env.DB.prepare('SELECT fallos FROM login_cupos WHERE user_id = ?')
      .bind(u.id)
      .first<{ fallos: number }>();
    expect(cupo?.fallos).toBe(5);
  });
});

describe('A1: revocación de familias', () => {
  it('logout o reutilización dos veces con el mismo ahora: una sola sesion.cierre', async () => {
    const u = await usuarioConSesion();
    const ahora = horaFija();
    const datos = {
      familiaId: u.familiaId,
      userId: u.id,
      deviceId: u.deviceId,
      tokenId: u.tokenId,
    };

    await revocarFamilia(env.DB, datos, 'sesion.cierre', false, ahora);
    await revocarFamilia(env.DB, datos, 'sesion.cierre', false, ahora);

    expect(await contarAuditoria('refresh_tokens', u.tokenId, 'sesion.cierre')).toBe(1);
    expect(await vigentes(u.id)).toBe(0);
  });

  // Antes de A1 esta auditoría ya era PREVIA al UPDATE y con su mismo predicado: no podía fallar.
  it('familias ajenas al iniciar sesión, dos batches con el mismo ahora: una sola auditoría', async () => {
    const u = await usuarioConSesion();
    const otro = await crearUsuario('supervisor');
    const otroDevice = await crearDispositivo(otro);
    const ahora = horaFija();
    const ajena = [
      { familia_id: u.familiaId, user_id: u.id, device_id: u.deviceId, token_id: u.tokenId },
    ];
    const actor = { userId: otro, deviceId: otroDevice, alertaReloj: false };
    const a = sentenciasRevocarAjenas(env.DB, ajena, actor, ahora);
    const b = sentenciasRevocarAjenas(env.DB, ajena, actor, ahora);

    await env.DB.batch(a);
    await env.DB.batch(b);

    expect(
      await contarAuditoria('refresh_tokens', u.tokenId, ACCION_REVOCADA_POR_OTRO_INICIO),
    ).toBe(1);
    expect(await vigentes(u.id)).toBe(0);
  });
});

describe('A1: login (desbloqueo heredado, rehash y cupos)', () => {
  // Antes de A1 era una auditoría previa con el predicado del UPDATE: no podía fallar.
  it('desbloqueo heredado en dos logins con el mismo ahora: un solo usuario.desbloqueado', async () => {
    const u = await usuarioConSesion();
    await bloquearHeredado(u.id);
    const ahora = horaFija();
    const a = sentenciasDesbloqueoHeredado(env.DB, u.id, u.deviceId, false, ahora);
    const b = sentenciasDesbloqueoHeredado(env.DB, u.id, u.deviceId, false, ahora);

    await env.DB.batch(a);
    await env.DB.batch(b);

    expect(await contarAuditoria('users', u.id, 'usuario.desbloqueado')).toBe(1);
    expect(await leer(u.id)).toMatchObject({ intentos_fallidos: 0, bloqueado_hasta: null });
  });

  it('rehash en dos logins sobre el mismo hash leído: un solo usuario.rehash', async () => {
    const u = await usuarioConSesion();
    const ahora = horaFija();
    // El mismo hash nuevo en los dos planes: la condición vieja dependía de ese VALOR.
    const datos = {
      userId: u.id,
      deviceId: u.deviceId,
      anterior: HASH_INICIAL,
      nuevo: 'pbkdf2-sha256$600000$bnVldmE$bnVldm8',
      alertaReloj: false,
    };
    const a = sentenciasRehash(env.DB, datos, ahora);
    const b = sentenciasRehash(env.DB, datos, ahora);

    await env.DB.batch(a);
    await env.DB.batch(b);

    expect(await contarAuditoria('users', u.id, 'usuario.rehash')).toBe(1);
  });

  // Antes de A1 era una auditoría previa con el predicado del UPDATE: no podía fallar.
  it('reinicio del cupo tras dos logins con el mismo ahora: un solo login_cupos.desbloqueado', async () => {
    const u = await usuarioConSesion();
    const ahora = horaFija();
    const origen = 'd:nonce-reinicio';
    await cupoBloqueado(u.id, origen, ahora);
    const reserva: Reserva = {
      tipo: 'dispositivo',
      userId: u.id,
      origen,
      reservaId: uuidv7(),
      ahora,
    };
    const actor = { userId: u.id, deviceId: u.deviceId, alertaReloj: false };
    const a = sentenciasReinicioTrasLogin(env.DB, reserva, actor, ahora);
    const b = sentenciasReinicioTrasLogin(env.DB, reserva, actor, ahora);

    await env.DB.batch(a);
    await env.DB.batch(b);

    expect(await contarAuditoria('login_cupos', u.id, 'login_cupos.desbloqueado')).toBe(1);
  });
});

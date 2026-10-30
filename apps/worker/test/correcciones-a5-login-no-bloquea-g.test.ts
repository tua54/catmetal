// A5 (docs/correcciones-v1.2.md; ADR 0018, enmienda 2): un login CORRECTO nunca deja bloqueado el
// tope global `g` de orígenes desconocidos. La reserva suma 1 en `g` antes de comparar el hash; si
// `g` estaba en `máximo − 1`, esa suma lo bloquea. El batch del login correcto descuenta su unidad y
// quita el bloqueo SOLO si lo puso esta misma reserva (`reserva_id`), con una `reserva_id` nueva y
// la auditoría `login_cupos.desbloqueado` (tipo global) condicionada a ella. Un bloqueo de `g`
// puesto por otra reserva (fallos reales) no se toca.
//
// Worker real y D1 local real, sin mocks. Determinista: las IP son fijas y distintas por intento
// (cada una es su propio origen en D1 y su propia clave en el limitador `ip:email`), y la reserva
// es atómica, así que `g` queda exactamente en el número de fallos enviados aunque vayan en tandas.
import { MAX_INTENTOS_LOGIN_GLOBAL, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { crearUsuarioConClave, peticion, type UsuarioPrueba } from './auth-helpers';

// PBKDF2 y decenas de logins (cada 401 tarda ≥ 400 ms): mismo límite que las demás pruebas
// pesadas del worker; no cambia ninguna aserción.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function intentar(u: UsuarioPrueba, password: string, ip: string, cookie?: string) {
  return peticion('/api/v1/auth/login', {
    body: { email: u.email, password, device_id: uuidv7() },
    ip,
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

/** `n` fallos reales, cada uno desde una IP propia (`10.<red>.<i/250>.<i%250>`), en tandas de 10. */
async function fallar(u: UsuarioPrueba, n: number, red: number): Promise<void> {
  for (let i = 0; i < n; i += 10) {
    const tanda = Array.from({ length: Math.min(10, n - i) }, (_, j) => {
      const k = i + j;
      return intentar(
        u,
        `mala-${String(k)}`,
        `10.${String(red)}.${String(Math.floor(k / 250))}.${String((k % 250) + 1)}`,
      );
    });
    for (const r of await Promise.all(tanda)) {
      expect(r.status).toBe(401);
    }
  }
}

/** Login correcto que devuelve la cabecera Cookie con `mp_dispositivo` (dispositivo conocido). */
async function loginParaCookie(u: UsuarioPrueba): Promise<string> {
  const r = await intentar(u, u.password, '192.0.2.1');
  expect(r.status).toBe(200);
  const linea = r.headers.getSetCookie().find((l) => l.startsWith('mp_dispositivo='));
  expect(linea).toBeDefined();
  return (linea ?? '').split(';')[0] ?? '';
}

async function cupoGlobal(userId: string) {
  return env.DB.prepare(
    `SELECT fallos, bloqueado_hasta, reserva_id FROM login_cupos WHERE user_id = ? AND origen = 'g'`,
  )
    .bind(userId)
    .first<{ fallos: number; bloqueado_hasta: string | null; reserva_id: string }>();
}

async function auditoriaGlobal(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT accion, actor_id, server_at, datos_despues FROM audit_log
     WHERE entidad = 'login_cupos' AND entidad_id = ? ORDER BY seq`,
  )
    .bind(userId)
    .all<{ accion: string; actor_id: string | null; server_at: string; datos_despues: string }>();
  return results
    .map((r) => ({ ...r, datos: JSON.parse(r.datos_despues) as Record<string, unknown> }))
    .filter((r) => r.datos.tipo === 'global');
}

const MAXIMO = MAX_INTENTOS_LOGIN_GLOBAL;

describe('A5: un login correcto nunca deja g bloqueado', () => {
  it('desde un dispositivo conocido, con g en máximo − 1: entra y g queda sin bloqueo y con máximo − 1', async () => {
    const u = await crearUsuarioConClave();
    const cookie = await loginParaCookie(u);
    await fallar(u, MAXIMO - 1, 1);
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAXIMO - 1, bloqueado_hasta: null });

    const r = await intentar(u, u.password, '192.0.2.2', cookie);
    expect(r.status).toBe(200);
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAXIMO - 1, bloqueado_hasta: null });

    // Trazabilidad: el bloqueo de la reserva y el desbloqueo del login correcto, uno de cada uno.
    const auditoria = await auditoriaGlobal(u.id);
    expect(auditoria.map((a) => a.accion)).toEqual([
      'login_cupos.bloqueado',
      'login_cupos.desbloqueado',
    ]);
    const [bloqueo, desbloqueo] = auditoria;
    expect(bloqueo?.actor_id).toBeNull();
    expect(desbloqueo?.actor_id).toBe(u.id);
    expect(desbloqueo?.datos).toEqual({
      user_id: u.id,
      tipo: 'global',
      fallos: MAXIMO - 1,
      bloqueado_hasta: null,
    });
    expect((desbloqueo?.server_at ?? '') >= (bloqueo?.server_at ?? '')).toBe(true);

    // El atacante no ganó intentos: el siguiente fallo desde un origen desconocido bloquea g.
    await fallar(u, 1, 2);
    expect((await cupoGlobal(u.id))?.bloqueado_hasta).not.toBeNull();
  });

  it('desde un origen desconocido, con g en máximo − 1: entra y g queda sin bloqueo y con máximo − 1', async () => {
    const u = await crearUsuarioConClave();
    await fallar(u, MAXIMO - 1, 3);
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAXIMO - 1, bloqueado_hasta: null });

    const r = await intentar(u, u.password, '198.51.100.7');
    expect(r.status).toBe(200);
    expect(await cupoGlobal(u.id)).toMatchObject({ fallos: MAXIMO - 1, bloqueado_hasta: null });
    expect((await auditoriaGlobal(u.id)).map((a) => a.accion)).toEqual([
      'login_cupos.bloqueado',
      'login_cupos.desbloqueado',
    ]);
  });

  it('un bloqueo de g puesto por OTRA reserva (fallos reales) sigue tras un login correcto', async () => {
    const u = await crearUsuarioConClave();
    const cookie = await loginParaCookie(u);
    await fallar(u, MAXIMO, 4);
    const antes = await cupoGlobal(u.id);
    expect(antes).toMatchObject({ fallos: MAXIMO });
    expect(antes?.bloqueado_hasta).not.toBeNull();

    const r = await intentar(u, u.password, '192.0.2.3', cookie);
    expect(r.status).toBe(200);
    // Ni la reserva del dispositivo (g bloqueado no cambia) ni el login correcto lo tocan.
    expect(await cupoGlobal(u.id)).toEqual(antes);
    expect((await auditoriaGlobal(u.id)).map((a) => a.accion)).toEqual(['login_cupos.bloqueado']);
  });
});

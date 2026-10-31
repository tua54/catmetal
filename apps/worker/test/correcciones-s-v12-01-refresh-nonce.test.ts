// S-v12-01 (revisión de seguridad v1.2 sobre A8): el refresh no puede fabricar cupos de
// dispositivo sin contraseña. Cuando un refresh EXITOSO tiene que emitir una entrada nueva de
// `mp_dispositivo` (la cookie presentada no trae una entrada válida del usuario), su nonce es
// DETERMINISTA por familia de refresh (HMAC con una clave derivada de REFRESH_SECRET y una etiqueta
// propia, sobre `familia_id`). Todas las rotaciones de una familia dan el mismo nonce, y por tanto el
// mismo cupo `d:<nonce>`: un refresh token robado da como mucho UN cupo de dispositivo, igual que un
// login. El login correcto sigue emitiendo un nonce aleatorio.
//
// Worker real y D1 local real, sin mocks. Determinista: no depende de tiempos ni de azar (los
// nonces aleatorios del login solo se comparan como "distintos").
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { entradaDelUsuario } from '../src/auth/dispositivo';
import {
  cookieRefresh,
  crearUsuarioConClave,
  iniciarSesion,
  peticion,
  type UsuarioPrueba,
} from './auth-helpers';

// Logins reales con PBKDF2: mismo límite que las demás pruebas pesadas del worker; no cambia
// ninguna aserción.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Refresh SIN cookie de dispositivo (solo `mp_refresh`). */
function refrescarSinDispositivo(refresh: string): Promise<Response> {
  return peticion('/api/v1/auth/refresh', { method: 'POST', cookie: refresh });
}

function valorDispositivo(respuesta: Response): string {
  const linea = respuesta.headers.getSetCookie().find((l) => l.startsWith('mp_dispositivo='));
  expect(linea, 'Set-Cookie mp_dispositivo').toBeDefined();
  return (linea ?? '').split(';')[0]?.slice('mp_dispositivo='.length) ?? '';
}

/** Nonce de la entrada válida del usuario en el valor de la cookie (falla si no es válida). */
async function nonceDe(u: UsuarioPrueba, valor: string): Promise<string> {
  const entrada = await entradaDelUsuario(env.REFRESH_SECRET, [valor], u.id, Date.now());
  expect(entrada, 'entrada válida del usuario').not.toBeNull();
  return entrada?.nonce ?? '';
}

/** `n` refresh sucesivos de la misma familia, cada uno sin cookie de dispositivo. */
async function rotaciones(refresh: string, n: number): Promise<string[]> {
  const valores: string[] = [];
  let actual = refresh;
  for (let i = 0; i < n; i += 1) {
    const r = await refrescarSinDispositivo(actual);
    expect(r.status).toBe(200);
    valores.push(valorDispositivo(r));
    actual = cookieRefresh(r)?.valor ?? '';
    expect(actual).not.toBe('');
  }
  return valores;
}

async function filasDispositivo(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT origen, fallos FROM login_cupos WHERE user_id = ? AND origen GLOB 'd:*' ORDER BY origen`,
  )
    .bind(userId)
    .all<{ origen: string; fallos: number }>();
  return results;
}

function loginFallido(u: UsuarioPrueba, valor: string): Promise<Response> {
  return peticion('/api/v1/auth/login', {
    body: { email: u.email, password: 'mala', device_id: uuidv7() },
    headers: { Cookie: `mp_dispositivo=${valor}` },
  });
}

describe('S-v12-01: el nonce que emite el refresh es determinista por familia', () => {
  it('tres refresh sucesivos de la misma familia sin cookie de dispositivo dan el mismo nonce', async () => {
    const u = await crearUsuarioConClave();
    const s = await iniciarSesion(u);
    const valores = await rotaciones(s.refresh, 3);
    const nonces = await Promise.all(valores.map((v) => nonceDe(u, v)));
    expect(new Set(nonces).size, JSON.stringify(nonces)).toBe(1);
  });

  it('un login fallido con cualquiera de esas cookies cuenta en el mismo cupo d:<nonce>', async () => {
    const u = await crearUsuarioConClave();
    const s = await iniciarSesion(u);
    const valores = await rotaciones(s.refresh, 3);
    const nonce = await nonceDe(u, valores[0] ?? '');
    for (const valor of valores) {
      expect((await loginFallido(u, valor)).status).toBe(401);
    }
    expect(await filasDispositivo(u.id)).toEqual([{ origen: `d:${nonce}`, fallos: 3 }]);
  });

  it('otra familia del mismo usuario da otro nonce; el login correcto sigue con un nonce aleatorio', async () => {
    const u = await crearUsuarioConClave();
    const a = await iniciarSesion(u);
    const b = await iniciarSesion(u);
    const [deA] = await rotaciones(a.refresh, 1);
    const [deB] = await rotaciones(b.refresh, 1);
    const nonceA = await nonceDe(u, deA ?? '');
    const nonceB = await nonceDe(u, deB ?? '');
    expect(nonceA).not.toBe(nonceB);

    // Los logins correctos emiten nonces aleatorios: distintos entre sí y de los de las familias.
    const loginA = await nonceDe(u, valorDispositivo(a.respuesta));
    const loginB = await nonceDe(u, valorDispositivo(b.respuesta));
    expect(new Set([loginA, loginB, nonceA, nonceB]).size).toBe(4);
  });

  it('con una entrada válida del usuario en la cookie, el refresh la conserva tal cual', async () => {
    const u = await crearUsuarioConClave();
    const s = await iniciarSesion(u);
    const valor = valorDispositivo(s.respuesta);
    const r = await peticion('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `mp_refresh=${s.refresh}; mp_dispositivo=${valor}` },
    });
    expect(r.status).toBe(200);
    expect(valorDispositivo(r)).toBe(valor);
  });
});

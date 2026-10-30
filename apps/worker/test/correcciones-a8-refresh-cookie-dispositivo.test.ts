// A8 (docs/correcciones-v1.2.md; ADR 0018, enmienda 2): un `POST /auth/refresh` EXITOSO pone la
// cookie del dispositivo conocido `mp_dispositivo` para el usuario de la sesión:
// - si la cookie presentada ya tiene una entrada válida de ese usuario, se conserva tal cual (mismo
//   nonce: no se reinicia su cupo `d:`) y solo se renueva el Max-Age;
// - si no, se agrega una entrada nueva, como en el login correcto (máx. 16, conserva las válidas de
//   otros usuarios).
// Un refresh fallido (token desconocido, vencido) o la detección de reutilización NO la emiten, y
// el logout tampoco la toca.
//
// Worker real y D1 local real, sin mocks. Determinista: la reutilización se fuerza envejeciendo el
// sucesor en D1 (fuera de la ventana de gracia), sin esperar.
import { uuidv7, VENTANA_GRACIA_REFRESH_MS } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  entradaDelUsuario,
  MAX_EDAD_COOKIE_DISPOSITIVO_S,
  MAX_ENTRADAS_DISPOSITIVO,
  nuevaEntrada,
} from '../src/auth/dispositivo';
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

/** Refresh con la cookie `mp_refresh` y, si se da, la cabecera `mp_dispositivo=<valor>`. */
function refrescarCon(refresh: string, dispositivo?: string): Promise<Response> {
  const partes = [`mp_refresh=${refresh}`];
  if (dispositivo !== undefined) {
    partes.push(`mp_dispositivo=${dispositivo}`);
  }
  return peticion('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { Cookie: partes.join('; ') },
  });
}

/** Valor y atributos del Set-Cookie `mp_dispositivo`, o null si la respuesta no lo trae. */
function cookieDispositivo(respuesta: Response): { valor: string; atributos: string[] } | null {
  const linea = respuesta.headers.getSetCookie().find((l) => l.startsWith('mp_dispositivo='));
  if (linea === undefined) {
    return null;
  }
  const [par = '', ...atributos] = linea.split(';').map((p) => p.trim());
  return { valor: par.slice('mp_dispositivo='.length), atributos };
}

function entradas(valor: string): string[] {
  return valor.split('~');
}

async function filasDispositivo(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT origen, fallos FROM login_cupos WHERE user_id = ? AND origen GLOB 'd:*'`,
  )
    .bind(userId)
    .all<{ origen: string; fallos: number }>();
  return results;
}

async function sesionDe(u: UsuarioPrueba) {
  const s = await iniciarSesion(u);
  const dispositivo = cookieDispositivo(s.respuesta)?.valor;
  expect(dispositivo).toBeDefined();
  return { refresh: s.refresh, dispositivo: dispositivo ?? '' };
}

describe('A8: el refresh exitoso renueva o emite mp_dispositivo', () => {
  it('sin cookie de dispositivo: el refresh la emite, válida para el usuario, y un login posterior es de dispositivo conocido', async () => {
    const u = await crearUsuarioConClave();
    const { refresh } = await sesionDe(u);

    const respuesta = await refrescarCon(refresh);
    expect(respuesta.status).toBe(200);
    const cookie = cookieDispositivo(respuesta);
    expect(cookie, 'Set-Cookie mp_dispositivo').not.toBeNull();
    expect(cookie?.atributos).toEqual(
      expect.arrayContaining([
        `Max-Age=${String(MAX_EDAD_COOKIE_DISPOSITIVO_S)}`,
        'Path=/api/v1/auth',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
      ]),
    );
    const valor = cookie?.valor ?? '';
    expect(entradas(valor)).toHaveLength(1);
    const entrada = await entradaDelUsuario(env.REFRESH_SECRET, [valor], u.id, Date.now());
    expect(entrada).not.toBeNull();

    // Un login posterior con esa cookie reserva en el cupo del dispositivo (`d:<nonce>`), no en el
    // de un origen desconocido: un fallo cuenta en `d:` con ese nonce.
    expect(await filasDispositivo(u.id)).toEqual([]);
    const fallo = await peticion('/api/v1/auth/login', {
      body: { email: u.email, password: 'mala', device_id: uuidv7() },
      headers: { Cookie: `mp_dispositivo=${valor}` },
    });
    expect(fallo.status).toBe(401);
    expect(await filasDispositivo(u.id)).toEqual([
      { origen: `d:${entrada?.nonce ?? ''}`, fallos: 1 },
    ]);
  });

  it('con una entrada válida del usuario: se conserva el mismo nonce y se renueva el Max-Age', async () => {
    const u = await crearUsuarioConClave();
    const { refresh, dispositivo } = await sesionDe(u);
    const antes = await entradaDelUsuario(env.REFRESH_SECRET, [dispositivo], u.id, Date.now());

    const respuesta = await refrescarCon(refresh, dispositivo);
    expect(respuesta.status).toBe(200);
    const cookie = cookieDispositivo(respuesta);
    expect(cookie, 'Set-Cookie mp_dispositivo').not.toBeNull();
    expect(antes).not.toBeNull();
    expect(cookie?.atributos).toContain(`Max-Age=${String(MAX_EDAD_COOKIE_DISPOSITIVO_S)}`);
    expect(cookie?.valor).toBe(dispositivo);
    const despues = await entradaDelUsuario(
      env.REFRESH_SECRET,
      [cookie?.valor ?? ''],
      u.id,
      Date.now(),
    );
    expect(despues?.nonce).toBe(antes?.nonce);
  });

  it('sin entrada del usuario: agrega una nueva primero y conserva las válidas de otros, hasta 16', async () => {
    const u = await crearUsuarioConClave();
    const { refresh } = await sesionDe(u);
    const ahora = Date.now();
    const otras = await Promise.all(
      Array.from({ length: MAX_ENTRADAS_DISPOSITIVO }, () =>
        nuevaEntrada(env.REFRESH_SECRET, uuidv7(), ahora),
      ),
    );
    const presentada = ['v1.basura', ...otras.map((e) => e.texto)].join('~');

    const respuesta = await refrescarCon(refresh, presentada);
    expect(respuesta.status).toBe(200);
    const valor = cookieDispositivo(respuesta)?.valor ?? '';
    const lista = entradas(valor);
    expect(lista).toHaveLength(MAX_ENTRADAS_DISPOSITIVO);
    expect(lista[0]?.split('.')[1]).toBe(u.id);
    // Las de otros usuarios siguen, en su orden; sale la más antigua (la última) y la basura.
    expect(lista.slice(1)).toEqual(
      otras.slice(0, MAX_ENTRADAS_DISPOSITIVO - 1).map((e) => e.texto),
    );
  });

  it('un refresh fallido no la emite (token desconocido, vencido)', async () => {
    const u = await crearUsuarioConClave();
    const { refresh, dispositivo } = await sesionDe(u);

    const desconocido = await refrescarCon('token-que-no-existe', dispositivo);
    expect(desconocido.status).toBe(401);
    expect(cookieDispositivo(desconocido)).toBeNull();

    await env.DB.prepare(
      `UPDATE refresh_tokens SET expira_at = ? WHERE user_id = ? AND revocado_at IS NULL`,
    )
      .bind(new Date(Date.now() - 1000).toISOString(), u.id)
      .run();
    const vencido = await refrescarCon(refresh);
    expect(vencido.status).toBe(401);
    expect(cookieDispositivo(vencido)).toBeNull();
  });

  it('la detección de reutilización no la emite', async () => {
    const u = await crearUsuarioConClave();
    const { refresh } = await sesionDe(u);
    const rotado = await refrescarCon(refresh);
    expect(rotado.status).toBe(200);
    const sucesor = cookieRefresh(rotado)?.valor ?? '';
    expect(sucesor).not.toBe('');
    // El sucesor sale de la ventana de gracia: presentar otra vez el token viejo es reutilización.
    await env.DB.prepare(
      `UPDATE refresh_tokens SET created_at = ? WHERE user_id = ? AND revocado_at IS NULL`,
    )
      .bind(new Date(Date.now() - VENTANA_GRACIA_REFRESH_MS - 5000).toISOString(), u.id)
      .run();

    const reutilizado = await refrescarCon(refresh);
    expect(reutilizado.status).toBe(401);
    expect(await reutilizado.json()).toMatchObject({ code: 'SESION_REVOCADA' });
    expect(cookieDispositivo(reutilizado)).toBeNull();
  });

  it('el logout no la toca', async () => {
    const u = await crearUsuarioConClave();
    const { refresh, dispositivo } = await sesionDe(u);
    const salida = await peticion('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: `mp_refresh=${refresh}; mp_dispositivo=${dispositivo}` },
    });
    expect(salida.status).toBe(204);
    expect(cookieDispositivo(salida)).toBeNull();
  });
});

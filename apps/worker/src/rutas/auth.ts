// Rutas `/api/v1/auth` (docs/spec.md §5, ADR 0007, 0008 y 0018).

import {
  ACCESS_TOKEN_TTL_S,
  ahoraIso,
  loginSchema,
  type Perfil,
  permisosDeRol,
  type RespuestaSesion,
  type Rol,
  uuidv7,
} from '@catmetal/shared';
import { type Context, Hono } from 'hono';
import {
  derivacionFicticia,
  hashearContrasena,
  necesitaRehash,
  sentenciasRehash,
  verificarContrasena,
} from '../auth/contrasenas';
import { borrarCookieRefresh, leerCookieRefresh, ponerCookieRefresh } from '../auth/cookie';
import {
  origenDeDispositivo,
  origenDeIp,
  type Reserva,
  reservarDispositivo,
  reservarOrigenDesconocido,
  sentenciasReinicioTrasLogin,
} from '../auth/cupos';
import {
  entradaDelUsuario,
  nuevaEntrada,
  ponerCookieDispositivo,
  valorRenovado,
  valoresCookieDispositivo,
  valorTrasRefresh,
} from '../auth/dispositivo';
import {
  buscarRefresh,
  type FilaRefresh,
  familiaVencida,
  iniciarSesion,
  reintentarDentroDeGracia,
  revocarFamilia,
  rotar,
  type TokenEmitido,
} from '../auth/sesiones';
import { emitirAccessToken, hashRefreshToken, verificarAccessToken } from '../auth/tokens';
import { ErrorApi } from '../errores';
import { autenticar, tokenBearer } from '../middleware/autenticar';
import { alertaRelojDePeticion } from '../middleware/hora-dispositivo';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

/** Longitud máxima del `user_agent` guardado en `devices`. */
const MAX_USER_AGENT = 256;

interface FilaUsuarioLogin {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
  password_hash: string;
  activo: number;
}

/**
 * Tiempo mínimo, desde que empieza el login, de toda respuesta 401 `CREDENCIALES_INVALIDAS`
 * (H-02 de docs/auditoria/seguridad-fase-2.md). Cubre la derivación PBKDF2 (real o ficticia) y las
 * idas a D1, para que la latencia no distinga una cuenta inexistente, inactiva, con el cupo de login
 * agotado (ADR 0018) o con la contraseña equivocada. Es un piso, no un valor exacto.
 */
export const TIEMPO_MINIMO_LOGIN_FALLIDO_MS = 400;

type LoginValidado = ReturnType<typeof loginSchema.parse>;

interface FilaPerfil {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
}

export function perfilDe(usuario: FilaPerfil): Perfil {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    rol: usuario.rol,
    permisos: permisosDeRol(usuario.rol),
  };
}

async function leerPerfil(db: D1Database, userId: string): Promise<FilaPerfil | null> {
  return db
    .prepare('SELECT id, nombre, email, rol FROM users WHERE id = ? AND activo = 1')
    .bind(userId)
    .first<FilaPerfil>();
}

/** Responde la sesión: access token nuevo, cookie con el refresh y perfil actual. */
async function responderSesion(
  c: Context<AppEnv>,
  emitido: TokenEmitido,
  usuario: FilaPerfil,
): Promise<Response> {
  const accessToken = await emitirAccessToken(c.env.JWT_SECRET, {
    sub: emitido.userId,
    did: emitido.deviceId,
    fam: emitido.familiaId,
  });
  ponerCookieRefresh(c, emitido.token, emitido.vidaRestanteS);
  const cuerpo: RespuestaSesion = {
    access_token: accessToken,
    expira_en: ACCESS_TOKEN_TTL_S,
    device_id: emitido.deviceId,
    usuario: perfilDe(usuario),
  };
  return c.json(cuerpo);
}

/**
 * Primera capa contra fuerza bruta: binding de Rate Limiting, clave IP + email (ADR 0008 punto 6).
 * No se aplica a un dispositivo conocido verificado (ADR 0018 punto 5): su cupo en D1 es más estricto
 * y así un atacante tras la misma IP pública (NAT de planta) no le agota el límite.
 */
async function limitarIntentos(c: Context<AppEnv>, email: string): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: `${ip}:${email}` });
  if (!success) {
    throw new ErrorApi('DEMASIADOS_INTENTOS');
  }
}

/** Espera `ms` milisegundos: `scheduler.wait` de workerd si existe; si no, `setTimeout`. */
export async function esperar(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (typeof scheduler !== 'undefined' && typeof scheduler.wait === 'function') {
    await scheduler.wait(ms);
    return;
  }
  await new Promise<void>((resolver) => setTimeout(resolver, ms));
}

async function login(c: Context<AppEnv>, datos: LoginValidado): Promise<Response> {
  const inicio = Date.now();
  try {
    return await intentarLogin(c, datos);
  } catch (error) {
    // H-02: toda 401 del login tarda al menos el mínimo uniforme contado desde el inicio.
    if (error instanceof ErrorApi && error.code === 'CREDENCIALES_INVALIDAS') {
      await esperar(inicio + TIEMPO_MINIMO_LOGIN_FALLIDO_MS - Date.now());
    }
    throw error;
  }
}

/**
 * Login (ADR 0018):
 * 1. se busca al usuario y, si la cookie `mp_dispositivo` trae una entrada válida suya, el intento
 *    es de su dispositivo conocido; si no, de un origen desconocido (la IP normalizada);
 * 2. primera capa (limitador `ip:email`), salvo para el dispositivo conocido; para una cuenta
 *    inexistente también aplica, así el 429 no revela si existe;
 * 3. reserva atómica del cupo en D1 ANTES de comparar el hash; sin reserva (cupo bloqueado) o con
 *    la cuenta inexistente o inactiva, derivación ficticia y la misma 401;
 * 4. con la contraseña correcta, el batch del login reinicia el cupo del origen usado y se renueva
 *    la cookie del dispositivo.
 */
async function intentarLogin(c: Context<AppEnv>, datos: LoginValidado): Promise<Response> {
  const db = c.env.DB;
  const secreto = c.env.REFRESH_SECRET;
  const ahoraMs = Date.now();
  // ADR 0019: una sola alerta de reloj para todas las filas de auditoría del login.
  const alertaReloj = alertaRelojDePeticion(c, new Date(ahoraMs).toISOString());

  const usuario = await db
    .prepare('SELECT id, nombre, email, rol, password_hash, activo FROM users WHERE email = ?')
    .bind(datos.email)
    .first<FilaUsuarioLogin>();
  const presentadas = valoresCookieDispositivo(c.req.header('Cookie'));
  const conocida =
    usuario === null ? null : await entradaDelUsuario(secreto, presentadas, usuario.id, ahoraMs);
  if (conocida === null) {
    await limitarIntentos(c, datos.email);
  }

  // Inexistente o inactivo: derivación ficticia y la misma respuesta (no se audita el correo ni se
  // crean cupos).
  if (usuario?.activo !== 1) {
    await derivacionFicticia();
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }
  const reserva: Reserva | null =
    conocida === null
      ? await reservarOrigenDesconocido(
          db,
          usuario.id,
          await origenDeIp(secreto, c.req.header('cf-connecting-ip')),
          ahoraMs,
        )
      : await reservarDispositivo(db, usuario.id, origenDeDispositivo(conocida.nonce), ahoraMs);
  // Cupo bloqueado: no se compara el hash; la respuesta es idéntica con la contraseña correcta o no.
  if (reserva === null) {
    await derivacionFicticia();
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }
  if (!(await verificarContrasena(datos.password, usuario.password_hash))) {
    // El fallo ya quedó contado (y, si tocaba, el cupo bloqueado y auditado) en la reserva.
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }
  // B6 (ADR 0007): un hash heredado con menos iteraciones se recalcula en este login correcto.
  const hashRecalculado = necesitaRehash(usuario.password_hash)
    ? await hashearContrasena(datos.password)
    : null;

  // Dispositivo: el id lo propone el cliente; si pertenece a otro usuario se asigna uno nuevo.
  const existente = await db
    .prepare('SELECT user_id FROM devices WHERE id = ?')
    .bind(datos.device_id)
    .first<{ user_id: string }>();
  const ajeno = existente !== null && existente.user_id !== usuario.id;
  const deviceId = ajeno ? uuidv7() : datos.device_id;
  const userAgent = c.req.header('User-Agent')?.slice(0, MAX_USER_AGENT) ?? null;

  // El batch del login reinicia el cupo usado (la reserva lo dejó en ≥ 1) y, si toca, guarda el hash
  // recalculado (B6) con su auditoría.
  const emitido = await iniciarSesion(db, secreto, {
    userId: usuario.id,
    deviceId,
    dispositivoNuevo: existente === null || ajeno,
    instalacionId: datos.instalacion_id ?? null,
    nombreDispositivo: datos.device_nombre ?? null,
    userAgent,
    adicionales: (ahora) => [
      ...sentenciasReinicioTrasLogin(
        db,
        reserva,
        { userId: usuario.id, deviceId, alertaReloj },
        ahora,
      ),
      ...(hashRecalculado === null
        ? []
        : sentenciasRehash(
            db,
            {
              userId: usuario.id,
              deviceId,
              anterior: usuario.password_hash,
              nuevo: hashRecalculado,
              alertaReloj,
            },
            ahora,
          )),
    ],
    alertaReloj,
  });
  // Cookie del dispositivo conocido: entrada nueva primero y las válidas de otros usuarios. Se pone
  // antes de construir la respuesta (Set-Cookie solo aparece tras un login correcto).
  const nueva = await nuevaEntrada(secreto, usuario.id, ahoraMs);
  ponerCookieDispositivo(c, await valorRenovado(secreto, presentadas, nueva, ahoraMs));
  return responderSesion(c, emitido, usuario);
}

/** Resuelve un refresh token presentado (ADR 0008 puntos 2 y 3). */
async function refrescar(c: Context<AppEnv>): Promise<Response> {
  const db = c.env.DB;
  const alertaReloj = alertaRelojDePeticion(c, ahoraIso());
  const token = leerCookieRefresh(c);
  if (token === undefined) {
    throw new ErrorApi('TOKEN_INVALIDO');
  }
  const tokenHash = await hashRefreshToken(c.env.REFRESH_SECRET, token);
  let presentado = await buscarRefresh(db, tokenHash);
  if (presentado === null) {
    borrarCookieRefresh(c);
    throw new ErrorApi('TOKEN_INVALIDO');
  }
  // B1 (docs/spec.md §5 v2.1): pasados 30 días del login con contraseña la familia no sirve, por
  // recientes que sean sus rotaciones; se exige la contraseña. Va antes de la ventana de gracia y de
  // la detección de reutilización: una familia vencida ya no da acceso, así que revocarla no
  // protege nada. También corta las familias de antes de esta corrección (rotadas con 30 días
  // nuevos), porque mide desde el primer token de la familia y no desde el vencimiento del último.
  if (familiaVencida(presentado, ahoraIso())) {
    borrarCookieRefresh(c);
    throw new ErrorApi('TOKEN_INVALIDO');
  }

  let emitido: TokenEmitido | null = null;
  if (presentado.revocado_at === null) {
    if (presentado.usuario_activo !== 1) {
      borrarCookieRefresh(c);
      throw new ErrorApi('SESION_REVOCADA');
    }
    if (presentado.expira_at <= ahoraIso()) {
      borrarCookieRefresh(c);
      throw new ErrorApi('TOKEN_INVALIDO');
    }
    emitido = await rotar(db, c.env.REFRESH_SECRET, presentado, alertaReloj);
    if (emitido === null) {
      // Otro refresh con el mismo token ganó la carrera: se relee y se trata como reutilizado.
      presentado = (await buscarRefresh(db, tokenHash)) ?? presentado;
    }
  }

  if (emitido === null) {
    emitido = await resolverRevocado(c, presentado, alertaReloj);
  }

  const usuario = await leerPerfil(db, emitido.userId);
  if (usuario === null) {
    borrarCookieRefresh(c);
    throw new ErrorApi('SESION_REVOCADA');
  }
  // A8 (ADR 0018, enmienda 2): solo un refresh exitoso (rotación o reintento legítimo dentro de la
  // ventana de gracia) llega aquí; los errores y la detección de reutilización lanzan antes. Se
  // conserva la entrada válida del usuario (mismo nonce) o se agrega una nueva.
  ponerCookieDispositivo(
    c,
    await valorTrasRefresh(
      c.env.REFRESH_SECRET,
      valoresCookieDispositivo(c.req.header('Cookie')),
      emitido.userId,
      Date.now(),
    ),
  );
  return responderSesion(c, emitido, usuario);
}

/**
 * Token ya revocado. Si fue rotado y su sucesor es reciente (≤ 30 s) y sigue vigente, es un
 * reintento legítimo. Si no, es una reutilización: se revoca toda la familia y se audita.
 */
async function resolverRevocado(
  c: Context<AppEnv>,
  presentado: FilaRefresh,
  alertaReloj: boolean,
): Promise<TokenEmitido> {
  const db = c.env.DB;
  if (presentado.reemplazado_por === null) {
    // Revocado por logout, nuevo login o administración: no hay sucesor que proteger.
    borrarCookieRefresh(c);
    throw new ErrorApi('SESION_REVOCADA');
  }
  const reintento = await reintentarDentroDeGracia(
    db,
    c.env.REFRESH_SECRET,
    presentado,
    alertaReloj,
  );
  if (reintento !== null) {
    return reintento;
  }
  await revocarFamilia(
    db,
    {
      familiaId: presentado.familia_id,
      userId: presentado.user_id,
      deviceId: presentado.device_id,
      tokenId: presentado.id,
    },
    'sesion.reutilizacion',
    alertaReloj,
  );
  borrarCookieRefresh(c);
  throw new ErrorApi('SESION_REVOCADA');
}

interface FamiliaARevocar {
  familiaId: string;
  userId: string;
  deviceId: string;
  tokenId: string;
}

/**
 * Cierra la sesión: revoca la familia de la cookie o, si no hay cookie, la del access token.
 *
 * H-10 (tablet compartida): si la cookie es de un usuario y el Bearer de OTRO, se revocan las dos
 * familias. La del Bearer, porque quien pulsa "Salir" es el usuario de la pantalla (el del
 * access token) y su sesión no debe sobrevivir; la de la cookie, porque fue presentada en este
 * dispositivo y no se sabe a quién pertenece la intención: lo seguro es cerrarla también.
 */
async function cerrarSesion(c: Context<AppEnv>): Promise<Response> {
  const db = c.env.DB;
  const alertaReloj = alertaRelojDePeticion(c, ahoraIso());
  let deCookie: FamiliaARevocar | null = null;

  const token = leerCookieRefresh(c);
  if (token !== undefined) {
    const fila = await buscarRefresh(db, await hashRefreshToken(c.env.REFRESH_SECRET, token));
    if (fila !== null) {
      deCookie = {
        familiaId: fila.familia_id,
        userId: fila.user_id,
        deviceId: fila.device_id,
        tokenId: fila.id,
      };
    }
  }
  const bearer = tokenBearer(c.req.header('Authorization'));
  const claims = bearer === null ? null : await verificarAccessToken(c.env.JWT_SECRET, bearer);
  const delBearer: FamiliaARevocar | null =
    claims === null
      ? null
      : { familiaId: claims.fam, userId: claims.sub, deviceId: claims.did, tokenId: claims.fam };

  const familias: FamiliaARevocar[] = [];
  if (deCookie !== null) {
    familias.push(deCookie);
  }
  if (delBearer !== null && (deCookie === null || deCookie.userId !== delBearer.userId)) {
    familias.push(delBearer);
  }
  for (const familia of familias) {
    await revocarFamilia(db, familia, 'sesion.cierre', alertaReloj);
  }
  borrarCookieRefresh(c);
  return c.body(null, 204);
}

export function crearRutasAuth(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  rutas.post('/login', validar('json', loginSchema), (c) => login(c, c.req.valid('json')));
  rutas.post('/refresh', refrescar);
  rutas.post('/logout', cerrarSesion);
  rutas.get('/me', autenticar, async (c) => {
    const usuario = await leerPerfil(c.env.DB, c.get('sesion').userId);
    if (usuario === null) {
      throw new ErrorApi('SESION_REVOCADA');
    }
    return c.json(perfilDe(usuario));
  });

  return rutas;
}

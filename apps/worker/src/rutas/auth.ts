// Rutas `/api/v1/auth` (docs/spec.md §5, ADR 0007 y 0008).

import {
  ACCESS_TOKEN_TTL_S,
  ahoraIso,
  BLOQUEO_MINUTOS,
  loginSchema,
  MAX_INTENTOS_LOGIN,
  type Perfil,
  permisosDeRol,
  type RespuestaSesion,
  type Rol,
  uuidv7,
} from '@catmetal/shared';
import { type Context, Hono } from 'hono';
import { sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { derivacionFicticia, verificarContrasena } from '../auth/contrasenas';
import { borrarCookieRefresh, leerCookieRefresh, ponerCookieRefresh } from '../auth/cookie';
import {
  buscarRefresh,
  type FilaRefresh,
  iniciarSesion,
  reintentarDentroDeGracia,
  revocarFamilia,
  rotar,
  type TokenEmitido,
} from '../auth/sesiones';
import { emitirAccessToken, hashRefreshToken, verificarAccessToken } from '../auth/tokens';
import { ErrorApi } from '../errores';
import { autenticar, tokenBearer } from '../middleware/autenticar';
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
}

/**
 * Tiempo mínimo, desde que empieza el login, de toda respuesta 401 `CREDENCIALES_INVALIDAS`
 * (H-02 de docs/auditoria/seguridad-fase-2.md). Cubre la derivación PBKDF2 (real o ficticia) y las
 * idas a D1, para que la latencia no distinga una cuenta inexistente, inactiva, bloqueada o con la
 * contraseña equivocada. Es un piso, no un valor exacto.
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
  ponerCookieRefresh(c, emitido.token);
  const cuerpo: RespuestaSesion = {
    access_token: accessToken,
    expira_en: ACCESS_TOKEN_TTL_S,
    device_id: emitido.deviceId,
    usuario: perfilDe(usuario),
  };
  return c.json(cuerpo);
}

/** Primera capa contra fuerza bruta: binding de Rate Limiting, clave IP + email (ADR 0008 punto 6). */
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

/**
 * Reserva un intento de login ANTES de comparar el hash (H-01; ADR 0008 punto 6). Un único
 * `UPDATE … RETURNING` condicional cuenta el intento como fallido de antemano:
 *
 * - solo aplica si la cuenta está activa y no bloqueada (`bloqueado_hasta` NULL o vencido);
 * - si el bloqueo anterior ya venció, el contador vuelve a 1 y se limpia `bloqueado_hasta`;
 * - al llegar a MAX_INTENTOS_LOGIN fija `bloqueado_hasta`, y la auditoría `usuario.bloqueado` se
 *   inserta en el MISMO batch, condicionada a que este intento haya fijado ese bloqueo (y sin
 *   duplicarla si otro intento del mismo milisegundo calculó el mismo `bloqueado_hasta`).
 *
 * D1 ejecuta cada batch de forma serial y atómica: N intentos concurrentes no pueden reservar más
 * de MAX_INTENTOS_LOGIN; los demás no obtienen fila. Si la contraseña resulta correcta,
 * `iniciarSesion` reinicia el contador (y audita el desbloqueo si la cuenta quedó bloqueada).
 * Devuelve `true` si el intento quedó reservado.
 */
async function reservarIntento(db: D1Database, userId: string): Promise<boolean> {
  const ahora = ahoraIso();
  const hasta = new Date(Date.parse(ahora) + BLOQUEO_MINUTOS * 60_000).toISOString();
  const nuevoContador = `CASE WHEN bloqueado_hasta IS NOT NULL AND bloqueado_hasta <= ?1 THEN 1 ELSE intentos_fallidos + 1 END`;
  const [reserva] = await db.batch<{ intentos_fallidos: number; bloqueado_hasta: string | null }>([
    db
      .prepare(
        `UPDATE users SET
           intentos_fallidos = ${nuevoContador},
           bloqueado_hasta = CASE WHEN ${nuevoContador} >= ?2 THEN ?3 ELSE NULL END,
           updated_at = ?1
         WHERE id = ?4 AND activo = 1 AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= ?1)
         RETURNING intentos_fallidos, bloqueado_hasta`,
      )
      .bind(ahora, MAX_INTENTOS_LOGIN, hasta, userId),
    sentenciaAuditoriaCondicional(
      db,
      {
        entidad: 'users',
        entidad_id: userId,
        accion: 'usuario.bloqueado',
        actor_id: null,
        device_id: null,
        despues: { id: userId, intentos_fallidos: MAX_INTENTOS_LOGIN, bloqueado_hasta: hasta },
        server_at: ahora,
      },
      {
        sql: `EXISTS (SELECT 1 FROM users WHERE id = ? AND bloqueado_hasta = ? AND updated_at = ?)
          AND NOT EXISTS (SELECT 1 FROM audit_log WHERE entidad = 'users' AND entidad_id = ?
            AND accion = 'usuario.bloqueado'
            AND json_extract(datos_despues, '$.bloqueado_hasta') = ?)`,
        parametros: [userId, hasta, ahora, userId, hasta],
      },
    ),
  ]);
  return (reserva?.results.length ?? 0) === 1;
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

async function intentarLogin(c: Context<AppEnv>, datos: LoginValidado): Promise<Response> {
  const db = c.env.DB;
  await limitarIntentos(c, datos.email);

  const usuario = await db
    .prepare('SELECT id, nombre, email, rol, password_hash FROM users WHERE email = ?')
    .bind(datos.email)
    .first<FilaUsuarioLogin>();

  // Inexistente: derivación ficticia y la misma respuesta (no se audita el correo).
  if (usuario === null) {
    await derivacionFicticia();
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }
  // Inactivo o bloqueado: no hay reserva ni se compara el hash; la respuesta es idéntica con la
  // contraseña correcta o no.
  if (!(await reservarIntento(db, usuario.id))) {
    await derivacionFicticia();
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }
  if (!(await verificarContrasena(datos.password, usuario.password_hash))) {
    // El intento ya quedó contado (y, si tocaba, la cuenta bloqueada) en la reserva.
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }

  // Dispositivo: el id lo propone el cliente; si pertenece a otro usuario se asigna uno nuevo.
  const existente = await db
    .prepare('SELECT user_id FROM devices WHERE id = ?')
    .bind(datos.device_id)
    .first<{ user_id: string }>();
  const ajeno = existente !== null && existente.user_id !== usuario.id;
  const deviceId = ajeno ? uuidv7() : datos.device_id;
  const userAgent = c.req.header('User-Agent')?.slice(0, MAX_USER_AGENT) ?? null;

  // `iniciarSesion` siempre reinicia el contador: la reserva lo dejó en ≥ 1.
  const emitido = await iniciarSesion(db, c.env.REFRESH_SECRET, {
    userId: usuario.id,
    deviceId,
    dispositivoNuevo: existente === null || ajeno,
    instalacionId: datos.instalacion_id ?? null,
    nombreDispositivo: datos.device_nombre ?? null,
    userAgent,
  });
  return responderSesion(c, emitido, usuario);
}

/** Resuelve un refresh token presentado (ADR 0008 puntos 2 y 3). */
async function refrescar(c: Context<AppEnv>): Promise<Response> {
  const db = c.env.DB;
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
    emitido = await rotar(db, c.env.REFRESH_SECRET, presentado);
    if (emitido === null) {
      // Otro refresh con el mismo token ganó la carrera: se relee y se trata como reutilizado.
      presentado = (await buscarRefresh(db, tokenHash)) ?? presentado;
    }
  }

  if (emitido === null) {
    emitido = await resolverRevocado(c, presentado);
  }

  const usuario = await leerPerfil(db, emitido.userId);
  if (usuario === null) {
    borrarCookieRefresh(c);
    throw new ErrorApi('SESION_REVOCADA');
  }
  return responderSesion(c, emitido, usuario);
}

/**
 * Token ya revocado. Si fue rotado y su sucesor es reciente (≤ 30 s) y sigue vigente, es un
 * reintento legítimo. Si no, es una reutilización: se revoca toda la familia y se audita.
 */
async function resolverRevocado(
  c: Context<AppEnv>,
  presentado: FilaRefresh,
): Promise<TokenEmitido> {
  const db = c.env.DB;
  if (presentado.reemplazado_por === null) {
    // Revocado por logout, nuevo login o administración: no hay sucesor que proteger.
    borrarCookieRefresh(c);
    throw new ErrorApi('SESION_REVOCADA');
  }
  const reintento = await reintentarDentroDeGracia(db, c.env.REFRESH_SECRET, presentado);
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
    await revocarFamilia(db, familia, 'sesion.cierre');
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

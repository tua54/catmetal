// Rutas `/api/v1/auth` (docs/spec.md §5, ADR 0007 y 0008).

import {
  ACCESS_TOKEN_TTL_S,
  ahoraIso,
  BLOQUEO_MINUTOS,
  loginSchema,
  MAX_INTENTOS_LOGIN,
  type Perfil,
  permisosDeRol,
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
  activo: number;
  password_hash: string;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
}

interface FilaPerfil {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
}

export interface RespuestaSesion {
  access_token: string;
  /** Segundos de vida del access token. */
  expira_en: number;
  device_id: string;
  usuario: Perfil;
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

/**
 * Intento fallido: contador atómico en SQL (ADR 0008 punto 6). Si el bloqueo anterior ya venció,
 * el contador vuelve a 1; al llegar a MAX_INTENTOS_LOGIN se fija `bloqueado_hasta`. La auditoría
 * `usuario.bloqueado` es condicional en el mismo batch.
 */
async function registrarFallo(db: D1Database, usuario: FilaUsuarioLogin): Promise<void> {
  const ahora = ahoraIso();
  const hasta = new Date(Date.parse(ahora) + BLOQUEO_MINUTOS * 60_000).toISOString();
  const nuevoContador = `CASE WHEN bloqueado_hasta IS NOT NULL AND bloqueado_hasta <= ?1 THEN 1 ELSE intentos_fallidos + 1 END`;
  await db.batch([
    db
      .prepare(
        `UPDATE users SET
           intentos_fallidos = ${nuevoContador},
           bloqueado_hasta = CASE
             WHEN ${nuevoContador} >= ?2 THEN ?3
             WHEN bloqueado_hasta IS NOT NULL AND bloqueado_hasta <= ?1 THEN NULL
             ELSE bloqueado_hasta
           END,
           updated_at = ?1
         WHERE id = ?4`,
      )
      .bind(ahora, MAX_INTENTOS_LOGIN, hasta, usuario.id),
    sentenciaAuditoriaCondicional(
      db,
      {
        entidad: 'users',
        entidad_id: usuario.id,
        accion: 'usuario.bloqueado',
        actor_id: null,
        device_id: null,
        despues: { id: usuario.id, intentos_fallidos: MAX_INTENTOS_LOGIN, bloqueado_hasta: hasta },
        server_at: ahora,
      },
      {
        sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND bloqueado_hasta = ?)',
        parametros: [usuario.id, hasta],
      },
    ),
  ]);
}

async function login(c: Context<AppEnv>, datos: ReturnType<typeof loginSchema.parse>) {
  const db = c.env.DB;
  await limitarIntentos(c, datos.email);

  const usuario = await db
    .prepare(
      `SELECT id, nombre, email, rol, activo, password_hash, intentos_fallidos, bloqueado_hasta
       FROM users WHERE email = ?`,
    )
    .bind(datos.email)
    .first<FilaUsuarioLogin>();

  // Inexistente o inactivo: derivación ficticia y la misma respuesta (no se audita el correo).
  if (usuario === null || usuario.activo !== 1) {
    await derivacionFicticia();
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }
  const ahora = ahoraIso();
  // Bloqueado: no se compara el hash; la respuesta es idéntica con contraseña correcta o no.
  if (usuario.bloqueado_hasta !== null && usuario.bloqueado_hasta > ahora) {
    await derivacionFicticia();
    throw new ErrorApi('CREDENCIALES_INVALIDAS');
  }
  if (!(await verificarContrasena(datos.password, usuario.password_hash))) {
    await registrarFallo(db, usuario);
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

  const emitido = await iniciarSesion(db, c.env.REFRESH_SECRET, {
    userId: usuario.id,
    deviceId,
    dispositivoNuevo: existente === null || ajeno,
    instalacionId: datos.instalacion_id ?? null,
    nombreDispositivo: datos.device_nombre ?? null,
    userAgent,
    reiniciarIntentos: usuario.intentos_fallidos !== 0 || usuario.bloqueado_hasta !== null,
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

/** Cierra la sesión: revoca la familia de la cookie o, si no hay cookie, la del access token. */
async function cerrarSesion(c: Context<AppEnv>): Promise<Response> {
  const db = c.env.DB;
  let familia: { familiaId: string; userId: string; deviceId: string; tokenId: string } | null =
    null;

  const token = leerCookieRefresh(c);
  if (token !== undefined) {
    const fila = await buscarRefresh(db, await hashRefreshToken(c.env.REFRESH_SECRET, token));
    if (fila !== null) {
      familia = {
        familiaId: fila.familia_id,
        userId: fila.user_id,
        deviceId: fila.device_id,
        tokenId: fila.id,
      };
    }
  }
  if (familia === null) {
    const bearer = tokenBearer(c.req.header('Authorization'));
    const claims = bearer === null ? null : await verificarAccessToken(c.env.JWT_SECRET, bearer);
    if (claims !== null) {
      familia = {
        familiaId: claims.fam,
        userId: claims.sub,
        deviceId: claims.did,
        tokenId: claims.fam,
      };
    }
  }
  if (familia !== null) {
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

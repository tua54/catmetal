// Cupos de login por (cuenta, origen) en D1 (ADR 0018, M1; docs/spec.md §5 v2.1, segunda capa).
//
// Orígenes (`login_cupos.origen`):
// - `d:<nonce>`: dispositivo conocido (entrada válida de la cookie `mp_dispositivo`);
// - `ip:<hmac>`: origen desconocido, HMAC truncado de la IP normalizada (nunca la IP en claro);
// - `g`: tope global de TODOS los orígenes desconocidos de la cuenta.
//
// | Cupo                        | Fallos | Ventana fija            | Bloqueo                    |
// | (cuenta, dispositivo)       | 5      | 15 min desde el 1.º     | 15 min, solo ese dispositivo |
// | (cuenta, origen desconocido)| 5      | 15 min                  | 15 min                     |
// | (cuenta, todos desconocidos)| 20     | 15 min                  | 15 min                     |
//
// La reserva se hace ANTES de comparar el hash y en un solo `db.batch()` (serial y atómico en D1):
// N intentos concurrentes nunca reservan más que el límite. Sin reserva no se compara el hash.

import {
  BLOQUEO_MINUTOS,
  MAX_INTENTOS_LOGIN,
  MAX_INTENTOS_LOGIN_GLOBAL,
  uuidv7,
  VENTANA_INTENTOS_LOGIN_MINUTOS,
} from '@catmetal/shared';
import { type CondicionSql, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { aBase64Url } from './codificacion';
import { hmacTruncado } from './dispositivo';

export type TipoCupo = 'dispositivo' | 'origen' | 'global';

export const ORIGEN_GLOBAL = 'g';
const ETIQUETA_IP = 'mp-ip-v1';
/** IP usada cuando no llega `cf-connecting-ip` (desarrollo local y pruebas). */
export const IP_LOCAL = 'local';

/** Filtro SQL por tipo de cupo sobre la columna `origen` (literales fijos del código). */
const FILTRO_TIPO: Readonly<Record<TipoCupo, string>> = {
  dispositivo: `origen GLOB 'd:*'`,
  origen: `origen GLOB 'ip:*'`,
  global: `origen = '${ORIGEN_GLOBAL}'`,
};

// ---------------------------------------------------------------------------------------------
// Orígenes
// ---------------------------------------------------------------------------------------------

const PATRON_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function octetosIpv4(texto: string): number[] | null {
  const partes = PATRON_IPV4.exec(texto);
  if (partes === null) {
    return null;
  }
  const octetos = partes.slice(1).map(Number);
  return octetos.every((o) => o <= 255) ? octetos : null;
}

/** Los 8 hextetos de una IPv6 (admite `::` y una IPv4 al final), o null si no es válida. */
function hextetosIpv6(texto: string): number[] | null {
  let t = texto;
  const ultimo = t.lastIndexOf(':');
  const cola = t.slice(ultimo + 1);
  if (cola.includes('.')) {
    const o = octetosIpv4(cola);
    if (o === null) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = o;
    t = `${t.slice(0, ultimo + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const mitades = t.split('::');
  if (mitades.length > 2) {
    return null;
  }
  const izquierda = mitades[0] === '' || mitades[0] === undefined ? [] : mitades[0].split(':');
  const derecha =
    mitades.length === 2 && mitades[1] !== '' && mitades[1] !== undefined
      ? mitades[1].split(':')
      : [];
  const faltan = 8 - izquierda.length - derecha.length;
  if ((mitades.length === 1 && faltan !== 0) || (mitades.length === 2 && faltan < 1)) {
    return null;
  }
  const todos = [
    ...izquierda,
    ...Array.from({ length: mitades.length === 2 ? faltan : 0 }, () => '0'),
    ...derecha,
  ];
  if (todos.length !== 8 || !todos.every((h) => /^[0-9a-f]{1,4}$/.test(h))) {
    return null;
  }
  return todos.map((h) => Number.parseInt(h, 16));
}

/**
 * IP normalizada para el cupo: IPv4 tal cual; IPv4 mapeada (`::ffff:a.b.c.d`) → IPv4; IPv6 → su
 * prefijo /64 (un cliente IPv6 controla normalmente todo su /64). Lo que no se reconoce como IP se
 * usa en minúsculas, tal cual.
 */
export function normalizarIp(ip: string | undefined): string {
  let texto = (ip ?? '').trim().toLowerCase();
  if (texto === '') {
    return IP_LOCAL;
  }
  const zona = texto.indexOf('%');
  if (zona >= 0) {
    texto = texto.slice(0, zona);
  }
  const v4 = octetosIpv4(texto);
  if (v4 !== null) {
    return v4.join('.');
  }
  if (!texto.includes(':')) {
    return texto;
  }
  const h = hextetosIpv6(texto);
  if (h === null) {
    return texto;
  }
  const [h0, h1, h2, h3, h4, h5, h6 = 0, h7 = 0] = h;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return [h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff].join('.');
  }
  return `${[h0, h1, h2, h3].map((x = 0) => x.toString(16)).join(':')}::/64`;
}

/** `ip:<HMAC-SHA-256 truncado de la IP normalizada, base64url>`. */
export async function origenDeIp(secreto: string, ip: string | undefined): Promise<string> {
  return `ip:${aBase64Url(await hmacTruncado(secreto, ETIQUETA_IP, normalizarIp(ip)))}`;
}

export function origenDeDispositivo(nonce: string): string {
  return `d:${nonce}`;
}

// ---------------------------------------------------------------------------------------------
// Reserva
// ---------------------------------------------------------------------------------------------

export interface Reserva {
  tipo: 'dispositivo' | 'origen';
  userId: string;
  origen: string;
  reservaId: string;
  /** Hora de la reserva (ISO). */
  ahora: string;
}

interface Tiempos {
  ahora: string;
  /** Una ventana iniciada en este instante o antes ya venció. */
  limiteVentana: string;
  hasta: string;
}

function tiempos(ahoraMs: number): Tiempos {
  return {
    ahora: new Date(ahoraMs).toISOString(),
    limiteVentana: new Date(ahoraMs - VENTANA_INTENTOS_LOGIN_MINUTOS * 60_000).toISOString(),
    hasta: new Date(ahoraMs + BLOQUEO_MINUTOS * 60_000).toISOString(),
  };
}

/**
 * Upsert de un cupo. Parámetros: ?1 user_id, ?2 origen de la fila, ?3 ahora, ?4 límite de la
 * ventana, ?5 máximo de fallos, ?6 bloqueado_hasta si llega al máximo, ?7 reserva_id.
 *
 * - Ventana fija: si `ventana_inicio` ya venció, el contador vuelve a 1 con una ventana nueva.
 * - Solo actualiza si no hay bloqueo vigente; si lo hay, la fila no cambia (no hay reserva).
 * - En SQLite las expresiones del SET se evalúan con los valores ANTERIORES de la fila.
 */
const NUEVOS_FALLOS = `CASE WHEN login_cupos.ventana_inicio <= ?4 THEN 1 ELSE login_cupos.fallos + 1 END`;
const AL_CONFLICTO = `ON CONFLICT (user_id, origen) DO UPDATE SET
    fallos = ${NUEVOS_FALLOS},
    ventana_inicio = CASE WHEN login_cupos.ventana_inicio <= ?4 THEN ?3 ELSE login_cupos.ventana_inicio END,
    bloqueado_hasta = CASE WHEN ${NUEVOS_FALLOS} >= ?5 THEN ?6 ELSE NULL END,
    reserva_id = ?7,
    updated_at = ?3
  WHERE login_cupos.bloqueado_hasta IS NULL OR login_cupos.bloqueado_hasta <= ?3`;
const COLUMNAS_CUPO =
  'user_id, origen, fallos, ventana_inicio, bloqueado_hasta, reserva_id, created_at, updated_at';
const FILA_NUEVA = `?1, ?2, 1, ?3, CASE WHEN 1 >= ?5 THEN ?6 ELSE NULL END, ?7, ?3, ?3`;

/** Condición: la fila (user, origen) quedó con ESTA reserva y bloqueada por ella. */
function bloqueadaPorReserva(userId: string, origen: string, reservaId: string): CondicionSql {
  return {
    sql: `EXISTS (SELECT 1 FROM login_cupos WHERE user_id = ? AND origen = ? AND reserva_id = ?
      AND bloqueado_hasta IS NOT NULL)`,
    parametros: [userId, origen, reservaId],
  };
}

/**
 * Auditoría del bloqueo de un cupo. Es una acción del SISTEMA (sin actor ni dispositivo) que
 * dispara un intento anónimo: no lleva alerta de reloj (ADR 0019 la mide por dispositivo), queda 0.
 */
function auditoriaBloqueo(
  db: D1Database,
  tipo: TipoCupo,
  userId: string,
  maximo: number,
  t: Tiempos,
  condicion: CondicionSql,
): D1PreparedStatement {
  return sentenciaAuditoriaCondicional(
    db,
    {
      entidad: 'login_cupos',
      entidad_id: userId,
      accion: 'login_cupos.bloqueado',
      actor_id: null,
      device_id: null,
      despues: { user_id: userId, tipo, fallos: maximo, bloqueado_hasta: t.hasta },
      server_at: t.ahora,
    },
    condicion,
  );
}

/**
 * Reserva en el cupo del dispositivo conocido (dos sentencias): upsert condicional con RETURNING y
 * su auditoría si esta reserva lo bloqueó. Devuelve null si el cupo está bloqueado.
 */
export async function reservarDispositivo(
  db: D1Database,
  userId: string,
  origen: string,
  ahoraMs = Date.now(),
): Promise<Reserva | null> {
  const t = tiempos(ahoraMs);
  const reservaId = uuidv7();
  const [upsert] = await db.batch([
    db
      .prepare(
        `INSERT INTO login_cupos (${COLUMNAS_CUPO}) VALUES (${FILA_NUEVA})
         ${AL_CONFLICTO}
         RETURNING fallos`,
      )
      .bind(userId, origen, t.ahora, t.limiteVentana, MAX_INTENTOS_LOGIN, t.hasta, reservaId),
    auditoriaBloqueo(
      db,
      'dispositivo',
      userId,
      MAX_INTENTOS_LOGIN,
      t,
      bloqueadaPorReserva(userId, origen, reservaId),
    ),
  ]);
  if ((upsert?.results.length ?? 0) !== 1) {
    return null;
  }
  return { tipo: 'dispositivo', userId, origen, reservaId, ahora: t.ahora };
}

/**
 * Reserva en un origen desconocido (cuatro sentencias en un batch):
 * 1. upsert de la fila `ip:` solo si la IP Y `g` tienen cupo (`INSERT … SELECT … WHERE`: el WHERE
 *    en el SELECT es obligatorio en SQLite para que `ON CONFLICT` se lea como upsert);
 * 2. incremento de `g` solo si la fila `ip:` quedó con esta reserva;
 * 3. y 4. auditorías de los bloqueos que haya fijado esta reserva.
 * Se reservan los dos cupos o ninguno: una IP bloqueada no consume `g`, y sin cupo global no se
 * crean filas de IP. Devuelve null si no hay reserva.
 */
export async function reservarOrigenDesconocido(
  db: D1Database,
  userId: string,
  origen: string,
  ahoraMs = Date.now(),
): Promise<Reserva | null> {
  const t = tiempos(ahoraMs);
  const reservaId = uuidv7();
  const [upsert] = await db.batch([
    db
      .prepare(
        `INSERT INTO login_cupos (${COLUMNAS_CUPO})
         SELECT ${FILA_NUEVA}
         WHERE NOT EXISTS (SELECT 1 FROM login_cupos
           WHERE user_id = ?1 AND origen IN (?2, ?8) AND bloqueado_hasta > ?3)
         ${AL_CONFLICTO}
         RETURNING fallos`,
      )
      .bind(
        userId,
        origen,
        t.ahora,
        t.limiteVentana,
        MAX_INTENTOS_LOGIN,
        t.hasta,
        reservaId,
        ORIGEN_GLOBAL,
      ),
    db
      .prepare(
        `INSERT INTO login_cupos (${COLUMNAS_CUPO})
         SELECT ?1, ?8, 1, ?3, CASE WHEN 1 >= ?5 THEN ?6 ELSE NULL END, ?7, ?3, ?3
         WHERE EXISTS (SELECT 1 FROM login_cupos
           WHERE user_id = ?1 AND origen = ?2 AND reserva_id = ?7)
         ${AL_CONFLICTO}`,
      )
      .bind(
        userId,
        origen,
        t.ahora,
        t.limiteVentana,
        MAX_INTENTOS_LOGIN_GLOBAL,
        t.hasta,
        reservaId,
        ORIGEN_GLOBAL,
      ),
    auditoriaBloqueo(
      db,
      'origen',
      userId,
      MAX_INTENTOS_LOGIN,
      t,
      bloqueadaPorReserva(userId, origen, reservaId),
    ),
    auditoriaBloqueo(
      db,
      'global',
      userId,
      MAX_INTENTOS_LOGIN_GLOBAL,
      t,
      bloqueadaPorReserva(userId, ORIGEN_GLOBAL, reservaId),
    ),
  ]);
  if ((upsert?.results.length ?? 0) !== 1) {
    return null;
  }
  return { tipo: 'origen', userId, origen, reservaId, ahora: t.ahora };
}

// ---------------------------------------------------------------------------------------------
// Reinicio
// ---------------------------------------------------------------------------------------------

interface Actor {
  userId: string;
  deviceId: string | null;
  /** Alerta de reloj de la petición del actor (ADR 0019); ausente → 0. */
  alertaReloj?: boolean;
}

function auditoriaDesbloqueo(
  db: D1Database,
  tipo: TipoCupo,
  userId: string,
  actor: Actor,
  ahora: string,
  condicion: CondicionSql,
): D1PreparedStatement {
  return sentenciaAuditoriaCondicional(
    db,
    {
      entidad: 'login_cupos',
      entidad_id: userId,
      accion: 'login_cupos.desbloqueado',
      actor_id: actor.userId,
      device_id: actor.deviceId,
      despues: { user_id: userId, tipo, fallos: 0, bloqueado_hasta: null },
      server_at: ahora,
      alerta_reloj: actor.alertaReloj === true,
    },
    condicion,
  );
}

/**
 * Sentencias para el MISMO batch del login correcto (después de registrar el dispositivo, que la
 * auditoría referencia):
 * - reinicia SOLO el cupo del origen usado (`d:` o `ip:`) y, si estaba bloqueado (la reserva de
 *   este mismo login lo bloqueó al ser el 5.º intento), audita el desbloqueo antes del UPDATE;
 * - el global `g` NO se reinicia (si no, cada login legítimo le regalaría al atacante otros 20
 *   intentos). Solo se descuenta el +1 de ESTA reserva, que no fue un fallo, si `g` no está
 *   bloqueado; un `g` bloqueado se deja tal cual (vence con su ventana). No se compara la
 *   ventana: con reservas concurrentes, la que abrió la ventana puede tener una hora posterior a
 *   la de otra que se ejecutó después. Si la ventana de `g` se reinició justo entre la reserva y
 *   este batch (milisegundos), la ventana nueva cuenta un fallo de menos: un efecto acotado a 1.
 */
export function sentenciasReinicioTrasLogin(
  db: D1Database,
  reserva: Reserva,
  actor: Actor,
  ahora: string,
): D1PreparedStatement[] {
  const sentencias = [
    auditoriaDesbloqueo(db, reserva.tipo, reserva.userId, actor, ahora, {
      sql: `EXISTS (SELECT 1 FROM login_cupos WHERE user_id = ? AND origen = ?
        AND bloqueado_hasta > ?)`,
      parametros: [reserva.userId, reserva.origen, ahora],
    }),
    db
      .prepare(
        `UPDATE login_cupos SET fallos = 0, bloqueado_hasta = NULL, updated_at = ?
         WHERE user_id = ? AND origen = ? AND (fallos <> 0 OR bloqueado_hasta IS NOT NULL)`,
      )
      .bind(ahora, reserva.userId, reserva.origen),
  ];
  if (reserva.tipo === 'origen') {
    sentencias.push(
      db
        .prepare(
          `UPDATE login_cupos SET fallos = fallos - 1, updated_at = ?
           WHERE user_id = ? AND origen = ? AND fallos > 0 AND bloqueado_hasta IS NULL`,
        )
        .bind(ahora, reserva.userId, ORIGEN_GLOBAL),
    );
  }
  return sentencias;
}

/**
 * Desbloqueo del admin (`PATCH /users/:id` con `desbloquear`): reinicia TODOS los cupos del
 * usuario, incluido `g`. Audita un `login_cupos.desbloqueado` por cada tipo de cupo que tenía un
 * bloqueo vigente. Todo condicionado a `condicion` (que la edición del usuario se aplicó).
 */
export function sentenciasReinicioAdmin(
  db: D1Database,
  userId: string,
  actor: Actor,
  ahora: string,
  condicion: CondicionSql,
): D1PreparedStatement[] {
  const tipos: TipoCupo[] = ['dispositivo', 'origen', 'global'];
  return [
    ...tipos.map((tipo) =>
      auditoriaDesbloqueo(db, tipo, userId, actor, ahora, {
        sql: `${condicion.sql} AND EXISTS (SELECT 1 FROM login_cupos WHERE user_id = ?
          AND ${FILTRO_TIPO[tipo]} AND bloqueado_hasta > ?)`,
        parametros: [...condicion.parametros, userId, ahora],
      }),
    ),
    db
      .prepare(
        `UPDATE login_cupos SET fallos = 0, bloqueado_hasta = NULL, updated_at = ?
         WHERE user_id = ? AND (fallos <> 0 OR bloqueado_hasta IS NOT NULL) AND ${condicion.sql}`,
      )
      .bind(ahora, userId, ...condicion.parametros),
  ];
}

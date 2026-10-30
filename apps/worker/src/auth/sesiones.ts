// Sesiones con refresh tokens rotativos (docs/spec.md §5, ADR 0008 puntos 2, 3 y 7).
//
// Toda escritura va en un único `db.batch()` con su auditoría. La rotación y el reintento son
// condicionales en SQL: gana quien obtiene `changes = 1` en el INSERT del token nuevo, así dos
// refresh concurrentes con el mismo token nunca dejan dos sucesores vigentes.

import { ahoraIso, REFRESH_TOKEN_TTL_S, uuidv7, VENTANA_GRACIA_REFRESH_MS } from '@catmetal/shared';
import { sentenciaAuditoria, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import {
  generarRefreshToken,
  hashRefreshToken,
  vencimientoFamilia,
  vencimientoRefresh,
} from './tokens';

export interface TokenEmitido {
  id: string;
  /** Valor opaco que va en la cookie; nunca se guarda ni se audita. */
  token: string;
  familiaId: string;
  userId: string;
  deviceId: string;
  /** Segundos que le quedan al token emitido (Max-Age de la cookie, B1). */
  vidaRestanteS: number;
}

/** Fila de `refresh_tokens` (sin `token_hash`) con el estado del usuario dueño. */
export interface FilaRefresh {
  id: string;
  user_id: string;
  device_id: string;
  familia_id: string;
  expira_at: string;
  revocado_at: string | null;
  reemplazado_por: string | null;
  usuario_activo: number;
  /**
   * Hora del login con contraseña que abrió la familia: `created_at` de su primer token (B1). Usa el
   * índice `refresh_tokens_familia_id`. La purga del cron solo borra tokens vencidos hace más de
   * 90 días: si ya borró el primero, la familia tiene más de 120 días y el mínimo que queda sigue
   * siendo de hace más de 30, así que la familia sigue vencida.
   */
  familia_inicio: string;
}

const COLUMNAS_FILA_REFRESH = `r.id, r.user_id, r.device_id, r.familia_id, r.expira_at,
  r.revocado_at, r.reemplazado_por, u.activo AS usuario_activo,
  (SELECT MIN(f.created_at) FROM refresh_tokens AS f WHERE f.familia_id = r.familia_id)
    AS familia_inicio`;

export async function buscarRefresh(
  db: D1Database,
  tokenHash: string,
): Promise<FilaRefresh | null> {
  return db
    .prepare(
      `SELECT ${COLUMNAS_FILA_REFRESH}
       FROM refresh_tokens AS r JOIN users AS u ON u.id = r.user_id
       WHERE r.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<FilaRefresh>();
}

/** La familia superó su vida máxima absoluta (B1): se exige la contraseña de nuevo. */
export function familiaVencida(fila: Pick<FilaRefresh, 'familia_inicio'>, ahora: string): boolean {
  return vencimientoFamilia(fila.familia_inicio) <= ahora;
}

export interface DatosNuevaSesion {
  userId: string;
  deviceId: string;
  /** El dispositivo no existe todavía: se inserta en el mismo batch. */
  dispositivoNuevo: boolean;
  instalacionId: string | null;
  nombreDispositivo: string | null;
  userAgent: string | null;
  /**
   * Sentencias adicionales para el MISMO batch, después de registrar el dispositivo (por ejemplo,
   * el reinicio del cupo de login usado, ADR 0018). Reciben la hora del batch.
   */
  adicionales?: (ahora: string) => D1PreparedStatement[];
  /** Alerta de reloj de la petición de login (ADR 0019), para todas sus filas de auditoría. */
  alertaReloj?: boolean;
}

/** Acción de auditoría de una familia revocada porque otro usuario entró en el mismo navegador. */
export const ACCION_REVOCADA_POR_OTRO_INICIO = 'sesion.revocada_por_otro_inicio';

/**
 * Tope de familias ajenas revocadas en un mismo login (acota el tamaño del batch). En una tablet
 * compartida hay pocos usuarios; si hubiera más, las restantes caerían en el siguiente login.
 */
export const MAX_FAMILIAS_AJENAS_POR_INICIO = 50;

interface FamiliaAjena {
  familia_id: string;
  user_id: string;
  device_id: string;
  token_id: string;
}

/**
 * Familias vigentes de OTROS usuarios cuyos dispositivos tienen el mismo `instalacion_id`
 * (F4-06 de docs/auditoria/seguridad-fase-4.md; ADR 0008 puntos 7 y 8). Hay una sola cookie
 * `mp_refresh` por origen: el login de este usuario la reemplaza en ese navegador, así que esas
 * sesiones ya no se pueden usar legítimamente desde él. Las del mismo usuario (otros navegadores o
 * el mismo) no se incluyen: las del mismo dispositivo las revoca el punto 7.
 */
async function familiasAjenasEnInstalacion(
  db: D1Database,
  instalacionId: string,
  userId: string,
  ahora: string,
): Promise<FamiliaAjena[]> {
  const { results } = await db
    .prepare(
      `SELECT r.familia_id, r.user_id, r.device_id, MAX(r.id) AS token_id
       FROM refresh_tokens AS r JOIN devices AS d ON d.id = r.device_id
       WHERE d.instalacion_id = ? AND r.user_id <> ? AND r.revocado_at IS NULL AND r.expira_at > ?
       GROUP BY r.familia_id, r.user_id, r.device_id
       ORDER BY r.familia_id
       LIMIT ?`,
    )
    .bind(instalacionId, userId, ahora, MAX_FAMILIAS_AJENAS_POR_INICIO)
    .all<FamiliaAjena>();
  return results;
}

/**
 * Por cada familia ajena: su auditoría y su revocación, para el MISMO batch del login. La auditoría
 * va ANTES del UPDATE y está condicionada a que la familia siga teniendo tokens vigentes de ese
 * usuario: si entre la lectura y el batch la familia ya se cerró (logout, rotación por reutilización),
 * no se audita una revocación que no ocurrió. La auditoría solo lleva ids (sin datos personales).
 */
function sentenciasRevocarAjenas(
  db: D1Database,
  familias: readonly FamiliaAjena[],
  actor: { userId: string; deviceId: string; alertaReloj: boolean },
  ahora: string,
): D1PreparedStatement[] {
  return familias.flatMap((familia) => [
    sentenciaAuditoriaCondicional(
      db,
      {
        entidad: 'refresh_tokens',
        entidad_id: familia.token_id,
        accion: ACCION_REVOCADA_POR_OTRO_INICIO,
        actor_id: actor.userId,
        device_id: actor.deviceId,
        despues: {
          id: familia.token_id,
          user_id: familia.user_id,
          device_id: familia.device_id,
          familia_id: familia.familia_id,
          revocado_at: ahora,
        },
        server_at: ahora,
        alerta_reloj: actor.alertaReloj,
      },
      {
        sql: `EXISTS (SELECT 1 FROM refresh_tokens
          WHERE familia_id = ? AND user_id = ? AND revocado_at IS NULL)`,
        parametros: [familia.familia_id, familia.user_id],
      },
    ),
    db
      .prepare(
        `UPDATE refresh_tokens SET revocado_at = ?, updated_at = ?
         WHERE familia_id = ? AND user_id = ? AND revocado_at IS NULL`,
      )
      .bind(ahora, ahora, familia.familia_id, familia.user_id),
  ]);
}

/**
 * Login correcto: registra o actualiza el dispositivo, reinicia el cupo de login usado y las columnas
 * de bloqueo heredadas de la v1, revoca las familias activas del mismo usuario en el mismo
 * dispositivo y, si llega un `instalacion_id`, las de otros usuarios en ese mismo navegador
 * (F4-06); por último crea una familia nueva.
 */
export async function iniciarSesion(
  db: D1Database,
  secretoRefresh: string,
  datos: DatosNuevaSesion,
): Promise<TokenEmitido> {
  const ahora = ahoraIso();
  const alertaReloj = datos.alertaReloj === true;
  const familiasAjenas =
    datos.instalacionId === null
      ? []
      : await familiasAjenasEnInstalacion(db, datos.instalacionId, datos.userId, ahora);
  const token = generarRefreshToken();
  const emitido: TokenEmitido = {
    id: uuidv7(),
    token,
    familiaId: uuidv7(),
    userId: datos.userId,
    deviceId: datos.deviceId,
    // La familia nace aquí: su vida máxima (B1) es la de este primer token.
    vidaRestanteS: REFRESH_TOKEN_TTL_S,
  };
  const tokenHash = await hashRefreshToken(secretoRefresh, token);
  const expira = vencimientoRefresh(Date.parse(ahora));
  const sentencias: D1PreparedStatement[] = [];

  if (datos.dispositivoNuevo) {
    sentencias.push(
      db
        .prepare(
          `INSERT INTO devices (id, user_id, instalacion_id, nombre, user_agent, ultimo_sync_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .bind(
          datos.deviceId,
          datos.userId,
          datos.instalacionId,
          datos.nombreDispositivo,
          datos.userAgent,
          ahora,
          ahora,
        ),
      sentenciaAuditoria(db, {
        entidad: 'devices',
        entidad_id: datos.deviceId,
        accion: 'dispositivo.registro',
        actor_id: datos.userId,
        device_id: datos.deviceId,
        despues: {
          id: datos.deviceId,
          user_id: datos.userId,
          nombre: datos.nombreDispositivo,
          user_agent: datos.userAgent,
          instalacion_id: datos.instalacionId,
        },
        server_at: ahora,
        alerta_reloj: alertaReloj,
      }),
    );
  } else {
    sentencias.push(
      db
        .prepare(
          `UPDATE devices
           SET instalacion_id = COALESCE(?, instalacion_id), nombre = COALESCE(?, nombre),
               user_agent = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .bind(
          datos.instalacionId,
          datos.nombreDispositivo,
          datos.userAgent,
          ahora,
          datos.deviceId,
          datos.userId,
        ),
    );
  }

  // Cupo de login del origen usado (ADR 0018): se reinicia en el mismo batch.
  sentencias.push(...(datos.adicionales?.(ahora) ?? []));

  // Columnas de la v1 (`users.intentos_fallidos`/`bloqueado_hasta`, ADR 0018 punto 6): ya no
  // bloquean el login, pero el login correcto las deja en 0/NULL para que no quede ningún bloqueo
  // heredado. Si había un bloqueo se audita el desbloqueo ANTES del UPDATE (condición previa).
  sentencias.push(
    sentenciaAuditoriaCondicional(
      db,
      {
        entidad: 'users',
        entidad_id: datos.userId,
        accion: 'usuario.desbloqueado',
        actor_id: datos.userId,
        device_id: datos.deviceId,
        despues: { id: datos.userId, intentos_fallidos: 0, bloqueado_hasta: null },
        server_at: ahora,
        alerta_reloj: alertaReloj,
      },
      {
        sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND bloqueado_hasta IS NOT NULL)',
        parametros: [datos.userId],
      },
    ),
    db
      .prepare(
        `UPDATE users SET intentos_fallidos = 0, bloqueado_hasta = NULL, updated_at = ?
         WHERE id = ? AND (intentos_fallidos <> 0 OR bloqueado_hasta IS NOT NULL)`,
      )
      .bind(ahora, datos.userId),
  );

  // F4-06: en el mismo batch, después de registrar el dispositivo (la auditoría lo referencia).
  sentencias.push(
    ...sentenciasRevocarAjenas(
      db,
      familiasAjenas,
      { userId: datos.userId, deviceId: datos.deviceId, alertaReloj },
      ahora,
    ),
  );

  sentencias.push(
    // ADR 0008 punto 7: una sesión por usuario y dispositivo.
    db
      .prepare(
        `UPDATE refresh_tokens SET revocado_at = ?, updated_at = ?
         WHERE user_id = ? AND device_id = ? AND revocado_at IS NULL`,
      )
      .bind(ahora, ahora, datos.userId, datos.deviceId),
    db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, familia_id, expira_at, revocado_at, reemplazado_por, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        emitido.id,
        datos.userId,
        datos.deviceId,
        tokenHash,
        emitido.familiaId,
        expira,
        ahora,
        ahora,
      ),
    sentenciaAuditoria(db, {
      entidad: 'refresh_tokens',
      entidad_id: emitido.id,
      accion: 'sesion.inicio',
      actor_id: datos.userId,
      device_id: datos.deviceId,
      despues: {
        id: emitido.id,
        user_id: datos.userId,
        device_id: datos.deviceId,
        familia_id: emitido.familiaId,
        expira_at: expira,
      },
      server_at: ahora,
      alerta_reloj: alertaReloj,
    }),
  );

  await db.batch(sentencias);
  return emitido;
}

/**
 * Emite un sucesor de `origen` en un batch condicional (ADR 0008 punto 2):
 * (a) INSERT … SELECT del token nuevo solo si `origen` cumple `condicionOrigen`;
 * (b) UPDATE de `origen` (revocado, reemplazado_por) solo si (a) insertó;
 * (c) auditoría solo si (a) insertó.
 * El sucesor vence con la familia (B1): min(ahora + 30 días, login + 30 días), que es siempre el
 * vencimiento de la familia; nunca la extiende.
 * Devuelve el token nuevo, o `null` si otro proceso ganó la carrera, la condición no se cumplió o
 * la familia ya venció.
 */
async function emitirSucesor(
  db: D1Database,
  secretoRefresh: string,
  origen: FilaRefresh,
  condicionOrigen: { sql: string; parametros: (string | number)[] },
  accion: string,
  presentadoId: string,
  alertaReloj: boolean,
): Promise<TokenEmitido | null> {
  const ahora = ahoraIso();
  const token = generarRefreshToken();
  const nuevoId = uuidv7();
  const tokenHash = await hashRefreshToken(secretoRefresh, token);
  const porToken = vencimientoRefresh(Date.parse(ahora));
  const deFamilia = vencimientoFamilia(origen.familia_inicio);
  const expira = deFamilia < porToken ? deFamilia : porToken;
  if (expira <= ahora) {
    return null;
  }
  const existeNuevo = {
    sql: 'EXISTS (SELECT 1 FROM refresh_tokens WHERE id = ?)',
    parametros: [nuevoId],
  };

  const [insercion] = await db.batch([
    db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, familia_id, expira_at, revocado_at, reemplazado_por, created_at, updated_at)
         SELECT ?, r.user_id, r.device_id, ?, r.familia_id, ?, NULL, NULL, ?, ?
         FROM refresh_tokens AS r JOIN users AS u ON u.id = r.user_id
         WHERE r.id = ? AND r.revocado_at IS NULL AND r.expira_at > ? AND u.activo = 1
           AND ${condicionOrigen.sql}`,
      )
      .bind(
        nuevoId,
        tokenHash,
        expira,
        ahora,
        ahora,
        origen.id,
        ahora,
        ...condicionOrigen.parametros,
      ),
    db
      .prepare(
        `UPDATE refresh_tokens SET revocado_at = ?, reemplazado_por = ?, updated_at = ?
         WHERE id = ? AND revocado_at IS NULL AND ${existeNuevo.sql}`,
      )
      .bind(ahora, nuevoId, ahora, origen.id, ...existeNuevo.parametros),
    sentenciaAuditoriaCondicional(
      db,
      {
        entidad: 'refresh_tokens',
        entidad_id: nuevoId,
        accion,
        actor_id: origen.user_id,
        device_id: origen.device_id,
        antes: { id: presentadoId, familia_id: origen.familia_id },
        despues: {
          id: nuevoId,
          user_id: origen.user_id,
          device_id: origen.device_id,
          familia_id: origen.familia_id,
          expira_at: expira,
        },
        server_at: ahora,
        alerta_reloj: alertaReloj,
      },
      existeNuevo,
    ),
  ]);

  if (insercion?.meta.changes !== 1) {
    return null;
  }
  return {
    id: nuevoId,
    token,
    familiaId: origen.familia_id,
    userId: origen.user_id,
    deviceId: origen.device_id,
    vidaRestanteS: (Date.parse(expira) - Date.parse(ahora)) / 1000,
  };
}

/**
 * Rotación normal: el token presentado está vigente. `alertaReloj`: la de la petición (ADR 0019).
 */
export function rotar(
  db: D1Database,
  secretoRefresh: string,
  presentado: FilaRefresh,
  alertaReloj = false,
): Promise<TokenEmitido | null> {
  return emitirSucesor(
    db,
    secretoRefresh,
    presentado,
    { sql: '1 = 1', parametros: [] },
    'sesion.rotacion',
    presentado.id,
    alertaReloj,
  );
}

/**
 * Reintento por respuesta perdida (ADR 0008 punto 3): el token presentado ya fue rotado, pero su
 * sucesor se creó hace 30 s o menos y sigue vigente. Se revoca el sucesor y se emite otro de la
 * misma familia. Devuelve `null` si no aplica (fuera de la ventana o sucesor ya usado).
 */
export async function reintentarDentroDeGracia(
  db: D1Database,
  secretoRefresh: string,
  presentado: FilaRefresh,
  alertaReloj = false,
): Promise<TokenEmitido | null> {
  if (presentado.reemplazado_por === null) {
    return null;
  }
  const sucesor = await db
    .prepare(
      `SELECT ${COLUMNAS_FILA_REFRESH}
       FROM refresh_tokens AS r JOIN users AS u ON u.id = r.user_id
       WHERE r.id = ? AND r.familia_id = ?`,
    )
    .bind(presentado.reemplazado_por, presentado.familia_id)
    .first<FilaRefresh>();
  if (sucesor === null) {
    return null;
  }
  const limite = new Date(Date.now() - VENTANA_GRACIA_REFRESH_MS).toISOString();
  return emitirSucesor(
    db,
    secretoRefresh,
    sucesor,
    { sql: 'r.created_at >= ?', parametros: [limite] },
    'sesion.reintento',
    presentado.id,
    alertaReloj,
  );
}

/**
 * Revoca todos los tokens vigentes de una familia y audita la acción, solo si revocó alguno
 * (condición: hay tokens de la familia revocados en este mismo instante).
 */
export async function revocarFamilia(
  db: D1Database,
  familia: { familiaId: string; userId: string; deviceId: string | null; tokenId: string },
  accion: 'sesion.cierre' | 'sesion.reutilizacion',
  alertaReloj = false,
): Promise<void> {
  const ahora = ahoraIso();
  await db.batch([
    db
      .prepare(
        `UPDATE refresh_tokens SET revocado_at = ?, updated_at = ?
         WHERE familia_id = ? AND user_id = ? AND revocado_at IS NULL`,
      )
      .bind(ahora, ahora, familia.familiaId, familia.userId),
    sentenciaAuditoriaCondicional(
      db,
      {
        entidad: 'refresh_tokens',
        entidad_id: familia.tokenId,
        accion,
        actor_id: familia.userId,
        device_id: familia.deviceId,
        despues: { id: familia.tokenId, familia_id: familia.familiaId, revocado_at: ahora },
        server_at: ahora,
        alerta_reloj: alertaReloj,
      },
      {
        sql: 'EXISTS (SELECT 1 FROM refresh_tokens WHERE familia_id = ? AND revocado_at = ?)',
        parametros: [familia.familiaId, ahora],
      },
    ),
  ]);
}

/** Sentencia que revoca todas las familias de un usuario (cambio de rol, desactivación, contraseña). */
export function sentenciaRevocarTodas(
  db: D1Database,
  userId: string,
  ahora: string,
  condicion: { sql: string; parametros: (string | number)[] },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE refresh_tokens SET revocado_at = ?, updated_at = ?
       WHERE user_id = ? AND revocado_at IS NULL AND ${condicion.sql}`,
    )
    .bind(ahora, ahora, userId, ...condicion.parametros);
}

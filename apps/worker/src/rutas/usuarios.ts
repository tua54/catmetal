// Rutas `/api/v1/users` de administración (docs/spec.md §3 y §7; ADR 0008 puntos 1, 6 y 9).
// Solo el permiso `admin.gestionar`. Nunca se borra un usuario: se desactiva.

import {
  ahoraIso,
  crearUsuarioSchema,
  type EditarUsuario,
  editarUsuarioSchema,
  type ListaUsuarios,
  type Rol,
  type Usuario,
  uuidv7,
} from '@catmetal/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  nuevaMarca,
  porAuditoria,
  porMarca,
  sentenciaAuditoria,
  sentenciaAuditoriaCondicional,
} from '../auditoria/auditar';
import { hashearContrasena } from '../auth/contrasenas';
import { sentenciasReinicioAdmin } from '../auth/cupos';
import { sentenciaRevocarTodas } from '../auth/sesiones';
import { ErrorApi } from '../errores';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import { alertaRelojDePeticion } from '../middleware/hora-dispositivo';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO = 100;

const COLUMNAS_USUARIO =
  'id, nombre, email, rol, activo, intentos_fallidos, bloqueado_hasta, created_at, updated_at';

export interface FilaUsuario {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
  activo: number;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
  created_at: string;
  updated_at: string;
}

/** Usuario para la API: sin `password_hash` y con booleanos. */
export function usuarioDe(fila: FilaUsuario): Usuario {
  return { ...fila, activo: fila.activo === 1 };
}

const listarQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limite: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, { error: 'El límite debe ser un entero entre 1 y 100.' })
    .transform(Number)
    .refine((n) => n <= LIMITE_MAXIMO, { error: 'El límite debe ser un entero entre 1 y 100.' })
    .optional(),
});

const idParamSchema = z.object({ id: z.string().min(1).max(64) });

export async function buscarUsuario(db: D1Database, id: string): Promise<FilaUsuario | null> {
  return (await buscarUsuarioConMarca(db, id))?.fila ?? null;
}

/**
 * El usuario y la marca de su última escritura auditada (ADR 0028). La marca es interna: va aparte,
 * nunca en `FilaUsuario` (así no puede salir por la API ni por la auditoría).
 */
export async function buscarUsuarioConMarca(
  db: D1Database,
  id: string,
): Promise<{ fila: FilaUsuario; marca: string | null } | null> {
  const leida = await db
    .prepare(`SELECT ${COLUMNAS_USUARIO}, escritura_id FROM users WHERE id = ?`)
    .bind(id)
    .first<FilaUsuario & { escritura_id: string | null }>();
  if (leida === null) {
    return null;
  }
  const { escritura_id: marca, ...fila } = leida;
  return { fila, marca };
}

function esConflictoDeEmail(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: users\.email/.test(error.message);
}

export function crearRutasUsuarios(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();
  rutas.use('*', autenticar, requierePermiso('admin.gestionar'));

  // Paginación por cursor (id) — nunca OFFSET.
  rutas.get('/', validar('query', listarQuerySchema), async (c) => {
    const { cursor, limite = LIMITE_POR_DEFECTO } = c.req.valid('query');
    const { results } = await c.env.DB.prepare(
      `SELECT ${COLUMNAS_USUARIO} FROM users WHERE id > ? ORDER BY id LIMIT ?`,
    )
      .bind(cursor ?? '', limite + 1)
      .all<FilaUsuario>();
    const pagina = results.slice(0, limite);
    const ultimo = pagina.at(-1);
    const cuerpo: ListaUsuarios = {
      usuarios: pagina.map(usuarioDe),
      siguiente_cursor: results.length > limite && ultimo !== undefined ? ultimo.id : null,
    };
    return c.json(cuerpo);
  });

  rutas.post('/', validar('json', crearUsuarioSchema), async (c) => {
    const datos = c.req.valid('json');
    const sesion = c.get('sesion');
    const ahora = ahoraIso();
    const fila: FilaUsuario = {
      id: uuidv7(),
      nombre: datos.nombre,
      email: datos.email,
      rol: datos.rol,
      activo: 1,
      intentos_fallidos: 0,
      bloqueado_hasta: null,
      created_at: ahora,
      updated_at: ahora,
    };
    const passwordHash = await hashearContrasena(datos.password);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO users (id, nombre, email, password_hash, rol, activo, intentos_fallidos, bloqueado_hasta, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
        ).bind(fila.id, fila.nombre, fila.email, passwordHash, fila.rol, ahora, ahora),
        sentenciaAuditoria(c.env.DB, {
          entidad: 'users',
          entidad_id: fila.id,
          accion: 'usuario.crear',
          actor_id: sesion.userId,
          device_id: sesion.deviceId,
          despues: { ...fila },
          server_at: ahora,
          alerta_reloj: alertaRelojDePeticion(c, ahora),
        }),
      ]);
    } catch (error) {
      if (esConflictoDeEmail(error)) {
        throw new ErrorApi('CONFLICTO', { campo: 'email' });
      }
      throw error;
    }
    return c.json(usuarioDe(fila), 201);
  });

  rutas.patch(
    '/:id',
    validar('param', idParamSchema),
    validar('json', editarUsuarioSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const datos = c.req.valid('json');
      const sesion = c.get('sesion');
      const db = c.env.DB;
      const leido = await buscarUsuarioConMarca(db, id);
      if (leido === null) {
        throw new ErrorApi('NO_ENCONTRADO');
      }
      const actual = leido.fila;

      // Hora estrictamente posterior a la leída: `updated_at` crece con cada edición del admin.
      const ahora = marcaPosterior(actual.updated_at);
      const passwordHash =
        datos.password === undefined ? null : await hashearContrasena(datos.password);
      const plan = planEditarUsuario(db, {
        actual,
        marcaLeida: leido.marca,
        datos,
        actor: { userId: sesion.userId, deviceId: sesion.deviceId },
        ahora,
        // ADR 0019: una sola alerta de reloj para todas las filas de auditoría de la edición.
        alertaReloj: alertaRelojDePeticion(c, ahora),
        passwordHash,
      });

      const [actualizacion] = await db.batch(plan.sentencias);
      if (actualizacion?.meta.changes !== 1) {
        throw new ErrorApi(await motivoNoAplicado(db, leido, plan.quitaAdmin));
      }
      return c.json(usuarioDe(plan.nuevo));
    },
  );

  return rutas;
}

/** Datos de una edición de usuario por el admin (`PATCH /users/:id`). */
export interface EdicionUsuario {
  /** Fila leída antes de editar. */
  actual: FilaUsuario;
  /** Marca de escritura leída con `actual` (testigo de concurrencia, N1). */
  marcaLeida: string | null;
  datos: EditarUsuario;
  actor: { userId: string; deviceId: string };
  /** Hora de la escritura (estrictamente posterior a `actual.updated_at`, ver `marcaPosterior`). */
  ahora: string;
  alertaReloj: boolean;
  /** Hash de la contraseña nueva, o `null` si no cambia. */
  passwordHash: string | null;
}

export interface PlanEdicionUsuario {
  /** El UPDATE de `users` es la sentencia 0: aplicó si su `meta.changes` es 1. */
  sentencias: D1PreparedStatement[];
  nuevo: FilaUsuario;
  quitaAdmin: boolean;
}

/**
 * Sentencias de la edición de un usuario, para un solo `db.batch()` (sin ejecutarlas). Se separa de
 * la ruta para poder construir dos planes sobre el mismo estado con la misma hora (A1).
 */
export function planEditarUsuario(db: D1Database, e: EdicionUsuario): PlanEdicionUsuario {
  const { actual, datos, ahora, alertaReloj } = e;
  const id = actual.id;
  const auditoriaId = uuidv7();
  // A1 (ADR 0028): la auditoría se condiciona a la marca que fija ESTE UPDATE, y las dependientes
  // (revocar sesiones, reiniciar cupos) a que ESTA auditoría se insertó.
  const marca = nuevaMarca();
  const desbloquear = datos.desbloquear === true;
  const activoNuevo = datos.activo === undefined ? null : datos.activo ? 1 : 0;
  const nuevo: FilaUsuario = {
    ...actual,
    nombre: datos.nombre ?? actual.nombre,
    rol: datos.rol ?? actual.rol,
    activo: activoNuevo ?? actual.activo,
    intentos_fallidos: desbloquear ? 0 : actual.intentos_fallidos,
    bloqueado_hasta: desbloquear ? null : actual.bloqueado_hasta,
    updated_at: ahora,
  };
  const quitaAdmin =
    actual.rol === 'admin' && actual.activo === 1 && (nuevo.rol !== 'admin' || nuevo.activo !== 1);
  const revocaSesiones =
    nuevo.rol !== actual.rol ||
    (actual.activo === 1 && nuevo.activo === 0) ||
    datos.password !== undefined;

  // H-03: solo se escriben los campos enviados (COALESCE/CASE sobre la fila actual) y el
  // UPDATE exige que `rol`, `activo`, `updated_at` y la marca de escritura (N1) sigan como se
  // leyeron. Así una edición
  // concurrente nunca reescribe con valores viejos lo que otro admin cambió (reactivar a un
  // desactivado, borrar un bloqueo), y las decisiones derivadas de lo leído (revocar sesiones,
  // último admin, `antes` de la auditoría) siguen siendo ciertas al escribir.
  // `intentos_fallidos`/`bloqueado_hasta` solo cambian con `desbloquear`.
  // Guardia atómica del último admin (ADR 0008 punto 9): si quita un admin activo, debe quedar
  // otro admin activo. Las demás sentencias dependen de que el UPDATE haya aplicado.
  const guardia = quitaAdmin
    ? `EXISTS (SELECT 1 FROM users AS otro WHERE otro.rol = 'admin' AND otro.activo = 1 AND otro.id <> ?)`
    : '1 = 1';
  const parametrosGuardia = quitaAdmin ? [id] : [];
  const aplicado = porMarca('users', { id }, marca);
  const auditado = porAuditoria(auditoriaId);

  const sentencias: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE users SET
           nombre = COALESCE(?, nombre),
           rol = COALESCE(?, rol),
           activo = COALESCE(?, activo),
           intentos_fallidos = CASE WHEN ? = 1 THEN 0 ELSE intentos_fallidos END,
           bloqueado_hasta = CASE WHEN ? = 1 THEN NULL ELSE bloqueado_hasta END,
           password_hash = COALESCE(?, password_hash),
           updated_at = ?,
           escritura_id = ?
         WHERE id = ? AND rol = ? AND activo = ? AND updated_at = ? AND escritura_id IS ?
           AND ${guardia}`,
      )
      .bind(
        datos.nombre ?? null,
        datos.rol ?? null,
        activoNuevo,
        desbloquear ? 1 : 0,
        desbloquear ? 1 : 0,
        e.passwordHash,
        ahora,
        marca,
        id,
        actual.rol,
        actual.activo,
        actual.updated_at,
        e.marcaLeida,
        ...parametrosGuardia,
      ),
    sentenciaAuditoriaCondicional(
      db,
      {
        id: auditoriaId,
        entidad: 'users',
        entidad_id: id,
        accion: 'usuario.editar',
        actor_id: e.actor.userId,
        device_id: e.actor.deviceId,
        antes: { ...actual },
        despues: {
          ...nuevo,
          ...(datos.password === undefined ? {} : { password_restablecida: true }),
        },
        server_at: ahora,
        alerta_reloj: alertaReloj,
      },
      aplicado,
    ),
  ];
  if (revocaSesiones) {
    sentencias.push(sentenciaRevocarTodas(db, id, ahora, auditado));
  }
  if (desbloquear) {
    // ADR 0018 punto 6: el desbloqueo del admin reinicia además TODOS los cupos de login del
    // usuario (dispositivos, orígenes y el global), con su auditoría, si la edición se aplicó.
    sentencias.push(
      ...sentenciasReinicioAdmin(
        db,
        id,
        { userId: e.actor.userId, deviceId: e.actor.deviceId, alertaReloj },
        ahora,
        auditado,
      ),
    );
  }
  return { sentencias, nuevo, quitaAdmin };
}

/** Hora actual en ISO, o 1 ms después de `anterior` si el reloj no avanzó desde entonces. */
function marcaPosterior(anterior: string): string {
  const ahora = ahoraIso();
  if (ahora > anterior) {
    return ahora;
  }
  return new Date(Date.parse(anterior) + 1).toISOString();
}

/**
 * El UPDATE del PATCH no aplicó. Se relee la fila: si nadie la cambió desde la lectura (ni su marca
 * de escritura), lo que falló fue la guardia del último admin (422 `ULTIMO_ADMIN`); si cambió, otra
 * edición ganó la carrera (409 `CONFLICTO`: el cliente relee y reintenta).
 */
async function motivoNoAplicado(
  db: D1Database,
  leido: { fila: FilaUsuario; marca: string | null },
  quitaAdmin: boolean,
): Promise<'ULTIMO_ADMIN' | 'CONFLICTO'> {
  const ahora = await buscarUsuarioConMarca(db, leido.fila.id);
  const sinCambios =
    ahora !== null &&
    ahora.marca === leido.marca &&
    ahora.fila.rol === leido.fila.rol &&
    ahora.fila.activo === leido.fila.activo &&
    ahora.fila.updated_at === leido.fila.updated_at;
  return quitaAdmin && sinCambios ? 'ULTIMO_ADMIN' : 'CONFLICTO';
}

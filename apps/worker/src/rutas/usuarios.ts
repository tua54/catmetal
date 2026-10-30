// Rutas `/api/v1/users` de administración (docs/spec.md §3 y §7; ADR 0008 puntos 1, 6 y 9).
// Solo el permiso `admin.gestionar`. Nunca se borra un usuario: se desactiva.

import {
  ahoraIso,
  crearUsuarioSchema,
  editarUsuarioSchema,
  type ListaUsuarios,
  type Rol,
  type Usuario,
  uuidv7,
} from '@catmetal/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { sentenciaAuditoria, sentenciaAuditoriaCondicional } from '../auditoria/auditar';
import { hashearContrasena } from '../auth/contrasenas';
import { sentenciaRevocarTodas } from '../auth/sesiones';
import { ErrorApi } from '../errores';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO = 100;

const COLUMNAS_USUARIO =
  'id, nombre, email, rol, activo, intentos_fallidos, bloqueado_hasta, created_at, updated_at';

interface FilaUsuario {
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

async function buscarUsuario(db: D1Database, id: string): Promise<FilaUsuario | null> {
  return db
    .prepare(`SELECT ${COLUMNAS_USUARIO} FROM users WHERE id = ?`)
    .bind(id)
    .first<FilaUsuario>();
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
      const actual = await buscarUsuario(db, id);
      if (actual === null) {
        throw new ErrorApi('NO_ENCONTRADO');
      }

      // Marca estrictamente posterior a la leída: así `updated_at = ahora` distingue esta escritura.
      const ahora = marcaPosterior(actual.updated_at);
      const auditoriaId = uuidv7();
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
        actual.rol === 'admin' &&
        actual.activo === 1 &&
        (nuevo.rol !== 'admin' || nuevo.activo !== 1);
      const revocaSesiones =
        nuevo.rol !== actual.rol ||
        (actual.activo === 1 && nuevo.activo === 0) ||
        datos.password !== undefined;
      const passwordHash =
        datos.password === undefined ? null : await hashearContrasena(datos.password);

      // H-03: solo se escriben los campos enviados (COALESCE/CASE sobre la fila actual) y el
      // UPDATE exige que `rol`, `activo` y `updated_at` sigan como se leyeron. Así una edición
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
      // Este UPDATE aplicó: la fila lleva `updated_at = ahora` y ninguna otra edición del mismo
      // milisegundo auditó antes (si dos PATCH concurrentes calculan el mismo `ahora`, solo el que
      // escribió encuentra la fila sin auditoría). La revocación depende de ESTA fila de auditoría.
      const aplicado = {
        sql: `EXISTS (SELECT 1 FROM users WHERE id = ? AND updated_at = ?)
          AND NOT EXISTS (SELECT 1 FROM audit_log WHERE entidad = 'users' AND entidad_id = ?
            AND accion = 'usuario.editar' AND server_at = ?)`,
        parametros: [id, ahora, id, ahora],
      };
      const auditado = {
        sql: 'EXISTS (SELECT 1 FROM audit_log WHERE id = ?)',
        parametros: [auditoriaId],
      };

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
               updated_at = ?
             WHERE id = ? AND rol = ? AND activo = ? AND updated_at = ? AND ${guardia}`,
          )
          .bind(
            datos.nombre ?? null,
            datos.rol ?? null,
            activoNuevo,
            desbloquear ? 1 : 0,
            desbloquear ? 1 : 0,
            passwordHash,
            ahora,
            id,
            actual.rol,
            actual.activo,
            actual.updated_at,
            ...parametrosGuardia,
          ),
      ];
      sentencias.push(
        sentenciaAuditoriaCondicional(
          db,
          {
            id: auditoriaId,
            entidad: 'users',
            entidad_id: id,
            accion: 'usuario.editar',
            actor_id: sesion.userId,
            device_id: sesion.deviceId,
            antes: { ...actual },
            despues: {
              ...nuevo,
              ...(datos.password === undefined ? {} : { password_restablecida: true }),
            },
            server_at: ahora,
          },
          aplicado,
        ),
      );
      if (revocaSesiones) {
        sentencias.push(sentenciaRevocarTodas(db, id, ahora, auditado));
      }

      const [actualizacion] = await db.batch(sentencias);
      if (actualizacion?.meta.changes !== 1) {
        throw new ErrorApi(await motivoNoAplicado(db, actual, quitaAdmin));
      }
      return c.json(usuarioDe(nuevo));
    },
  );

  return rutas;
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
 * El UPDATE del PATCH no aplicó. Se relee la fila: si nadie la cambió desde la lectura, lo que
 * falló fue la guardia del último admin (422 `ULTIMO_ADMIN`); si cambió, otra edición ganó la
 * carrera (409 `CONFLICTO`: el cliente relee y reintenta).
 */
async function motivoNoAplicado(
  db: D1Database,
  leido: FilaUsuario,
  quitaAdmin: boolean,
): Promise<'ULTIMO_ADMIN' | 'CONFLICTO'> {
  const ahora = await buscarUsuario(db, leido.id);
  const sinCambios =
    ahora !== null &&
    ahora.rol === leido.rol &&
    ahora.activo === leido.activo &&
    ahora.updated_at === leido.updated_at;
  return quitaAdmin && sinCambios ? 'ULTIMO_ADMIN' : 'CONFLICTO';
}

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

      const ahora = ahoraIso();
      const nuevo: FilaUsuario = {
        ...actual,
        nombre: datos.nombre ?? actual.nombre,
        rol: datos.rol ?? actual.rol,
        activo: datos.activo === undefined ? actual.activo : datos.activo ? 1 : 0,
        intentos_fallidos: datos.desbloquear === true ? 0 : actual.intentos_fallidos,
        bloqueado_hasta: datos.desbloquear === true ? null : actual.bloqueado_hasta,
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

      // Guardia atómica del último admin (ADR 0008 punto 9): el UPDATE solo aplica si, cuando quita
      // un admin activo, queda otro admin activo. Las demás sentencias dependen de que haya aplicado.
      const guardia = quitaAdmin
        ? `EXISTS (SELECT 1 FROM users AS otro WHERE otro.rol = 'admin' AND otro.activo = 1 AND otro.id <> ?)`
        : '1 = 1';
      const parametrosGuardia = quitaAdmin ? [id] : [];
      const aplicado = {
        sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND updated_at = ?)',
        parametros: [id, ahora],
      };

      const sentencias: D1PreparedStatement[] = [
        db
          .prepare(
            `UPDATE users SET nombre = ?, rol = ?, activo = ?, intentos_fallidos = ?, bloqueado_hasta = ?,
               password_hash = COALESCE(?, password_hash), updated_at = ?
             WHERE id = ? AND ${guardia}`,
          )
          .bind(
            nuevo.nombre,
            nuevo.rol,
            nuevo.activo,
            nuevo.intentos_fallidos,
            nuevo.bloqueado_hasta,
            passwordHash,
            ahora,
            id,
            ...parametrosGuardia,
          ),
      ];
      if (revocaSesiones) {
        sentencias.push(sentenciaRevocarTodas(db, id, ahora, aplicado));
      }
      sentencias.push(
        sentenciaAuditoriaCondicional(
          db,
          {
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

      const [actualizacion] = await db.batch(sentencias);
      if (actualizacion?.meta.changes !== 1) {
        throw new ErrorApi('ULTIMO_ADMIN');
      }
      return c.json(usuarioDe(nuevo));
    },
  );

  return rutas;
}

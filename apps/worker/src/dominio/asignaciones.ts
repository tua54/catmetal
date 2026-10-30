// Asignación de supervisores a una orden: `PUT /orders/:id/supervisors` (admin; docs/spec.md S2, §3).
//
// Reemplaza la lista: los quitados quedan `activo = 0` (nunca se borran), los nuevos se insertan y
// los que estaban inactivos se reactivan. Una fila de auditoría por asignación cambiada
// (`entidad = 'order_supervisors'`, `entidad_id = '<order_id>:<user_id>'`, con `order_id`): la usa
// `/sync/pull` para hidratar o revocar la visibilidad del supervisor (ADR 0005 regla 6).
//
// Concurrencia: la PRIMERA sentencia de cambio (la principal) lleva una guarda que exige que las
// asignaciones de la orden sigan exactamente como se leyeron y que todos los usuarios pedidos sigan
// siendo supervisores activos (con la misma marca de escritura leída: N1, un ABA no pasa). Cada
// sentencia de cambio fija su PROPIA marca (ADR 0028, punto 5: tiene un predicado propio); las demás
// se condicionan a la marca de la principal, y cada auditoría a la marca de su asignación. Si otro
// admin cambió algo entretanto, nada se escribe y responde 409 `CONFLICTO`.
// Las listas viajan como un único parámetro JSON (`json_each(?)`): nunca más de 100 parámetros
// por sentencia.

import type {
  AsignarSupervisores,
  Rol,
  SupervisorAsignado,
  SupervisoresDeOrden,
} from '@catmetal/shared';
import {
  type CondicionDeEscritura,
  type CondicionSql,
  MARCADOR_CONDICION,
  nuevaMarca,
  porMarca,
  sentenciaAuditoriaCondicional,
  sentenciaDependiente,
} from '../auditoria/auditar';
import { ErrorApi } from '../errores';
import type { Contexto } from './contexto';
import { buscarOrden } from './ordenes';
import { type PlanDeEscritura, planSinCambios } from './plan';

interface FilaAsignacion {
  order_id: string;
  user_id: string;
  asignado_por: string;
  activo: number;
  created_at: string;
  updated_at: string;
  nombre: string;
  /** Marca de la última escritura (interna, ADR 0028): nunca sale en la respuesta ni la auditoría. */
  marca: string | null;
}

interface FilaUsuarioPedido {
  id: string;
  nombre: string;
  rol: Rol;
  activo: number;
}

type TipoCambio = 'desactivar' | 'reactivar' | 'crear';

interface Cambio {
  tipo: TipoCambio;
  antes: FilaAsignacion | null;
  despues: FilaAsignacion;
  /** Marca que fija la sentencia de este cambio. */
  marca: string;
}

const ACCION: Readonly<Record<TipoCambio, string>> = {
  desactivar: 'asignacion.desactivar',
  reactivar: 'asignacion.reactivar',
  crear: 'asignacion.crear',
};

function datosAuditoria(fila: FilaAsignacion) {
  return {
    order_id: fila.order_id,
    user_id: fila.user_id,
    asignado_por: fila.asignado_por,
    activo: fila.activo,
    created_at: fila.created_at,
    updated_at: fila.updated_at,
  };
}

function supervisorDe(fila: FilaAsignacion): SupervisorAsignado {
  return {
    user_id: fila.user_id,
    nombre: fila.nombre,
    asignado_por: fila.asignado_por,
    created_at: fila.created_at,
    updated_at: fila.updated_at,
  };
}

function porNombre(a: FilaAsignacion, b: FilaAsignacion): number {
  if (a.nombre !== b.nombre) {
    return a.nombre < b.nombre ? -1 : 1;
  }
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

/** La asignación quedó con la marca que fijó la sentencia de este cambio (ADR 0028). */
function condicionAplicada(cambio: Cambio): CondicionDeEscritura {
  return porMarca(
    'order_supervisors',
    { order_id: cambio.despues.order_id, user_id: cambio.despues.user_id },
    cambio.marca,
  );
}

/** SQL de un cambio (termina en `MARCADOR_CONDICION`) y sus parámetros, sin la condición. */
function sqlCambio(cambio: Cambio): { sql: string; parametros: (string | number)[] } {
  const { despues } = cambio;
  switch (cambio.tipo) {
    case 'desactivar':
      return {
        sql: `UPDATE order_supervisors SET activo = 0, updated_at = ?, escritura_id = ?
          WHERE order_id = ? AND user_id = ? AND activo = 1 AND ${MARCADOR_CONDICION}`,
        parametros: [despues.updated_at, cambio.marca, despues.order_id, despues.user_id],
      };
    case 'reactivar':
      return {
        sql: `UPDATE order_supervisors SET activo = 1, asignado_por = ?, updated_at = ?, escritura_id = ?
          WHERE order_id = ? AND user_id = ? AND activo = 0 AND ${MARCADOR_CONDICION}`,
        parametros: [
          despues.asignado_por,
          despues.updated_at,
          cambio.marca,
          despues.order_id,
          despues.user_id,
        ],
      };
    case 'crear':
      return {
        sql: `INSERT INTO order_supervisors
            (order_id, user_id, asignado_por, activo, created_at, updated_at, escritura_id)
          SELECT ?, ?, ?, 1, ?, ?, ? WHERE ${MARCADOR_CONDICION}`,
        parametros: [
          despues.order_id,
          despues.user_id,
          despues.asignado_por,
          despues.created_at,
          despues.updated_at,
          cambio.marca,
        ],
      };
  }
}

/** Sentencia principal: el cambio guardado con lo que se leyó (su propio `WHERE`). */
function sentenciaPrincipal(
  db: D1Database,
  cambio: Cambio,
  guarda: CondicionSql,
): D1PreparedStatement {
  const { sql, parametros } = sqlCambio(cambio);
  return db
    .prepare(sql.replace(MARCADOR_CONDICION, () => guarda.sql))
    .bind(...parametros, ...guarda.parametros);
}

/**
 * Guarda de la principal: las asignaciones de la orden son exactamente las leídas (mismo número y
 * mismo `activo` por usuario) y todos los usuarios pedidos siguen siendo supervisores activos.
 */
function guardaEstadoLeido(
  orderId: string,
  actuales: readonly FilaAsignacion[],
  listaJson: string,
  pedidos: number,
): CondicionSql {
  const estadoLeido = JSON.stringify(
    actuales.map((a) => ({ u: a.user_id, a: a.activo, m: a.marca })),
  );
  return {
    sql: `(SELECT count(*) FROM order_supervisors WHERE order_id = ?) = ?
      AND (SELECT count(*) FROM order_supervisors AS s
           JOIN json_each(?) AS j
             ON s.user_id = json_extract(j.value, '$.u') AND s.activo = json_extract(j.value, '$.a')
               AND s.escritura_id IS json_extract(j.value, '$.m')
           WHERE s.order_id = ?) = ?
      AND (SELECT count(*) FROM users
           WHERE rol = 'supervisor' AND activo = 1 AND id IN (SELECT value FROM json_each(?))) = ?`,
    parametros: [
      orderId,
      actuales.length,
      estadoLeido,
      orderId,
      actuales.length,
      listaJson,
      pedidos,
    ],
  };
}

export async function reemplazarSupervisores(
  ctx: Contexto,
  orderId: string,
  entrada: AsignarSupervisores,
): Promise<PlanDeEscritura<SupervisoresDeOrden>> {
  if ((await buscarOrden(ctx.db, orderId)) === null) {
    throw new ErrorApi('NO_ENCONTRADO');
  }
  const listaJson = JSON.stringify(entrada.supervisores);
  const [usuarios, asignaciones] = await ctx.db.batch([
    ctx.db
      .prepare(
        'SELECT id, nombre, rol, activo FROM users WHERE id IN (SELECT value FROM json_each(?))',
      )
      .bind(listaJson),
    ctx.db
      .prepare(
        `SELECT s.order_id, s.user_id, s.asignado_por, s.activo, s.created_at, s.updated_at, u.nombre,
           s.escritura_id AS marca
         FROM order_supervisors AS s JOIN users AS u ON u.id = s.user_id
         WHERE s.order_id = ?
         ORDER BY s.user_id`,
      )
      .bind(orderId),
  ]);
  const usuarioPorId = new Map(
    ((usuarios?.results ?? []) as FilaUsuarioPedido[]).map((u) => [u.id, u]),
  );
  const actuales = (asignaciones?.results ?? []) as FilaAsignacion[];

  const invalidos = entrada.supervisores.flatMap((userId, i) => {
    const usuario = usuarioPorId.get(userId);
    const mensaje =
      usuario === undefined
        ? 'El usuario no existe.'
        : usuario.rol !== 'supervisor'
          ? 'El usuario no tiene el rol supervisor.'
          : usuario.activo !== 1
            ? 'El usuario está inactivo.'
            : null;
    return mensaje === null ? [] : [{ campo: `supervisores.${i}`, mensaje }];
  });
  if (invalidos.length > 0) {
    throw new ErrorApi('VALIDACION', invalidos);
  }

  const pedidos = new Set(entrada.supervisores);
  const actualPorUsuario = new Map(actuales.map((a) => [a.user_id, a]));
  const cambios: Cambio[] = [];
  for (const actual of actuales) {
    if (actual.activo === 1 && !pedidos.has(actual.user_id)) {
      cambios.push({
        tipo: 'desactivar',
        antes: actual,
        despues: { ...actual, activo: 0, updated_at: ctx.ahora },
        marca: nuevaMarca(),
      });
    }
  }
  for (const userId of [...pedidos].sort()) {
    const actual = actualPorUsuario.get(userId);
    if (actual === undefined) {
      cambios.push({
        tipo: 'crear',
        antes: null,
        despues: {
          order_id: orderId,
          user_id: userId,
          asignado_por: ctx.actor.id,
          activo: 1,
          created_at: ctx.ahora,
          updated_at: ctx.ahora,
          nombre: usuarioPorId.get(userId)?.nombre ?? '',
          marca: null,
        },
        marca: nuevaMarca(),
      });
    } else if (actual.activo === 0) {
      cambios.push({
        tipo: 'reactivar',
        antes: actual,
        despues: { ...actual, activo: 1, asignado_por: ctx.actor.id, updated_at: ctx.ahora },
        marca: nuevaMarca(),
      });
    }
  }

  // Lista resultante: las activas que no se tocan más las nuevas o reactivadas.
  const resultantes = new Map(
    actuales.filter((a) => a.activo === 1).map((a) => [a.user_id, a] as const),
  );
  for (const cambio of cambios) {
    if (cambio.despues.activo === 1) {
      resultantes.set(cambio.despues.user_id, cambio.despues);
    } else {
      resultantes.delete(cambio.despues.user_id);
    }
  }
  const respuesta: SupervisoresDeOrden = {
    order_id: orderId,
    supervisores: [...resultantes.values()].sort(porNombre).map(supervisorDe),
  };

  const [principal, ...resto] = cambios;
  if (principal === undefined) {
    return planSinCambios(respuesta);
  }
  const guarda = guardaEstadoLeido(orderId, actuales, listaJson, entrada.supervisores.length);
  const principalAplicada = condicionAplicada(principal);
  const sentencias: D1PreparedStatement[] = [sentenciaPrincipal(ctx.db, principal, guarda)];
  for (const cambio of resto) {
    const { sql, parametros } = sqlCambio(cambio);
    sentencias.push(sentenciaDependiente(ctx.db, sql, parametros, principalAplicada));
  }
  for (const cambio of cambios) {
    sentencias.push(
      sentenciaAuditoriaCondicional(
        ctx.db,
        {
          entidad: 'order_supervisors',
          entidad_id: `${orderId}:${cambio.despues.user_id}`,
          accion: ACCION[cambio.tipo],
          order_id: orderId,
          actor_id: ctx.actor.id,
          device_id: ctx.deviceId,
          antes: cambio.antes === null ? null : datosAuditoria(cambio.antes),
          despues: datosAuditoria(cambio.despues),
          server_at: ctx.ahora,
          alerta_reloj: ctx.alertaReloj,
        },
        condicionAplicada(cambio),
      ),
    );
  }
  return {
    sentencias,
    principal: { indice: 0, cambiosEsperados: 1 },
    aplicada: principalAplicada,
    respuesta,
  };
}

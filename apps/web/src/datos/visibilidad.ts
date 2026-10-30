// Visibilidad local tras perder permisos (S-03, docs/auditoria/seguridad-correcciones.md).
//
// Un jefe (o admin) ve los consumos de todos. Si el servidor le baja el rol, el pull trae
// `reiniciar` y el snapshot completo reemplaza la partición (ADR 0022), pero hasta que termina la
// tablet seguía mostrando lo que veía antes. Cuando el perfil NUEVO del servidor ya no tiene
// `auditoria.ver_todo` ni `consumos.validar`, se borran en el acto, SOLO en la partición de ese
// usuario:
//   - los consumos AJENOS (`registrado_por` ≠ usuario) con sus novedades, fotos y validaciones,
//   - salvo los protegidos (mutaciones en cola, rechazo o conflicto sin resolver, fotos sin subir;
//     la misma regla que el reemplazo del snapshot) y los de órdenes que el usuario tiene asignadas
//     como supervisor (los sigue viendo, P9).
// Nunca se toca lo propio ni otras particiones. Lo que siga siendo visible lo vuelve a traer el
// snapshot del `reiniciar`; no se pierde nada de planta (lo ajeno ya está en el servidor).

import type { Permiso } from '@catmetal/shared';
import { db, rangoDe, tablasDeDatos } from './db';
import { borrarConsumoConHijos, consumoProtegido } from './entidades';

/** Permisos con los que se ven consumos de otras personas fuera de las órdenes asignadas. */
const PERMISOS_DE_VISIBILIDAD_AMPLIA: readonly Permiso[] = [
  'auditoria.ver_todo',
  'consumos.validar',
];

/** El perfil ve consumos ajenos fuera de sus órdenes asignadas (jefe o admin). */
export function tieneVisibilidadAmplia(permisos: readonly Permiso[]): boolean {
  return permisos.some((p) => PERMISOS_DE_VISIBILIDAD_AMPLIA.includes(p));
}

/**
 * Borra de la partición de `userId` los consumos ajenos que ya no le corresponden (ver la cabecera).
 * Debe llamarse DENTRO de una transacción `rw` sobre `tablasDeDatos()` o fuera de toda transacción
 * (abre la suya). Devuelve cuántos consumos borró.
 */
export async function purgarAjenosSinVisibilidad(userId: string): Promise<number> {
  return db.transaction('rw', tablasDeDatos(), async () => {
    const rango = rangoDe(userId);
    const asignadas = new Set(
      (
        await db.asignaciones
          .where(':id')
          .between(...rango)
          .toArray()
      )
        .filter((a) => a.supervisor_id === userId && a.activo)
        .map((a) => a.order_id),
    );
    const consumos = await db.consumos
      .where(':id')
      .between(...rango)
      .toArray();
    let borrados = 0;
    for (const c of consumos) {
      if (c.user_id !== userId || c.registrado_por === userId || asignadas.has(c.order_id)) {
        continue;
      }
      if (await consumoProtegido(userId, c, true)) {
        continue;
      }
      await borrarConsumoConHijos(userId, c.id);
      borrados += 1;
    }
    return borrados;
  });
}

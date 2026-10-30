// Utilidades de las pruebas de A1 (docs/correcciones-v1.2.md, ADR 0028): dos planes construidos
// con el MISMO `ahora` sobre el mismo estado inicial y ejecutados uno tras otro, contra la D1 local
// real (sin mocks). Así la carrera "dos peticiones en el mismo milisegundo" es determinista.
import { env } from 'cloudflare:workers';
import type { Contexto } from '../src/dominio/contexto';
import { asignar, contextoDe, nuevaOrden, nuevoMaterial, planear } from './fase2-helpers';
import { crearUsuario } from './fixtures-db';

/**
 * Hora fija para los dos planes de una prueba: distinta de las horas de los fixtures (que se crean
 * con la hora real), así la escritura del ganador cambia `updated_at` y el perdedor no aplica.
 */
export function horaFija(desfaseMs = 120_000): string {
  return new Date(Date.now() + desfaseMs).toISOString();
}

/** Filas de auditoría de una entidad y acción (sin importar la hora). */
export async function contarAuditoria(
  entidad: string,
  entidadId: string,
  accion: string,
): Promise<number> {
  const fila = await env.DB.prepare(
    'SELECT count(*) AS n FROM audit_log WHERE entidad = ? AND entidad_id = ? AND accion = ?',
  )
    .bind(entidad, entidadId, accion)
    .first<{ n: number }>();
  return fila?.n ?? 0;
}

/** Contexto del rol con la hora fija. */
export async function contextoFijo(
  rol: Contexto['actor']['rol'],
  ahora: string,
): Promise<Contexto> {
  return { ...(await contextoDe(rol)), ahora };
}

/** Orden en proceso con un material planeado (100 kg) y el supervisor del contexto asignado. */
export async function ordenDelSupervisor(
  ctx: Contexto,
): Promise<{ orden: string; material: string; jefe: string }> {
  const jefe = await crearUsuario('jefe');
  const orden = await nuevaOrden(jefe, 'en_proceso');
  const material = await nuevoMaterial();
  await planear(orden, material, 100);
  await asignar(orden, ctx.actor.id, jefe);
  return { orden, material, jefe };
}

/** Ejecuta `fn` solo la primera vez (interferencias que simulan la petición ganadora). */
export function unaVez(fn: () => Promise<unknown>): () => Promise<void> {
  let hecho = false;
  return async () => {
    if (!hecho) {
      hecho = true;
      await fn();
    }
  };
}

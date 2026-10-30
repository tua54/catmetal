// Fábricas de datos para las pruebas de la capa local (no se usan en producción).

import {
  uuidv7,
  type Consumo,
  type Evidencia,
  type Novedad,
  type ResultadoMutacion,
  type Validacion,
} from '@catmetal/shared';
import { db } from '../db';
import type { MutacionOutbox } from '../tipos';

/** Vacía todas las tablas (más rápido y fiable que borrar y reabrir la base). */
export async function limpiarDb(): Promise<void> {
  await Promise.all(db.tables.map((tabla) => tabla.clear()));
}

export async function guardarPerfil(userId: string, nombre: string): Promise<void> {
  await db.perfiles.put({
    user_id: userId,
    perfil: {
      id: userId,
      nombre,
      email: `${userId}@catmetal.test`,
      rol: 'supervisor',
      permisos: [],
    },
    device_id: null,
    verificador: null,
    sal: null,
    iteraciones: null,
    actualizado_at: '2026-10-29T15:00:00.000Z',
  });
}

export function consumoServidor(base: Partial<Consumo> = {}): Consumo {
  return {
    id: uuidv7(),
    order_id: uuidv7(),
    material_id: uuidv7(),
    cantidad: 10,
    unidad: 'kg',
    cantidad_en_unidad_plan: 10,
    lote: 'L-1',
    costo_unitario_cop_snapshot: 1000,
    registrado_por: uuidv7(),
    device_id: uuidv7(),
    client_created_at: '2026-10-29T15:00:00.000Z',
    server_received_at: '2026-10-29T15:00:01.000Z',
    estado: 'pendiente',
    corrige_a: null,
    registro_tardio: false,
    requiere_novedad: false,
    version: 1,
    created_at: '2026-10-29T15:00:01.000Z',
    updated_at: '2026-10-29T15:00:01.000Z',
    ...base,
  };
}

export function novedadServidor(base: Partial<Novedad> = {}): Novedad {
  return {
    id: uuidv7(),
    consumption_id: uuidv7(),
    tipo: 'merma',
    descripcion: 'Arena húmeda',
    registrado_por: uuidv7(),
    client_created_at: '2026-10-29T15:00:00.000Z',
    server_received_at: '2026-10-29T15:00:01.000Z',
    created_at: '2026-10-29T15:00:01.000Z',
    updated_at: '2026-10-29T15:00:01.000Z',
    ...base,
  };
}

export function evidenciaServidor(base: Partial<Evidencia> = {}): Evidencia {
  return {
    id: uuidv7(),
    incident_id: uuidv7(),
    mime: 'image/jpeg',
    tamano_bytes: 3,
    sha256: 'a'.repeat(64),
    subido: false,
    subido_at: null,
    created_at: '2026-10-29T15:00:01.000Z',
    updated_at: '2026-10-29T15:00:01.000Z',
    ...base,
  };
}

export function validacionServidor(base: Partial<Validacion> = {}): Validacion {
  return {
    id: uuidv7(),
    consumption_id: uuidv7(),
    decision: 'aprobado',
    motivo: null,
    validado_por: uuidv7(),
    client_created_at: '2026-10-29T16:00:00.000Z',
    server_received_at: '2026-10-29T16:00:01.000Z',
    created_at: '2026-10-29T16:00:01.000Z',
    updated_at: '2026-10-29T16:00:01.000Z',
    ...base,
  };
}

/** Resultado del servidor para la mutación `indice` del lote. */
export function resultado(
  lote: readonly MutacionOutbox[],
  indice: number,
  datos: Omit<ResultadoMutacion, 'indice' | 'mutation_id'>,
): ResultadoMutacion {
  const m = lote[indice];
  if (m === undefined) {
    throw new Error(`No hay mutación en el índice ${indice}`);
  }
  return { indice, mutation_id: m.mutation_id, ...datos };
}

export function fotoDe(contenido: string, mime = 'image/jpeg'): Blob {
  return new Blob([new TextEncoder().encode(contenido)], { type: mime });
}

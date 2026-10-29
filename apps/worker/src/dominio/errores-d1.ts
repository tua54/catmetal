// Traducción de errores de restricción de D1 a errores de la API (revisión de esquema H2, ADR 0010).
//
// Las sentencias de negocio llevan guardas en su `WHERE`, así que una carrera normal da
// `changes = 0` (→ 409 `CONFLICTO`). Si aun así salta una restricción o un trigger (última línea de
// defensa), el batch entero se revierte y aquí se convierte en un código de negocio: nunca un 500.
// El motor de `/sync/push` (Fase 3) usa el mismo clasificador: un error de restricción es
// `rechazada`/`conflicto`, nunca transitorio.
//
// Formato real de D1 (verificado en el pool de pruebas, docs/notas-plataforma.md):
//   D1_ERROR: UNIQUE constraint failed: production_orders.codigo: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
//   D1_ERROR: UNIQUE constraint failed: production_orders.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)
//   D1_ERROR: <mensaje del RAISE>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)
//   D1_ERROR: CHECK constraint failed: <nombre>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)

import type { CodigoError } from '@catmetal/shared';
import { ErrorApi } from '../errores';

/** Mensajes de `RAISE(ABORT, …)` de las migraciones con su código de negocio. El resto → CONFLICTO. */
const CODIGO_POR_TRIGGER: Readonly<Record<string, CodigoError>> = {
  'nadie valida un consumo que registró': 'AUTOAPROBACION',
  'solo se validan consumos pendientes': 'CONSUMO_NO_PENDIENTE',
  'no se aprueba un consumo que requiere novedad sin una novedad registrada': 'REQUIERE_NOVEDAD',
  'un consumo aprobado o rechazado es inmutable': 'CONSUMO_NO_PENDIENTE',
  'un consumo con validación no se edita': 'CONSUMO_NO_PENDIENTE',
  'corrige_a solo puede apuntar a un consumo rechazado': 'CORRECCION_INVALIDA',
  'corrige_a debe ser un consumo de la misma orden': 'CORRECCION_INVALIDA',
  'transición de estado de orden no permitida': 'ESTADO_ORDEN_INVALIDO',
  'una orden finalizada o cancelada no cambia de estado': 'ESTADO_ORDEN_INVALIDO',
  'solo un jefe activo valida consumos': 'PERMISO_DENEGADO',
  'el dispositivo no pertenece a quien registra': 'PERMISO_DENEGADO',
  'una evidencia solo admite marcarse como subida': 'EVIDENCIA_YA_SUBIDA',
  'id de consumo no es un UUID en minúsculas': 'ID_INVALIDO',
  'valor de configuración no válido': 'VALIDACION',
};

/** Columnas que son la clave primaria propia de una entidad (colisión → `ID_DUPLICADO`). */
const COLUMNAS_ID = new Set(['id', 'mutation_id']);

const PATRON_RESTRICCION = /SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_([A-Z]+)\))?/;
const PATRON_UNICO = /UNIQUE constraint failed: ([^:]+): SQLITE_CONSTRAINT/;
const PATRON_TRIGGER =
  /^(?:D1_ERROR: )?(.+): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_TRIGGER\)/;

export interface DetalleRestriccionUnica {
  entidad: string;
  campos: string[];
}

function mensajeDe(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

/** Indica si el error es una violación de restricción o de trigger de SQLite (no transitorio). */
export function esErrorDeRestriccion(error: unknown): boolean {
  const mensaje = mensajeDe(error);
  return mensaje !== null && PATRON_RESTRICCION.test(mensaje);
}

/** `production_orders.codigo` / `order_supervisors.order_id, order_supervisors.user_id`. */
function leerUnico(lista: string): DetalleRestriccionUnica {
  const columnas = lista.split(',').map((parte) => parte.trim());
  const entidad = columnas[0]?.split('.')[0] ?? '';
  return { entidad, campos: columnas.map((columna) => columna.split('.').at(-1) ?? columna) };
}

/**
 * Convierte un error de restricción de D1 en `ErrorApi`; devuelve `null` si no lo es (error de
 * red, sobrecarga, SQL inválido…), para que el llamador lo relance como error interno o transitorio.
 *
 * - PK propia (`id`, `mutation_id`) → `ID_DUPLICADO` (un id del cliente que ya existe: nunca se
 *   sobrescribe) con `details: { entidad, campos }`.
 * - Otro UNIQUE o PK compuesta → `CONFLICTO` con `details: { entidad, campos }` (código repetido o
 *   carrera entre dos peticiones).
 * - Trigger → el código de negocio del mensaje (`CODIGO_POR_TRIGGER`) o `CONFLICTO`.
 * - CHECK / NOT NULL → `VALIDACION` (dato que la validación de Zod debió atajar).
 * - FOREIGN KEY → `CONFLICTO` (el registro referido no existe o cambió).
 */
export function traducirErrorD1(error: unknown): ErrorApi | null {
  const mensaje = mensajeDe(error);
  if (mensaje === null) {
    return null;
  }
  const restriccion = PATRON_RESTRICCION.exec(mensaje);
  if (restriccion === null) {
    return null;
  }
  const tipo = restriccion[1] ?? '';
  switch (tipo) {
    case 'PRIMARYKEY':
    case 'UNIQUE': {
      const lista = PATRON_UNICO.exec(mensaje)?.[1];
      const detalle = lista === undefined ? undefined : leerUnico(lista);
      const esIdPropio =
        tipo === 'PRIMARYKEY' &&
        detalle !== undefined &&
        detalle.campos.length === 1 &&
        COLUMNAS_ID.has(detalle.campos[0] ?? '');
      return new ErrorApi(esIdPropio ? 'ID_DUPLICADO' : 'CONFLICTO', detalle);
    }
    case 'TRIGGER': {
      const regla = PATRON_TRIGGER.exec(mensaje)?.[1] ?? '';
      const codigo = Object.hasOwn(CODIGO_POR_TRIGGER, regla)
        ? CODIGO_POR_TRIGGER[regla]
        : undefined;
      return new ErrorApi(codigo ?? 'CONFLICTO');
    }
    case 'CHECK':
    case 'NOTNULL':
      return new ErrorApi('VALIDACION', [
        { campo: '', mensaje: 'Los datos no cumplen una regla de integridad del sistema.' },
      ]);
    default:
      // FOREIGNKEY y cualquier otra restricción.
      return new ErrorApi('CONFLICTO');
  }
}

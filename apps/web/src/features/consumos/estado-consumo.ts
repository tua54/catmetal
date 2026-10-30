// Qué ve y qué puede hacer el supervisor con cada consumo local (docs/spec.md §6 reglas de
// conflicto, S3, S4, S10). Solo decide la UI: el servidor revalida todo al sincronizar.

import { MENSAJES_ERROR } from '@catmetal/shared';
import type { EstadoChip } from '../../components/ui';
import type { ConsumoLocal, ErrorSync } from '../../datos';

export interface AccionesConsumo {
  /** S4: editar un consumo propio mientras está pendiente de validación. */
  editar: boolean;
  /** S3: crear un consumo corregido (`corrige_a`) de uno rechazado por el jefe. */
  corregir: boolean;
  /** El servidor rechazó la CREACIÓN (nunca existió allí): registrarlo de nuevo, sin `corrige_a`. */
  registrarDeNuevo: boolean;
  /** El servidor marcó `requiere_novedad` y no hay novedad: justificarla. */
  justificar: boolean;
  /** El servidor perdió el consumo en una restauración (ADR 0016): enviarlo de nuevo. */
  reenviar: boolean;
}

/** El consumo fue rechazado por el jefe (en el servidor). */
function rechazadoPorJefe(c: ConsumoLocal): boolean {
  return c.estado_local === 'rechazado' || c.servidor?.estado === 'rechazado';
}

export function accionesDeConsumo(c: ConsumoLocal, userId: string): AccionesConsumo {
  const propio = c.registrado_por === userId;
  const creacionRechazada = c.servidor === null && c.estado_local === 'rechazado_sync';
  const validado = c.estado_local === 'aprobado' || c.servidor?.estado === 'aprobado';
  const rechazado = rechazadoPorJefe(c);
  const perdido = c.perdido_en_restauracion === true;
  if (perdido) {
    // El servidor ya no lo tiene: lo único que tiene sentido es enviarlo de nuevo.
    return {
      editar: false,
      corregir: false,
      registrarDeNuevo: false,
      justificar: false,
      reenviar: propio,
    };
  }
  return {
    editar: propio && !creacionRechazada && !validado && !rechazado,
    corregir: propio && rechazado,
    registrarDeNuevo: propio && creacionRechazada,
    justificar: propio && c.falta_novedad && !rechazado && !creacionRechazada,
    reenviar: false,
  };
}

/** Chip de estado de la fila (§8: Pendiente de sync / Sincronizado / Validado / Rechazado / Falta novedad). */
export function chipDeConsumo(c: ConsumoLocal): EstadoChip {
  if (c.perdido_en_restauracion === true) {
    return 'perdido';
  }
  switch (c.estado_local) {
    case 'aprobado':
      return 'validado';
    case 'rechazado':
    case 'rechazado_sync':
      return 'rechazado';
    case 'conflicto':
      return 'conflicto';
    default:
      if (c.falta_novedad) {
        return 'falta_novedad';
      }
      return c.estado_local === 'pendiente_sync' ? 'pendiente_sync' : 'sincronizado';
  }
}

/** Texto para lectores de pantalla del chip accionable. */
export function textoAccionChip(chip: EstadoChip): string {
  switch (chip) {
    case 'rechazado':
      return 'ver el motivo';
    case 'falta_novedad':
      return 'justificar la novedad';
    case 'conflicto':
      return 'ver el conflicto';
    case 'perdido':
      return 'enviarlo de nuevo';
    default:
      return 'ver opciones';
  }
}

/** Mensaje en español de un error de sync: el del contrato si el código es conocido. */
export function mensajeErrorSync(error: ErrorSync | null): string {
  if (error === null) {
    return 'El servidor no dio más detalles.';
  }
  return error.code !== null ? MENSAJES_ERROR[error.code] : error.message;
}

/** Explicación del estado para el diálogo del consumo. */
export function explicacionEstado(c: ConsumoLocal): string {
  if (c.perdido_en_restauracion === true) {
    return 'El servidor se restauró desde una copia anterior y ya no tiene este registro. Sigue guardado en esta tablet: envíelo de nuevo.';
  }
  switch (c.estado_local) {
    case 'pendiente_sync':
      return 'Guardado en esta tablet. Se enviará al servidor al recuperar señal.';
    case 'sincronizado':
      return c.falta_novedad
        ? 'El servidor calculó que este consumo supera lo planeado más la tolerancia (con los registros de todos los supervisores). Falta justificar la novedad para que el jefe pueda validarlo.'
        : 'El servidor ya lo tiene. Está pendiente de validación del jefe.';
    case 'aprobado':
      return 'El jefe validó este consumo.';
    case 'rechazado':
      return 'El jefe rechazó este consumo. Un consumo rechazado no se edita: cree una corrección.';
    case 'rechazado_sync':
      return c.servidor === null
        ? 'El servidor no aceptó este registro. Sus datos siguen en esta tablet: puede registrarlo de nuevo con los datos corregidos.'
        : 'El servidor no aceptó el último cambio. Se muestra la versión que tiene el servidor.';
    case 'conflicto':
      return 'Este registro cambió en el servidor mientras usted trabajaba sin conexión. Se muestra la versión del servidor; revísela y, si hace falta, edítela de nuevo.';
  }
}

// Llamadas REST del panel del jefe a la cola de validación (docs/spec.md §7 "Validación").
// Contratos: `ColaValidacion`, `ResultadoValidacion`, `aprobarSchema`, `rechazarSchema`
// (packages/shared). La autorización real la hace siempre el Worker.

import type { Aprobar, ColaValidacion, Rechazar, ResultadoValidacion } from '@catmetal/shared';
import { clienteApi, type ClienteApi } from '../../auth';

/** Filtros de la cola tal como los maneja la UI (y la URL `?orden=&supervisor=&con_novedad=`). */
export interface FiltrosCola {
  orden: string | null;
  supervisor: string | null;
  /** `true`: solo consumos con novedad o que la requieren. `false` en la UI = sin filtro. */
  conNovedad: boolean;
}

export const FILTROS_VACIOS: FiltrosCola = { orden: null, supervisor: null, conNovedad: false };

/** Tamaño de página de la cola (el servidor admite hasta 100). */
export const LIMITE_COLA = 50;

/** Query string del contrato `colaValidacionQuerySchema`. */
export function rutaCola(filtros: FiltrosCola, cursor: string | null): string {
  const parametros = new URLSearchParams();
  if (filtros.orden !== null) {
    parametros.set('orden', filtros.orden);
  }
  if (filtros.supervisor !== null) {
    parametros.set('supervisor', filtros.supervisor);
  }
  if (filtros.conNovedad) {
    parametros.set('con_novedad', 'true');
  }
  if (cursor !== null) {
    parametros.set('cursor', cursor);
  }
  parametros.set('limite', String(LIMITE_COLA));
  return `/validations/queue?${parametros.toString()}`;
}

export function obtenerCola(
  filtros: FiltrosCola,
  cursor: string | null,
  signal?: AbortSignal,
  api: ClienteApi = clienteApi,
): Promise<ColaValidacion> {
  return api.peticion<ColaValidacion>(rutaCola(filtros, cursor), { signal });
}

export function aprobarEnServidor(
  consumoId: string,
  cuerpo: Aprobar,
  api: ClienteApi = clienteApi,
): Promise<ResultadoValidacion> {
  return api.peticion<ResultadoValidacion>(`/consumptions/${consumoId}/approve`, {
    metodo: 'POST',
    cuerpo,
  });
}

export function rechazarEnServidor(
  consumoId: string,
  cuerpo: Rechazar,
  api: ClienteApi = clienteApi,
): Promise<ResultadoValidacion> {
  return api.peticion<ResultadoValidacion>(`/consumptions/${consumoId}/reject`, {
    metodo: 'POST',
    cuerpo,
  });
}

/** Claves de TanStack Query del panel del jefe (invalidar por prefijo). */
export const CLAVES_JEFE = {
  todo: ['jefe'] as const,
  cola: ['jefe', 'cola'] as const,
  colaCon: (filtros: FiltrosCola) => ['jefe', 'cola', filtros] as const,
  resumen: (orderId: string) => ['jefe', 'resumen', orderId] as const,
  lineaTiempo: (orderId: string) => ['jefe', 'linea-tiempo', orderId] as const,
  ordenes: ['jefe', 'ordenes'] as const,
  ordenesCon: (estado: string | null) => ['jefe', 'ordenes', 'lista', estado] as const,
  orden: (orderId: string) => ['jefe', 'ordenes', 'detalle', orderId] as const,
  materiales: ['jefe', 'materiales'] as const,
};

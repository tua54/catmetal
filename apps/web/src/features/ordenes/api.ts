// Llamadas REST de órdenes, reportes y auditoría para el jefe (docs/spec.md §7). Contratos de
// packages/shared: `ListaOrdenes`, `DetalleOrden`, `OrdenCreada`, `ResumenOrden`,
// `LineaTiempoOrden`, `ListaMateriales`, `crearOrdenSchema` y `finalizarOrdenSchema`.

import {
  nombreArchivoCsv,
  type CrearOrden,
  type DetalleOrden,
  type EstadoOrden,
  type LineaTiempoOrden,
  type ListaMateriales,
  type ListaOrdenes,
  type Material,
  type Orden,
  type OrdenCreada,
  type ResumenOrden,
} from '@catmetal/shared';
import { clienteApi, type ClienteApi } from '../../auth';
import { descargarAutenticado, guardarArchivo } from '../validacion/descarga';

/** Tamaño de página de la lista de órdenes. */
export const LIMITE_ORDENES = 50;
/** Eventos por página de la línea de tiempo (el servidor admite hasta 200). */
export const LIMITE_LINEA_TIEMPO = 50;

export function listarOrdenes(
  estado: EstadoOrden | null,
  cursor: string | null,
  signal?: AbortSignal,
  api: ClienteApi = clienteApi,
): Promise<ListaOrdenes> {
  const parametros = new URLSearchParams();
  if (estado !== null) {
    parametros.set('estado', estado);
  }
  if (cursor !== null) {
    parametros.set('cursor', cursor);
  }
  parametros.set('limite', String(LIMITE_ORDENES));
  return api.peticion<ListaOrdenes>(`/orders?${parametros.toString()}`, { signal });
}

export function obtenerDetalleOrden(
  id: string,
  signal?: AbortSignal,
  api: ClienteApi = clienteApi,
): Promise<DetalleOrden> {
  return api.peticion<DetalleOrden>(`/orders/${encodeURIComponent(id)}`, { signal });
}

export function crearOrden(cuerpo: CrearOrden, api: ClienteApi = clienteApi): Promise<OrdenCreada> {
  return api.peticion<OrdenCreada>('/orders', { metodo: 'POST', cuerpo });
}

export function iniciarOrden(id: string, api: ClienteApi = clienteApi): Promise<Orden> {
  return api.peticion<Orden>(`/orders/${encodeURIComponent(id)}/start`, { metodo: 'POST' });
}

/** `force: true` solo tras la segunda confirmación explícita (queda en la auditoría). */
export function finalizarOrden(
  id: string,
  force: boolean,
  api: ClienteApi = clienteApi,
): Promise<Orden> {
  return api.peticion<Orden>(`/orders/${encodeURIComponent(id)}/finish`, {
    metodo: 'POST',
    cuerpo: force ? { force: true } : {},
  });
}

export function obtenerResumenOrden(
  id: string,
  signal?: AbortSignal,
  api: ClienteApi = clienteApi,
): Promise<ResumenOrden> {
  return api.peticion<ResumenOrden>(`/reports/orders/${encodeURIComponent(id)}/summary`, {
    signal,
  });
}

export function obtenerLineaTiempo(
  id: string,
  cursor: number | null,
  signal?: AbortSignal,
  api: ClienteApi = clienteApi,
): Promise<LineaTiempoOrden> {
  const parametros = new URLSearchParams({ limite: String(LIMITE_LINEA_TIEMPO) });
  if (cursor !== null) {
    parametros.set('cursor', String(cursor));
  }
  return api.peticion<LineaTiempoOrden>(
    `/orders/${encodeURIComponent(id)}/audit?${parametros.toString()}`,
    {
      signal,
    },
  );
}

/** Catálogo de materiales ACTIVOS completo (recorre todas las páginas por cursor). */
export async function listarMaterialesActivos(
  signal?: AbortSignal,
  api: ClienteApi = clienteApi,
): Promise<Material[]> {
  const materiales: Material[] = [];
  let cursor: string | null = null;
  // Tope defensivo: 50 páginas de 100 = 5 000 materiales.
  for (let pagina = 0; pagina < 50; pagina += 1) {
    const parametros = new URLSearchParams({ activo: 'true', limite: '100' });
    if (cursor !== null) {
      parametros.set('cursor', cursor);
    }
    const respuesta: ListaMateriales = await api.peticion<ListaMateriales>(
      `/materials?${parametros.toString()}`,
      { signal },
    );
    materiales.push(...respuesta.materiales);
    cursor = respuesta.siguiente_cursor;
    if (cursor === null) {
      break;
    }
  }
  return materiales.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es-CO'));
}

/** Descarga el CSV de la orden con el token de la sesión y lo guarda con `<a download>`. */
export async function exportarCsv(id: string, codigo: string): Promise<void> {
  const { blob, nombre } = await descargarAutenticado(
    `/reports/orders/${encodeURIComponent(id)}/export.csv`,
  );
  guardarArchivo(blob, nombre ?? nombreArchivoCsv(codigo));
}

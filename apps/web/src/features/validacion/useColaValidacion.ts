// Datos de la cola de validación del jefe: del servidor (`GET /validations/queue`, paginada por
// cursor) cuando hay sesión del servidor y, si no la hay y nunca se cargó, de la copia de la tablet
// (Dexie, S5). También expone las decisiones guardadas en la tablet sin sincronizar.

import type { ColaValidacion, ElementoCola } from '@catmetal/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useConsultaLocal } from '../../app/useConsultaLocal';
import { useSesion } from '../../auth';
import { CLAVES_JEFE, FILTROS_VACIOS, obtenerCola, type FiltrosCola } from './api';
import { colaLocal, decisionesPendientesLocales } from './cola-local';
import { esFaltaDeServidor, reintentarConsulta } from './mensajes';

/** De dónde salen los datos que se ven: el servidor o la copia de la tablet. */
export type FuenteCola = 'servidor' | 'tablet';

function useConsultaCola(filtros: FiltrosCola, habilitada: boolean) {
  return useInfiniteQuery({
    retry: reintentarConsulta,
    queryKey: CLAVES_JEFE.colaCon(filtros),
    queryFn: ({ pageParam, signal }) => obtenerCola(filtros, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (ultima: ColaValidacion) => ultima.siguiente_cursor,
    enabled: habilitada,
  });
}

export function useColaValidacion(filtros: FiltrosCola) {
  const userId = useSesion((estado) => estado.usuario?.id ?? null);
  const enLinea = useSesion((estado) => estado.modo === 'online');

  const cola = useConsultaCola(filtros, enLinea);
  // Opciones de los filtros: la cola sin filtrar (la misma consulta si no hay filtros activos).
  const sinFiltros = useConsultaCola(FILTROS_VACIOS, enLinea);

  const usarTablet =
    userId !== null &&
    cola.data === undefined &&
    (!enLinea || (cola.isError && esFaltaDeServidor(cola.error)));

  const consultaTablet = useCallback(
    () => (userId === null ? Promise.resolve([]) : colaLocal(userId, filtros)),
    [userId, filtros],
  );
  const consultaTabletSinFiltros = useCallback(
    () => (userId === null ? Promise.resolve([]) : colaLocal(userId, FILTROS_VACIOS)),
    [userId],
  );
  const consultaDecisiones = useCallback(
    () =>
      userId === null
        ? Promise.resolve(new Map<string, 'aprobado' | 'rechazado'>())
        : decisionesPendientesLocales(userId),
    [userId],
  );
  const tablet = useConsultaLocal(usarTablet ? consultaTablet : null);
  const tabletSinFiltros = useConsultaLocal(usarTablet ? consultaTabletSinFiltros : null);
  const decisiones = useConsultaLocal(consultaDecisiones);

  const delServidor = cola.data?.pages.flatMap((pagina) => pagina.elementos);
  const elementos: ElementoCola[] | undefined =
    delServidor ?? (usarTablet ? tablet.datos : undefined);
  const fuente: FuenteCola | null =
    delServidor !== undefined ? 'servidor' : elementos !== undefined ? 'tablet' : null;
  const pendientes =
    cola.data?.pages[0]?.pendientes ?? (fuente === 'tablet' ? elementos?.length : undefined);
  const paraOpciones: ElementoCola[] = [
    ...(sinFiltros.data?.pages.flatMap((pagina) => pagina.elementos) ??
      tabletSinFiltros.datos ??
      []),
    ...(elementos ?? []),
  ];

  return {
    elementos,
    pendientes,
    fuente,
    /** Hora (ms) de la última carga del servidor, para el aviso "última cola cargada". */
    actualizadaEn: cola.dataUpdatedAt,
    consulta: cola,
    /** La cola visible no es del servidor en este momento (sin red o sin sesión del servidor). */
    sinServidor: !enLinea || (cola.isError && esFaltaDeServidor(cola.error)),
    paraOpciones,
    decisionesLocales: decisiones.datos ?? new Map<string, 'aprobado' | 'rechazado'>(),
  };
}

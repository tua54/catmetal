import { liveQuery } from 'dexie';
import { useCallback, useEffect, useState } from 'react';

export interface ResultadoConsultaLocal<T> {
  /** `undefined` mientras carga (o si la consulta es `null`). */
  datos: T | undefined;
  error: unknown;
  cargando: boolean;
  /**
   * Vuelve a suscribirse a la consulta (botón "Reintentar" tras un error de IndexedDB). Mientras
   * llega la respuesta, `cargando` vuelve a ser `true`.
   */
  reintentar: () => void;
}

interface Estado<T> {
  fuente: (() => Promise<T>) | null;
  intento: number;
  datos?: T;
  error?: unknown;
}

/**
 * Lee de IndexedDB y se actualiza sola cuando cambian las tablas consultadas (`liveQuery` de
 * Dexie, también entre pestañas). La consulta debe ser estable (`useCallback` o una función del
 * módulo): cada consulta nueva se vuelve a suscribir. `null` = no consultar (p. ej. sin usuario).
 */
export function useConsultaLocal<T>(
  consulta: (() => Promise<T>) | null,
): ResultadoConsultaLocal<T> {
  const [estado, setEstado] = useState<Estado<T>>({ fuente: null, intento: 0 });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (consulta === null) {
      return;
    }
    const suscripcion = liveQuery(consulta).subscribe({
      next: (datos) => setEstado({ fuente: consulta, intento, datos }),
      error: (error: unknown) => setEstado({ fuente: consulta, intento, error }),
    });
    return () => suscripcion.unsubscribe();
  }, [consulta, intento]);

  const reintentar = useCallback(() => setIntento((actual) => actual + 1), []);

  // Si la consulta cambió (o se pidió reintentar), lo guardado es de la anterior: se ignora hasta
  // que llegue lo nuevo.
  const vigente = consulta !== null && estado.fuente === consulta && estado.intento === intento;
  return {
    datos: vigente ? estado.datos : undefined,
    error: vigente ? estado.error : undefined,
    cargando: consulta !== null && !vigente,
    reintentar,
  };
}

// Subtítulo dinámico de la barra superior ("Orden OP-2026-0587 · Línea Moldeo 1"). El `handle` de
// la ruta es estático; las pantallas que conocen la orden (leída de Dexie) lo reemplazan mientras
// están montadas.

import { useEffect } from 'react';
import { create } from 'zustand';

export const useEncabezado = create<{ subtitulo: string | null }>()(() => ({ subtitulo: null }));

/** Pone el subtítulo de la barra mientras el componente está montado (`null` = el del `handle`). */
export function useSubtituloBarra(subtitulo: string | null): void {
  useEffect(() => {
    useEncabezado.setState({ subtitulo });
    return () => useEncabezado.setState({ subtitulo: null });
  }, [subtitulo]);
}

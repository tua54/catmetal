import { useContext } from 'react';
import { ContextoAvisos, type ApiAvisos } from './contexto-avisos';

/** Acceso al sistema de toasts. Requiere `<ProveedorAvisos>` más arriba en el árbol. */
export function useAvisos(): ApiAvisos {
  const api = useContext(ContextoAvisos);
  if (!api) {
    throw new Error('useAvisos debe usarse dentro de <ProveedorAvisos>.');
  }
  return api;
}

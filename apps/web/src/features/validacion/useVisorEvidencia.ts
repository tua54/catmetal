// Abre una evidencia en el visor: la descarga con el token (`GET /evidences/:id`), la convierte en
// una URL `blob:` y la libera al cerrar o al desmontar. Sin servidor, usa los bytes guardados en la
// tablet si existen (solo para fotos tomadas en este dispositivo).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSesion } from '../../auth';
import { useAvisos } from '../../components/ui';
import { evidenciaLocal } from './cola-local';
import { descargarAutenticado } from './descarga';
import { esFaltaDeServidor, mensajeDeError } from './mensajes';

export interface EvidenciaAbierta {
  url: string;
  titulo: string;
  alt: string;
}

export interface SolicitudEvidencia {
  id: string;
  titulo: string;
  alt: string;
}

export function useVisorEvidencia() {
  const avisos = useAvisos();
  const userId = useSesion((estado) => estado.usuario?.id ?? null);
  const [abierta, setAbierta] = useState<EvidenciaAbierta | null>(null);
  const [cargandoId, setCargandoId] = useState<string | null>(null);
  // URL vigente, para liberarla también si la pantalla se desmonta con el visor abierto.
  const urlVigente = useRef<string | null>(null);
  // Solo la última apertura pedida puede mostrarse (dos toques rápidos sobre evidencias distintas).
  const ultimaSolicitud = useRef(0);

  const liberar = useCallback(() => {
    if (urlVigente.current !== null) {
      URL.revokeObjectURL(urlVigente.current);
      urlVigente.current = null;
    }
  }, []);

  useEffect(() => liberar, [liberar]);

  const cerrar = useCallback(() => {
    setAbierta(null);
    liberar();
  }, [liberar]);

  const abrir = useCallback(
    async ({ id, titulo, alt }: SolicitudEvidencia) => {
      ultimaSolicitud.current += 1;
      const solicitud = ultimaSolicitud.current;
      setCargandoId(id);
      try {
        let blob: Blob | null = null;
        try {
          blob = (await descargarAutenticado(`/evidences/${id}`)).blob;
        } catch (error) {
          const local =
            esFaltaDeServidor(error) && userId !== null ? await evidenciaLocal(userId, id) : null;
          if (local === null) {
            throw error;
          }
          blob = local;
        }
        if (solicitud !== ultimaSolicitud.current) {
          return;
        }
        liberar();
        const url = URL.createObjectURL(blob);
        urlVigente.current = url;
        setAbierta({ url, titulo, alt });
      } catch (error) {
        if (solicitud === ultimaSolicitud.current) {
          avisos.mostrar({
            tono: 'error',
            titulo: 'No se pudo abrir la evidencia',
            mensaje: esFaltaDeServidor(error)
              ? 'La foto está en el servidor y no hay conexión. Intente de nuevo cuando vuelva la señal.'
              : mensajeDeError(error),
          });
        }
      } finally {
        if (solicitud === ultimaSolicitud.current) {
          setCargandoId(null);
        }
      }
    },
    [avisos, liberar, userId],
  );

  return { abierta, cargandoId, abrir, cerrar };
}

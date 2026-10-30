import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorFoto, MAX_FOTOS, prepararFotoEvidencia } from './fotos';

export interface FotoAdjunta {
  id: string;
  /** JPEG recomprimido y sin metadatos: es lo que se guarda en Dexie. */
  blob: Blob;
  /** URL `blob:` para la miniatura (`null` si el navegador no la soporta). */
  url: string | null;
  nombre: string;
}

export interface EstadoFotos {
  fotos: readonly FotoAdjunta[];
  procesando: boolean;
  error: string | null;
  agregar: (archivos: readonly File[]) => Promise<void>;
  quitar: (id: string) => void;
  limpiar: () => void;
}

function crearUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

function liberar(foto: FotoAdjunta): void {
  if (foto.url !== null && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(foto.url);
  }
}

let contador = 0;

/**
 * Fotos de evidencia de un formulario: las recomprime al elegirlas (JPEG sin EXIF), hasta 5, con
 * miniaturas `blob:` que se liberan al quitarlas, al limpiar y al desmontar.
 */
export function useFotosEvidencia(): EstadoFotos {
  const [fotos, setFotos] = useState<FotoAdjunta[]>([]);
  const [procesando, setProcesando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refFotos = useRef<FotoAdjunta[]>([]);

  useEffect(() => {
    refFotos.current = fotos;
  }, [fotos]);

  useEffect(() => () => refFotos.current.forEach(liberar), []);

  const agregar = useCallback(async (archivos: readonly File[]) => {
    setError(null);
    const libres = MAX_FOTOS - refFotos.current.length;
    if (libres <= 0) {
      setError(`Máximo ${MAX_FOTOS} fotos por novedad.`);
      return;
    }
    const elegidos = archivos.slice(0, libres);
    setProcesando(true);
    const nuevas: FotoAdjunta[] = [];
    try {
      for (const archivo of elegidos) {
        const blob = await prepararFotoEvidencia(archivo);
        contador += 1;
        nuevas.push({ id: `foto-${contador}`, blob, url: crearUrl(blob), nombre: archivo.name });
      }
      if (archivos.length > libres) {
        setError(`Máximo ${MAX_FOTOS} fotos por novedad: se adjuntaron solo ${libres}.`);
      }
    } catch (causa) {
      setError(
        causa instanceof ErrorFoto
          ? causa.message
          : 'No se pudo procesar la foto. Intente tomarla de nuevo o elija otra imagen.',
      );
    } finally {
      setFotos((lista) => [...lista, ...nuevas]);
      setProcesando(false);
    }
  }, []);

  const quitar = useCallback((id: string) => {
    setFotos((lista) => {
      const foto = lista.find((f) => f.id === id);
      if (foto) {
        liberar(foto);
      }
      return lista.filter((f) => f.id !== id);
    });
  }, []);

  const limpiar = useCallback(() => {
    setFotos((lista) => {
      lista.forEach(liberar);
      return [];
    });
    setError(null);
  }, []);

  return { fotos, procesando, error, agregar, quitar, limpiar };
}

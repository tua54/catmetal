import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Aviso } from './Aviso';
import {
  ContextoAvisos,
  DURACION_AVISO_MS,
  DURACION_MINIMA_AVISO_MS,
  type ApiAvisos,
  type DatosAviso,
  type TonoAviso,
} from './contexto-avisos';

interface AvisoActivo {
  id: string;
  tono: TonoAviso;
  titulo: string;
  mensaje?: string;
  duracionMs: number | null;
}

function duracionEfectiva(aviso: DatosAviso): number | null {
  const tono = aviso.tono ?? 'info';
  const pedida =
    aviso.duracionMs === undefined
      ? tono === 'error'
        ? null
        : DURACION_AVISO_MS
      : aviso.duracionMs;
  return pedida === null ? null : Math.max(DURACION_MINIMA_AVISO_MS, pedida);
}

/**
 * Proveedor del sistema de toasts. Mantiene dos regiones vivas siempre presentes (así los lectores
 * de pantalla las registran antes de que llegue el contenido):
 * - `role="status"` (educada) para `info` y `exito`;
 * - `role="alert"` (asertiva) para `advertencia` y `error`.
 *
 * Cada toast dura al menos 5 s, se pausa mientras tiene el foco o el puntero encima, y los errores
 * no se cierran solos. Todos tienen botón "Cerrar aviso" de 44 px.
 */
export function ProveedorAvisos({ children }: { children: ReactNode }) {
  const [avisos, setAvisos] = useState<AvisoActivo[]>([]);
  const contador = useRef(0);

  const cerrar = useCallback((id: string) => {
    setAvisos((lista) => lista.filter((aviso) => aviso.id !== id));
  }, []);

  const mostrar = useCallback((datos: DatosAviso) => {
    contador.current += 1;
    const id = `aviso-${contador.current}`;
    setAvisos((lista) => [
      ...lista,
      {
        id,
        tono: datos.tono ?? 'info',
        titulo: datos.titulo,
        mensaje: datos.mensaje,
        duracionMs: duracionEfectiva(datos),
      },
    ]);
    return id;
  }, []);

  const api = useMemo<ApiAvisos>(() => ({ mostrar, cerrar }), [mostrar, cerrar]);

  const educados = avisos.filter((aviso) => aviso.tono === 'info' || aviso.tono === 'exito');
  const asertivos = avisos.filter(
    (aviso) => aviso.tono === 'advertencia' || aviso.tono === 'error',
  );

  return (
    <ContextoAvisos.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-end">
        <div role="alert" className="flex w-full max-w-md flex-col gap-2">
          {asertivos.map((aviso) => (
            <Toast key={aviso.id} aviso={aviso} alCerrar={cerrar} />
          ))}
        </div>
        <div role="status" className="flex w-full max-w-md flex-col gap-2">
          {educados.map((aviso) => (
            <Toast key={aviso.id} aviso={aviso} alCerrar={cerrar} />
          ))}
        </div>
      </div>
    </ContextoAvisos.Provider>
  );
}

function Toast({ aviso, alCerrar }: { aviso: AvisoActivo; alCerrar: (id: string) => void }) {
  const [pausado, setPausado] = useState(false);

  useEffect(() => {
    if (aviso.duracionMs === null || pausado) {
      return;
    }
    const temporizador = window.setTimeout(() => alCerrar(aviso.id), aviso.duracionMs);
    return () => window.clearTimeout(temporizador);
  }, [aviso.id, aviso.duracionMs, pausado, alCerrar]);

  return (
    <div
      className="pointer-events-auto motion-safe:animate-entrada"
      onFocus={() => setPausado(true)}
      onBlur={(evento) => {
        if (!evento.currentTarget.contains(evento.relatedTarget)) {
          setPausado(false);
        }
      }}
      onPointerEnter={() => setPausado(true)}
      onPointerLeave={() => setPausado(false)}
    >
      <Aviso
        tono={aviso.tono}
        titulo={aviso.titulo}
        alCerrar={() => alCerrar(aviso.id)}
        className="shadow-lg"
      >
        {aviso.mensaje}
      </Aviso>
    </div>
  );
}

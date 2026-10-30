import { Outlet, useMatches, useNavigate } from 'react-router';
import { useEncabezado } from '../../app/encabezado';
import { useSesion } from '../../auth';
import { AvisoActualizacion } from '../../pwa/AvisoActualizacion';
import { RUTAS } from '../../rutas/acceso';
import { useEstadoSync } from '../../sync';
import { BarraSuperior } from '../ui/BarraSuperior';
import { PildoraConexion, type EstadoConexion } from '../ui/PildoraConexion';
import { AvisosSesion } from './AvisosSesion';
import { MenuUsuario } from './MenuUsuario';
import { PantallaBloqueo } from './PantallaBloqueo';

/** Datos opcionales que cada ruta puede declarar en `handle` para la barra superior. */
export interface HandleRuta {
  titulo?: string;
  subtitulo?: string;
}

function esHandleRuta(valor: unknown): valor is HandleRuta {
  return typeof valor === 'object' && valor !== null && 'titulo' in valor;
}

const TITULO_POR_DEFECTO = 'Control de Materia Prima';
const SUBTITULO_POR_DEFECTO = 'Catmetal S.A.S.';

/** Píldora de la barra superior conectada al estado global de sincronización (§6 punto 8). */
function PildoraSync() {
  const navegar = useNavigate();
  const estado = useEstadoSync((s): EstadoConexion =>
    s.sincronizando ? 'sincronizando' : s.conexion,
  );
  // "Por sincronizar" cuenta registros y fotos, igual que `textoIndicador`.
  const pendientes = useEstadoSync((s) => s.pendientes + s.fotosPendientes);
  return (
    <PildoraConexion
      estado={estado}
      pendientes={pendientes}
      alPresionar={() => void navegar(RUTAS.sincronizacion)}
    />
  );
}

/**
 * Estructura común: barra superior (ADR 0011) con título y subtítulo del `handle` de la ruta más
 * profunda que los declare, píldora de conexión y menú de la cuenta; avisos permanentes; contenido
 * sobre surface-50. Sin usuario (solo `/diseno` en desarrollo) no muestra píldora ni cuenta.
 */
export function AppLayout() {
  const matches = useMatches();
  const hayUsuario = useSesion((estado) => estado.usuario !== null);
  const subtituloDinamico = useEncabezado((estado) => estado.subtitulo);
  const handle = [...matches]
    .reverse()
    .map((match) => match.handle)
    .find(esHandleRuta);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-brand-600"
      >
        Saltar al contenido
      </a>

      <BarraSuperior
        titulo={handle?.titulo ?? TITULO_POR_DEFECTO}
        subtitulo={subtituloDinamico ?? handle?.subtitulo ?? SUBTITULO_POR_DEFECTO}
        conexion={hayUsuario ? <PildoraSync /> : undefined}
        usuario={hayUsuario ? <MenuUsuario /> : undefined}
      />

      <main
        id="contenido"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 focus:outline-none sm:px-6"
      >
        <AvisoActualizacion />
        <AvisosSesion />
        <div>
          <Outlet />
        </div>
      </main>

      {/* Bloqueo por inactividad (ADR 0017 §1): tapa todo y deja el resto inerte. */}
      <PantallaBloqueo />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Aviso, Boton, useAvisos } from '../components/ui';
import { useEstadoPwa } from './registro';

/**
 * Aviso de versión nueva del Service Worker. Es un aviso fijo con botón (no un toast): los toasts
 * se cierran solos y no deben llevar acciones (WCAG 2.2.1). Además avisa con un toast, una sola
 * vez, cuando la app queda lista para trabajar sin conexión.
 */
export function AvisoActualizacion({ className }: { className?: string }) {
  const disponible = useEstadoPwa((estado) => estado.actualizacionDisponible);
  const actualizar = useEstadoPwa((estado) => estado.actualizar);
  const listaSinConexion = useEstadoPwa((estado) => estado.listaSinConexion);
  const { mostrar } = useAvisos();
  const [actualizando, setActualizando] = useState(false);

  useEffect(() => {
    if (listaSinConexion) {
      mostrar({
        tono: 'exito',
        titulo: 'Lista para trabajar sin conexión',
        mensaje: 'La aplicación quedó guardada en esta tablet.',
      });
      useEstadoPwa.setState({ listaSinConexion: false });
    }
  }, [listaSinConexion, mostrar]);

  if (!disponible || actualizar === null) {
    return null;
  }

  return (
    <Aviso
      tono="info"
      anunciar
      titulo="Hay una versión nueva"
      className={className}
      alCerrar={() => useEstadoPwa.setState({ actualizacionDisponible: false })}
      accion={
        <Boton
          cargando={actualizando}
          textoCargando="Actualizando…"
          onClick={() => {
            setActualizando(true);
            actualizar().catch(() => setActualizando(false));
          }}
        >
          Actualizar
        </Boton>
      }
    >
      Termine o guarde lo que está registrando y toque «Actualizar». Sus registros guardados en esta
      tablet no se pierden.
    </Aviso>
  );
}

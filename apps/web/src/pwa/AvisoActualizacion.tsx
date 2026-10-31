import { useEffect, useId, useState } from 'react';
import { Aviso, Boton, CapaModal, useAvisos } from '../components/ui';
import { useEstadoPwa } from './registro';

/**
 * Aviso de versión nueva del Service Worker. Es un aviso fijo con botón (no un toast): los toasts
 * se cierran solos y no deben llevar acciones (WCAG 2.2.1). Además avisa con un toast, una sola
 * vez, cuando la app queda lista para trabajar sin conexión.
 *
 * Si el servidor exige una versión más nueva (426 `CLIENTE_DESACTUALIZADO`, B5, ADR 0026), en su
 * lugar se muestra un aviso BLOQUEANTE mientras la app se actualiza sola.
 */
export function AvisoActualizacion({ className }: { className?: string }) {
  const disponible = useEstadoPwa((estado) => estado.actualizacionDisponible);
  const actualizar = useEstadoPwa((estado) => estado.actualizar);
  const listaSinConexion = useEstadoPwa((estado) => estado.listaSinConexion);
  const desactualizado = useEstadoPwa((estado) => estado.desactualizado);
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

  if (desactualizado) {
    return <AvisoClienteDesactualizado />;
  }

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

/**
 * B5: el servidor ya no acepta esta versión. Tapa la app (el resto queda `inert`) hasta que la
 * versión nueva se active y la página se recargue. Escape no lo cierra. Si la versión nueva no está
 * disponible (sin red), lo explica y se reintenta solo en la próxima sync, o con «Reintentar».
 */
function AvisoClienteDesactualizado() {
  const sinVersionNueva = useEstadoPwa((estado) => estado.sinVersionNueva);
  const forzar = useEstadoPwa((estado) => estado.forzarActualizacion);
  const idTitulo = useId();
  const idDescripcion = useId();

  return (
    <CapaModal
      abierto
      rol="alertdialog"
      // Bloqueante: no hay forma de volver a la app vieja.
      alCerrar={() => undefined}
      idTitulo={idTitulo}
      idDescripcion={idDescripcion}
      claseFondo="bg-ink-950 p-4"
      className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl sm:p-8"
    >
      <h2 id={idTitulo} className="text-2xl font-bold text-ink-950">
        Hay una versión nueva de la app. Actualizando…
      </h2>
      <div id={idDescripcion} className="mt-3 flex flex-col gap-3 text-ink-700">
        <p>
          Sus registros pendientes siguen guardados en esta tablet: no se pierden y se enviarán con
          la versión nueva.
        </p>
        {sinVersionNueva && (
          <p role="status" className="font-semibold text-warning-800">
            Todavía no se pudo descargar la versión nueva. Revise la conexión: se intentará de nuevo
            cuando vuelva la señal.
          </p>
        )}
      </div>
      {sinVersionNueva && forzar !== null && (
        <Boton className="mt-6" anchoCompleto onClick={() => void forzar()}>
          Reintentar
        </Boton>
      )}
    </CapaModal>
  );
}

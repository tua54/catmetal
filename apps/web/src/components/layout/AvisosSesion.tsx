import { useCallback, useState } from 'react';
import { sesion, useSesion } from '../../auth';
import { useConsultaLocal } from '../../app/useConsultaLocal';
import { AVISO_PERSISTENCIA, requiereAvisoPersistencia, useEstadoSync } from '../../sync';
import { Aviso, Boton } from '../ui';
import { DialogoContrasena } from './DialogoContrasena';

/**
 * Avisos permanentes bajo la barra superior (§5 y §6):
 * - almacenamiento no persistente → "Sincroniza al menos una vez al día";
 * - sesión sin conexión → los registros se guardan en la tablet;
 * - sesión del servidor perdida → pedir la contraseña para poder sincronizar;
 * - pendientes de otros usuarios de la tablet → "Hay N registros pendientes de <A>".
 */
export function AvisosSesion() {
  const usuario = useSesion((estado) => estado.usuario);
  const modo = useSesion((estado) => estado.modo);
  const requiereContrasena = useSesion((estado) => estado.requiere_contrasena);
  const sinPersistencia = useEstadoSync(requiereAvisoPersistencia);
  const conexion = useEstadoSync((estado) => estado.conexion);
  const [pidiendoContrasena, setPidiendoContrasena] = useState(false);

  const userId = usuario?.id ?? null;
  const consultarOtros = useCallback(() => sesion.pendientesDeOtrosUsuarios(userId), [userId]);
  const { datos: otros } = useConsultaLocal(usuario === null ? null : consultarOtros);

  if (usuario === null) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 empty:hidden">
      {sinPersistencia && (
        <Aviso tono="advertencia" titulo={AVISO_PERSISTENCIA}>
          Este navegador no garantiza conservar los datos de la tablet: si pasa varios días sin
          sincronizar, podría borrarlos.
        </Aviso>
      )}

      {requiereContrasena ? (
        <Aviso
          tono="advertencia"
          titulo="Sus registros no se pueden enviar todavía"
          accion={
            conexion === 'en_linea' ? (
              <Boton onClick={() => setPidiendoContrasena(true)}>Escribir contraseña</Boton>
            ) : undefined
          }
        >
          {conexion === 'en_linea'
            ? 'Para sincronizar, escriba de nuevo su contraseña. Mientras tanto, sus registros se guardan en esta tablet.'
            : 'Cuando vuelva la conexión, escriba de nuevo su contraseña para enviarlos. Mientras tanto, se guardan en esta tablet.'}
        </Aviso>
      ) : (
        modo === 'offline' && (
          <Aviso tono="info" titulo="Trabajando sin conexión">
            Sus registros se guardan en esta tablet y se enviarán cuando haya conexión.
          </Aviso>
        )
      )}

      {otros?.map((pendiente) => (
        <Aviso key={pendiente.user_id} tono="info" titulo={pendiente.mensaje}>
          Se enviarán cuando {pendiente.nombre ?? 'esa persona'} inicie sesión en esta tablet. No se
          envían con su sesión.
        </Aviso>
      ))}

      <DialogoContrasena
        abierto={pidiendoContrasena}
        alCerrar={() => setPidiendoContrasena(false)}
      />
    </div>
  );
}

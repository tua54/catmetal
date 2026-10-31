import { useId, useRef, useState, type FormEvent } from 'react';
import { ErrorSesion, useSesion } from '../../auth';
import { Boton, Campo, CapaModal } from '../ui';
import { mensajeErrorLogin } from '../../pages/comunes/mensajes-login';

export interface PropsDialogoContrasena {
  abierto: boolean;
  alCerrar: () => void;
}

/**
 * Pide de nuevo la contraseña del usuario de la sesión cuando la sesión del servidor se perdió
 * (`requiere_contrasena`): sin ella no se puede sincronizar (§5). El correo es fijo: no sirve para
 * cambiar de usuario.
 */
export function DialogoContrasena({ abierto, alCerrar }: PropsDialogoContrasena) {
  if (!abierto) {
    return null;
  }
  return <ContenidoDialogo alCerrar={alCerrar} />;
}

function ContenidoDialogo({ alCerrar }: { alCerrar: () => void }) {
  const usuario = useSesion((estado) => estado.usuario);
  const iniciarSesion = useSesion((estado) => estado.iniciarSesion);
  const idTitulo = useId();
  const idDescripcion = useId();
  const refCampo = useRef<HTMLInputElement>(null);
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (usuario === null || enviando) {
      return;
    }
    if (contrasena === '') {
      setError('Escriba su contraseña.');
      refCampo.current?.focus();
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      const estado = await iniciarSesion(usuario.email, contrasena);
      if (estado.modo === 'online') {
        alCerrar();
      } else {
        setError(
          'No hay conexión con el servidor. Sus registros siguen guardados; intente cuando vuelva la señal.',
        );
      }
    } catch (causa) {
      setError(
        causa instanceof ErrorSesion && causa.code === 'SIN_LOGIN_PREVIO'
          ? 'No hay conexión con el servidor. Intente cuando vuelva la señal.'
          : mensajeErrorLogin(causa),
      );
      refCampo.current?.focus();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <CapaModal
      abierto
      alCerrar={alCerrar}
      idTitulo={idTitulo}
      idDescripcion={idDescripcion}
      refFocoInicial={refCampo}
      className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl"
    >
      <h2 id={idTitulo} className="text-xl font-bold text-ink-950">
        Escriba de nuevo su contraseña
      </h2>
      <p id={idDescripcion} className="mt-2 text-ink-700">
        Para enviar sus registros al servidor hay que confirmar su sesión ({usuario?.email}).
      </p>
      <form
        noValidate
        onSubmit={(evento) => void enviar(evento)}
        className="mt-6 flex flex-col gap-6"
      >
        <Campo
          ref={refCampo}
          etiqueta="Contraseña"
          type="password"
          autoComplete="current-password"
          requerido
          value={contrasena}
          error={error ?? undefined}
          onChange={(evento) => setContrasena(evento.target.value)}
        />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Boton variante="secundario" tamano="grande" onClick={alCerrar}>
            Cancelar
          </Boton>
          <Boton type="submit" tamano="grande" cargando={enviando} textoCargando="Verificando…">
            Confirmar
          </Boton>
        </div>
      </form>
    </CapaModal>
  );
}

import { useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useSesion } from '../../auth';
import { mensajeErrorLogin } from '../../pages/comunes/mensajes-login';
import { RUTAS } from '../../rutas/acceso';
import { Aviso, Boton, Campo, CapaModal, useAvisos } from '../ui';

/**
 * Bloqueo por inactividad (ADR 0017 §1, F4-01): tras 10 minutos sin usar la tablet, o al recargar
 * con una sesión de la cookie cuyo último acceso es viejo, la app queda detrás de esta pantalla
 * opaca. El resto de la página queda `inert` (no se puede registrar), pero conserva su estado y la
 * sync sigue enviando lo ya encolado.
 *
 * - "Confirmar": contraseña contra el verificador local (sin red) o, si no hay verificador o no
 *   coincide y hay red, contra el servidor.
 * - "No soy <nombre>": cierra la sesión con las reglas de pendientes (§5): si hay registros sin
 *   enviar, se conservan en la tablet y se avisa.
 */
export function PantallaBloqueo() {
  const bloqueada = useSesion((estado) => estado.bloqueada && estado.usuario !== null);
  if (!bloqueada) {
    return null;
  }
  return <ContenidoBloqueo />;
}

function ContenidoBloqueo() {
  const usuario = useSesion((estado) => estado.usuario);
  const confirmarIdentidad = useSesion((estado) => estado.confirmarIdentidad);
  const cerrarSesion = useSesion((estado) => estado.cerrarSesion);
  const navegar = useNavigate();
  const { mostrar } = useAvisos();
  const idTitulo = useId();
  const idDescripcion = useId();
  const refCampo = useRef<HTMLInputElement>(null);
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [saliendo, setSaliendo] = useState(false);

  const nombre = usuario?.nombre ?? '';

  async function confirmar(evento: FormEvent) {
    evento.preventDefault();
    if (enviando || saliendo) {
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
      await confirmarIdentidad(contrasena);
      // Al desbloquearse, la sesión se publica y esta pantalla desaparece.
    } catch (causa) {
      setError(mensajeErrorLogin(causa));
      setContrasena('');
      refCampo.current?.focus();
    } finally {
      setEnviando(false);
    }
  }

  async function noSoy() {
    if (enviando || saliendo) {
      return;
    }
    setSaliendo(true);
    try {
      const { pendientes } = await cerrarSesion();
      const total = pendientes.mutaciones + pendientes.evidencias;
      mostrar(
        total > 0
          ? {
              tono: 'advertencia',
              titulo: 'Sesión cerrada',
              mensaje: `Los registros sin sincronizar de ${nombre} siguen guardados en esta tablet. Se enviarán cuando esa persona vuelva a iniciar sesión con conexión.`,
            }
          : { tono: 'exito', titulo: 'Sesión cerrada' },
      );
      void navegar(RUTAS.login, { replace: true });
    } catch {
      setError('No se pudo cerrar la sesión. Intente de nuevo.');
      setSaliendo(false);
    }
  }

  return (
    <CapaModal
      abierto
      // Escape no desbloquea: la única salida es confirmar o "No soy <nombre>".
      alCerrar={() => undefined}
      idTitulo={idTitulo}
      idDescripcion={idDescripcion}
      refFocoInicial={refCampo}
      claseFondo="bg-ink-950 p-4"
      className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl sm:p-8"
    >
      <h2 id={idTitulo} className="text-2xl font-bold text-ink-950">
        Confirme que es {nombre}
      </h2>
      <p id={idDescripcion} className="mt-2 text-ink-700">
        La tablet estuvo un rato sin uso. Para seguir, escriba su contraseña.
      </p>

      {error && (
        <Aviso tono="error" titulo="No se pudo confirmar" anunciar className="mt-4">
          {error}
        </Aviso>
      )}

      <form
        noValidate
        onSubmit={(evento) => void confirmar(evento)}
        className="mt-6 flex flex-col gap-5"
      >
        <Campo
          ref={refCampo}
          etiqueta="Contraseña"
          type="password"
          autoComplete="current-password"
          requerido
          value={contrasena}
          onChange={(evento) => setContrasena(evento.target.value)}
        />
        <Boton
          type="submit"
          tamano="grande"
          anchoCompleto
          cargando={enviando}
          textoCargando="Verificando…"
        >
          Confirmar
        </Boton>
        <Boton
          variante="secundario"
          tamano="grande"
          anchoCompleto
          cargando={saliendo}
          textoCargando="Cerrando sesión…"
          onClick={() => void noSoy()}
        >
          No soy {nombre}
        </Boton>
      </form>
    </CapaModal>
  );
}

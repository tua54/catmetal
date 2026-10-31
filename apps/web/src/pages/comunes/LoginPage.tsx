import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import logoCatmetal from '../../assets/brand/logo-catmetal.png';
import { sesion, useSesion, type PerfilDelDispositivo } from '../../auth';
import { useArranque } from '../../app/estado-arranque';
import { useTituloDocumento } from '../../app/navegacion-accesible';
import { useConsultaLocal } from '../../app/useConsultaLocal';
import { Aviso, Boton, Campo, IconoSinConexion } from '../../components/ui';
import { AvisoActualizacion } from '../../pwa/AvisoActualizacion';
import { destinoTrasLogin } from '../../rutas/acceso';
import type { EstadoLogin } from '../../rutas/guardas';
import { useEstadoSync } from '../../sync';
import { mensajeErrorLogin } from './mensajes-login';
import { PantallaCarga } from './PantallaCarga';

const consultarPerfiles = () => sesion.perfilesDelDispositivo();
// En el login no hay usuario activo: se muestran los pendientes de TODOS los usuarios de la tablet.
const consultarPendientes = () => sesion.pendientesDeOtrosUsuarios(null);

function leerDesde(estado: unknown): string | null {
  if (typeof estado === 'object' && estado !== null && 'desde' in estado) {
    const { desde } = estado as EstadoLogin;
    return typeof desde === 'string' ? desde : null;
  }
  return null;
}

/**
 * Inicio de sesión (§5 y §8): con conexión contra el servidor; sin conexión, solo para quien ya
 * inició sesión con conexión en esta tablet. Al entrar redirige por rol (o a la ruta pedida si el
 * rol la permite).
 */
export function LoginPage() {
  const listo = useArranque((estado) => estado.listo);
  const usuario = useSesion((estado) => estado.usuario);
  const permisos = useSesion((estado) => estado.permisos);
  const modo = useSesion((estado) => estado.modo);
  const ubicacion = useLocation();

  if (!listo) {
    return <PantallaCarga />;
  }
  if (modo !== 'sin_sesion' && usuario !== null) {
    return (
      <Navigate to={destinoTrasLogin({ usuario, permisos }, leerDesde(ubicacion.state))} replace />
    );
  }
  return <FormularioLogin />;
}

function FormularioLogin() {
  const iniciarSesion = useSesion((estado) => estado.iniciarSesion);
  const sinConexion = useEstadoSync((estado) => estado.conexion === 'sin_conexion');
  const { datos: perfiles } = useConsultaLocal(consultarPerfiles);
  const { datos: pendientes } = useConsultaLocal(consultarPendientes);
  const refCorreo = useRef<HTMLInputElement>(null);
  const refContrasena = useRef<HTMLInputElement>(null);
  const [correo, setCorreo] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [errores, setErrores] = useState<{ correo?: string; contrasena?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Perfil de la tablet elegido: el correo completo se usa para entrar pero nunca se muestra sin
  // autenticar (F4-04, Ley 1581); el campo muestra el enmascarado.
  const [elegido, setElegido] = useState<PerfilDelDispositivo | null>(null);
  useTituloDocumento('Iniciar sesión');

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (enviando) {
      return;
    }
    const nuevos: typeof errores = {};
    if (elegido === null && correo.trim() === '') {
      nuevos.correo = 'Escriba su correo.';
    }
    if (contrasena === '') {
      nuevos.contrasena = 'Escriba su contraseña.';
    }
    setErrores(nuevos);
    if (nuevos.correo || nuevos.contrasena) {
      (nuevos.correo ? refCorreo : refContrasena).current?.focus();
      return;
    }
    setError(null);
    setEnviando(true);
    try {
      // Al publicarse la sesión, `LoginPage` redirige.
      await iniciarSesion(elegido?.email ?? correo.trim(), contrasena);
    } catch (causa) {
      setError(mensajeErrorLogin(causa));
      setContrasena('');
      refContrasena.current?.focus();
    } finally {
      setEnviando(false);
    }
  }

  function elegirPerfil(perfil: PerfilDelDispositivo) {
    setElegido(perfil);
    setCorreo('');
    setErrores({});
    setError(null);
    refContrasena.current?.focus();
  }

  function usarOtroCorreo() {
    setElegido(null);
    setErrores({});
    // El campo deja de ser de solo lectura en el próximo render.
    setTimeout(() => refCorreo.current?.focus(), 0);
  }

  return (
    <div className="flex min-h-dvh flex-col items-center bg-ink-950 px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-10">
      <img
        src={logoCatmetal}
        alt="Catmetal"
        width={180}
        height={36}
        className="h-10 w-auto sm:h-12"
      />
      <span aria-hidden="true" className="mt-4 block h-[3px] w-16 bg-brand-600" />

      <main className="mt-8 flex w-full max-w-md flex-col gap-4">
        <AvisoActualizacion />

        <section
          aria-labelledby="titulo-login"
          className="rounded-xl border border-line-200 bg-white p-6 shadow-xl sm:p-8"
        >
          <h1 id="titulo-login" className="text-2xl font-bold text-ink-950">
            Control de Materia Prima
          </h1>
          <p className="mt-1 text-ink-500">Inicie sesión para registrar y validar consumos.</p>

          {sinConexion && (
            <p className="mt-4 flex items-start gap-2 rounded-lg border border-warning-500 bg-warning-100 p-3 text-warning-800">
              <IconoSinConexion className="mt-0.5 size-5 shrink-0" />
              <span>
                <strong className="font-semibold">Sin conexión.</strong> Solo pueden entrar quienes
                ya iniciaron sesión con conexión en esta tablet.
              </span>
            </p>
          )}

          {error && (
            <Aviso tono="error" titulo="No se pudo iniciar sesión" anunciar className="mt-4">
              {error}
            </Aviso>
          )}

          <form
            noValidate
            onSubmit={(evento) => void enviar(evento)}
            className="mt-6 flex flex-col gap-5"
          >
            {elegido === null ? (
              <Campo
                ref={refCorreo}
                etiqueta="Correo"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                requerido
                value={correo}
                error={errores.correo}
                onChange={(evento) => setCorreo(evento.target.value)}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <Campo
                  etiqueta="Correo"
                  type="text"
                  readOnly
                  autoComplete="off"
                  value={elegido.email_enmascarado}
                  ayuda={
                    elegido.offline_disponible
                      ? `${elegido.nombre} · Puede entrar sin conexión`
                      : elegido.nombre
                  }
                />
                <Boton variante="fantasma" className="self-start" onClick={usarOtroCorreo}>
                  Usar otro correo
                </Boton>
              </div>
            )}
            <Campo
              ref={refContrasena}
              etiqueta="Contraseña"
              type="password"
              autoComplete="current-password"
              requerido
              value={contrasena}
              error={errores.contrasena}
              onChange={(evento) => setContrasena(evento.target.value)}
            />
            <Boton
              type="submit"
              tamano="grande"
              anchoCompleto
              cargando={enviando}
              textoCargando="Verificando…"
            >
              Iniciar sesión
            </Boton>
          </form>
        </section>

        {pendientes && pendientes.length > 0 && (
          <section aria-label="Registros pendientes en esta tablet" className="flex flex-col gap-3">
            {pendientes.map((pendiente) => (
              <Aviso key={pendiente.user_id} tono="advertencia" titulo={pendiente.mensaje}>
                Se enviarán cuando {pendiente.nombre ?? 'esa persona'} inicie sesión con conexión en
                esta tablet. No se envían con la sesión de otra persona.
              </Aviso>
            ))}
          </section>
        )}

        {perfiles && perfiles.length > 0 && (
          <section
            aria-labelledby="titulo-perfiles"
            className="rounded-xl border border-white/20 bg-white/5 p-4 text-white"
          >
            <h2 id="titulo-perfiles" className="font-semibold">
              Usuarios de esta tablet
            </h2>
            <ul className="mt-3 flex flex-col gap-2">
              {perfiles.map((perfil) => (
                <li key={perfil.user_id}>
                  <button
                    type="button"
                    onClick={() => elegirPerfil(perfil)}
                    className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-white/25 bg-white/10 px-4 py-2 text-left active:bg-white/20"
                  >
                    <span className="font-semibold">{perfil.nombre}</span>
                    <span className="text-sm text-ink-300">{perfil.email_enmascarado}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

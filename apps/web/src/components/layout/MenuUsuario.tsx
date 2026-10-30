import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSesion } from '../../auth';
import { puedeBorrarDatosDeUsuario } from '../../datos';
import { NOMBRE_ROL, RUTAS } from '../../rutas/acceso';
import { Avatar, DialogoConfirmacion, IconoChevronDerecha, useAvisos } from '../ui';
import { nombreBotonCuenta } from '../ui/clases';

interface Pendientes {
  mutaciones: number;
  evidencias: number;
}

function textoPendientes({ mutaciones, evidencias }: Pendientes): string {
  const partes: string[] = [];
  if (mutaciones > 0) {
    partes.push(mutaciones === 1 ? '1 registro' : `${mutaciones} registros`);
  }
  if (evidencias > 0) {
    partes.push(evidencias === 1 ? '1 foto' : `${evidencias} fotos`);
  }
  return partes.join(' y ');
}

/**
 * Avatar con el menú de la cuenta (patrón "disclosure": botón con `aria-expanded` que muestra una
 * lista de acciones). Cerrar sesión pide confirmación y, si hay pendientes, advierte que se
 * conservan en la tablet (§5: solo se borran los datos locales si no hay pendientes).
 */
export function MenuUsuario() {
  const usuario = useSesion((estado) => estado.usuario);
  const cerrarSesion = useSesion((estado) => estado.cerrarSesion);
  const navegar = useNavigate();
  const { mostrar } = useAvisos();
  const idMenu = useId();
  const refContenedor = useRef<HTMLDivElement>(null);
  const refBoton = useRef<HTMLButtonElement>(null);
  const [abierto, setAbierto] = useState(false);
  const [confirmando, setConfirmando] = useState<Pendientes | null>(null);
  const [cerrando, setCerrando] = useState(false);

  useEffect(() => {
    if (!abierto) {
      return;
    }
    function alPresionarFuera(evento: PointerEvent) {
      if (!refContenedor.current?.contains(evento.target as Node)) {
        setAbierto(false);
      }
    }
    function alTeclear(evento: KeyboardEvent) {
      if (evento.key === 'Escape') {
        setAbierto(false);
        refBoton.current?.focus();
      }
    }
    document.addEventListener('pointerdown', alPresionarFuera);
    document.addEventListener('keydown', alTeclear);
    return () => {
      document.removeEventListener('pointerdown', alPresionarFuera);
      document.removeEventListener('keydown', alTeclear);
    };
  }, [abierto]);

  if (usuario === null) {
    return null;
  }
  const rol = NOMBRE_ROL[usuario.rol] ?? usuario.rol;

  async function pedirConfirmacion() {
    setAbierto(false);
    if (usuario === null) {
      return;
    }
    try {
      const { mutaciones, evidencias } = await puedeBorrarDatosDeUsuario(usuario.id);
      setConfirmando({ mutaciones, evidencias });
    } catch {
      // Si no se pudo contar, se asume lo más prudente: que hay pendientes (no se borra nada).
      setConfirmando({ mutaciones: 1, evidencias: 0 });
    }
  }

  async function confirmarCierre() {
    setCerrando(true);
    try {
      const resultado = await cerrarSesion();
      const pendientes = textoPendientes(resultado.pendientes);
      mostrar(
        pendientes
          ? {
              tono: 'advertencia',
              titulo: 'Sesión cerrada',
              mensaje: `Sus ${pendientes} sin sincronizar siguen guardados en esta tablet. Se enviarán cuando vuelva a iniciar sesión con conexión.`,
            }
          : { tono: 'exito', titulo: 'Sesión cerrada' },
      );
      void navegar(RUTAS.login, { replace: true });
    } catch {
      mostrar({
        tono: 'error',
        titulo: 'No se pudo cerrar la sesión',
        mensaje: 'Intente de nuevo. Sus registros siguen guardados en esta tablet.',
      });
    } finally {
      setCerrando(false);
      setConfirmando(null);
    }
  }

  const conPendientes = confirmando !== null && confirmando.mutaciones + confirmando.evidencias > 0;

  return (
    <div ref={refContenedor} className="relative">
      <button
        ref={refBoton}
        type="button"
        aria-expanded={abierto}
        aria-controls={idMenu}
        aria-label={nombreBotonCuenta(usuario.nombre, rol)}
        onClick={() => setAbierto((valor) => !valor)}
        className="inline-flex rounded-full"
      >
        <Avatar nombre={usuario.nombre} decorativo />
      </button>

      <div
        id={idMenu}
        hidden={!abierto}
        className="absolute top-full right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-line-200 bg-white p-2 text-ink-700 shadow-xl"
      >
        <div className="border-b border-line-200 px-3 pt-2 pb-3">
          <p className="truncate font-semibold text-ink-950">{usuario.nombre}</p>
          <p className="text-sm text-ink-500">{rol}</p>
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          <li>
            <Link
              to={RUTAS.sincronizacion}
              onClick={() => setAbierto(false)}
              className="flex min-h-12 items-center justify-between gap-2 rounded-lg px-3 font-medium text-ink-950 active:bg-surface-200"
            >
              Estado de sincronización
              <IconoChevronDerecha className="size-5 shrink-0 text-ink-500" />
            </Link>
          </li>
          <li>
            <button
              type="button"
              onClick={() => void pedirConfirmacion()}
              className="flex min-h-12 w-full items-center rounded-lg px-3 text-left font-medium text-danger-700 active:bg-danger-50"
            >
              Cerrar sesión
            </button>
          </li>
        </ul>
      </div>

      <DialogoConfirmacion
        abierto={confirmando !== null}
        titulo="¿Cerrar sesión?"
        tono={conPendientes ? 'primario' : 'peligro'}
        textoConfirmar="Cerrar sesión"
        cargando={cerrando}
        descripcion={
          conPendientes ? (
            <>
              <p className="font-semibold text-warning-800">
                Tiene {textoPendientes(confirmando)} sin sincronizar.
              </p>
              <p className="mt-2">
                No se borran: se conservan en esta tablet y se enviarán cuando usted vuelva a
                iniciar sesión con conexión. Nadie más puede enviarlos con su sesión.
              </p>
            </>
          ) : (
            <p>
              Todo está sincronizado. Se cerrará su sesión y se borrarán de esta tablet sus datos ya
              enviados (los registros rechazados o en conflicto se conservan).
            </p>
          )
        }
        alConfirmar={() => void confirmarCierre()}
        alCancelar={() => setConfirmando(null)}
      />
    </div>
  );
}

import { cx } from './clases';
import { IconoGiro } from './iconos';

export type EstadoConexion = 'sin_conexion' | 'en_linea' | 'sincronizando';

export interface PropsPildoraConexion {
  estado: EstadoConexion;
  /** Registros en la cola local que aún no llegan al servidor. */
  pendientes: number;
  /**
   * Opcional: abre la pantalla "Estado de sincronización". La región viva queda fuera del botón
   * para no mezclar el rol `status` con un control.
   */
  alPresionar?: () => void;
  className?: string;
}

function textoPendientes(pendientes: number): string {
  return `${pendientes} por sincronizar`;
}

/** Texto completo de la píldora (también se usa en las pruebas). */
function textoEstado(estado: EstadoConexion, pendientes: number): [string, string | null] {
  switch (estado) {
    case 'sin_conexion':
      return ['Sin conexión', pendientes > 0 ? textoPendientes(pendientes) : 'Nada pendiente'];
    case 'sincronizando':
      return ['Sincronizando…', pendientes > 0 ? textoPendientes(pendientes) : null];
    case 'en_linea':
      return ['En línea', pendientes > 0 ? textoPendientes(pendientes) : 'Todo sincronizado'];
  }
}

/**
 * Píldora de conexión para la barra superior oscura (fondo white/10 sobre ink-950 ≈ #292929):
 * texto blanco 14,35:1; punto ámbar 6,68:1; punto verde 8,24:1. El estado se dice con texto,
 * el punto solo lo refuerza. `role="status"` anuncia los cambios de forma educada.
 */
export function PildoraConexion({
  estado,
  pendientes,
  alPresionar,
  className,
}: PropsPildoraConexion) {
  const [principal, detalle] = textoEstado(estado, pendientes);

  const contenido = (
    <>
      {estado === 'sincronizando' ? (
        <IconoGiro className="size-4 shrink-0 text-white motion-safe:animate-spin" />
      ) : (
        <span
          aria-hidden="true"
          className={cx(
            'size-2.5 shrink-0 rounded-full',
            estado === 'sin_conexion' ? 'bg-warning-500' : 'bg-success-400',
          )}
        />
      )}
      <span className="cifras truncate">
        {principal}
        {detalle && (
          <>
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, </span>
            {detalle}
          </>
        )}
      </span>
    </>
  );

  const clases =
    'inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 text-sm font-medium whitespace-nowrap text-white';

  return (
    <div role="status" aria-live="polite" className={cx('min-w-0', className)}>
      {alPresionar ? (
        <button
          type="button"
          onClick={alPresionar}
          className={cx(clases, 'active:bg-white/20')}
          aria-label={`${principal}${detalle ? `, ${detalle}` : ''}. Ver estado de sincronización`}
        >
          {contenido}
        </button>
      ) : (
        <span className={clases}>{contenido}</span>
      )}
    </div>
  );
}

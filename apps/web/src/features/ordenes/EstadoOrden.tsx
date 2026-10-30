import type { EstadoOrden as TipoEstadoOrden } from '@catmetal/shared';
import { cx } from '../../components/ui/clases';
import { CLASE_ESTADO_ORDEN, NOMBRE_ESTADO_ORDEN } from './estado-orden';

/** Indicador del estado de una orden ("En proceso"). */
export function EstadoOrden({ estado }: { estado: TipoEstadoOrden }) {
  return (
    <span
      className={cx(
        'inline-flex min-h-8 items-center rounded-full border px-3 py-1 text-sm font-semibold whitespace-nowrap',
        CLASE_ESTADO_ORDEN[estado],
      )}
    >
      {NOMBRE_ESTADO_ORDEN[estado]}
    </span>
  );
}

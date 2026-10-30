import { formatearCantidad, formatearFechaHora } from '@catmetal/shared';
import { useId, useRef } from 'react';
import { Boton, CapaModal, Chip } from '../../components/ui';
import type { ConsumoLocal } from '../../datos';
import {
  accionesDeConsumo,
  chipDeConsumo,
  explicacionEstado,
  mensajeErrorSync,
} from './estado-consumo';

export type AccionElegida = 'editar' | 'corregir' | 'registrarDeNuevo' | 'justificar' | 'reenviar';

export interface PropsDialogoConsumo {
  userId: string;
  consumo: ConsumoLocal | null;
  nombreMaterial: string;
  alElegir: (accion: AccionElegida, consumo: ConsumoLocal) => void;
  alCerrar: () => void;
}

/**
 * Detalle de un consumo de "Registros de hoy": estado, motivo del rechazo o error del servidor y
 * las acciones que permite (S3 corrección, S4 edición, justificar la novedad).
 */
export function DialogoConsumo(props: PropsDialogoConsumo) {
  if (props.consumo === null) {
    return null;
  }
  return <Contenido {...props} consumo={props.consumo} />;
}

function Contenido({
  userId,
  consumo,
  nombreMaterial,
  alElegir,
  alCerrar,
}: PropsDialogoConsumo & { consumo: ConsumoLocal }) {
  const idTitulo = useId();
  const idDescripcion = useId();
  const refCerrar = useRef<HTMLButtonElement>(null);
  const acciones = accionesDeConsumo(consumo, userId);
  const validadoSinCorreccion =
    consumo.servidor?.estado === 'aprobado' &&
    (consumo.estado_local === 'rechazado_sync' || consumo.estado_local === 'conflicto');

  return (
    <CapaModal
      abierto
      alCerrar={alCerrar}
      idTitulo={idTitulo}
      idDescripcion={idDescripcion}
      refFocoInicial={refCerrar}
      className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id={idTitulo} className="text-xl font-bold text-ink-950">
          {nombreMaterial}
        </h2>
        <Chip estado={chipDeConsumo(consumo)} />
      </div>
      <p className="cifras mt-1 text-ink-700">
        {formatearCantidad(consumo.cantidad)} {consumo.unidad} · Lote {consumo.lote} ·{' '}
        {formatearFechaHora(consumo.client_created_at)}
      </p>

      <div id={idDescripcion} className="mt-4 flex flex-col gap-3 text-ink-700">
        <p>{explicacionEstado(consumo)}</p>
        {consumo.estado_local === 'rechazado' && (
          <p className="rounded-lg border border-l-[6px] border-danger-700 bg-danger-50 p-3">
            <span className="font-semibold text-ink-950">Motivo del rechazo:</span>{' '}
            {consumo.motivo_rechazo ?? 'El jefe no registró un motivo.'}
          </p>
        )}
        {(consumo.estado_local === 'rechazado_sync' || consumo.estado_local === 'conflicto') && (
          <p className="rounded-lg border border-l-[6px] border-danger-700 bg-danger-50 p-3">
            <span className="font-semibold text-ink-950">Respuesta del servidor:</span>{' '}
            {mensajeErrorSync(consumo.error_sync)}
            {consumo.error_sync?.code && (
              <span className="cifras mt-1 block text-sm">Código: {consumo.error_sync.code}</span>
            )}
          </p>
        )}
        {validadoSinCorreccion && (
          <p>
            El jefe ya validó este consumo. En esta versión un consumo validado no se corrige: si
            hay un error, avise al jefe.
          </p>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {acciones.reenviar && (
          <Boton tamano="grande" anchoCompleto onClick={() => alElegir('reenviar', consumo)}>
            Enviar de nuevo
          </Boton>
        )}
        {acciones.corregir && (
          <Boton tamano="grande" anchoCompleto onClick={() => alElegir('corregir', consumo)}>
            Crear corrección
          </Boton>
        )}
        {acciones.justificar && (
          <Boton tamano="grande" anchoCompleto onClick={() => alElegir('justificar', consumo)}>
            Justificar novedad
          </Boton>
        )}
        {acciones.registrarDeNuevo && (
          <Boton
            tamano="grande"
            anchoCompleto
            onClick={() => alElegir('registrarDeNuevo', consumo)}
          >
            Registrar de nuevo
          </Boton>
        )}
        {acciones.editar && (
          <Boton
            variante="secundario"
            tamano="grande"
            anchoCompleto
            onClick={() => alElegir('editar', consumo)}
          >
            {consumo.estado_local === 'conflicto' || consumo.estado_local === 'rechazado_sync'
              ? 'Editar de nuevo'
              : 'Editar registro'}
          </Boton>
        )}
        <Boton ref={refCerrar} variante="fantasma" anchoCompleto onClick={alCerrar}>
          Cerrar
        </Boton>
      </div>
    </CapaModal>
  );
}

import type { ElementoCola } from '@catmetal/shared';
import { Interruptor, SelectCorto, type OpcionSelectCorto } from '../../components/ui';
import type { FiltrosCola } from './api';

export interface PropsFiltrosCola {
  filtros: FiltrosCola;
  /** Consumos de los que salen las opciones (la cola sin filtrar y la visible). */
  elementos: readonly ElementoCola[];
  alCambiar: (filtros: FiltrosCola) => void;
}

function opciones(
  pares: Iterable<[string, string]>,
  seleccionado: string | null,
  textoDesconocido: string,
): OpcionSelectCorto[] {
  const mapa = new Map(pares);
  if (seleccionado !== null && !mapa.has(seleccionado)) {
    mapa.set(seleccionado, textoDesconocido);
  }
  return [...mapa]
    .map(([valor, etiqueta]) => ({ valor, etiqueta }))
    .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es-CO'));
}

/** Filtros de la cola (Figma): orden, supervisor y "con novedad". */
export function FiltrosColaValidacion({ filtros, elementos, alCambiar }: PropsFiltrosCola) {
  const ordenes = opciones(
    elementos.map((e) => [e.orden.id, `Orden ${e.orden.codigo}`]),
    filtros.orden,
    'Orden seleccionada',
  );
  const supervisores = opciones(
    elementos.map((e) => [e.supervisor.id, e.supervisor.nombre]),
    filtros.supervisor,
    'Supervisor seleccionado',
  );

  return (
    <div
      role="group"
      aria-label="Filtros de la cola"
      className="grid gap-4 sm:grid-cols-2 sm:items-end"
    >
      <SelectCorto
        etiqueta="Orden"
        textoVacio="Todas las órdenes"
        opciones={ordenes}
        value={filtros.orden ?? ''}
        onChange={(evento) => alCambiar({ ...filtros, orden: evento.target.value || null })}
      />
      <SelectCorto
        etiqueta="Supervisor"
        textoVacio="Todos los supervisores"
        opciones={supervisores}
        value={filtros.supervisor ?? ''}
        onChange={(evento) => alCambiar({ ...filtros, supervisor: evento.target.value || null })}
      />
      <Interruptor
        className="sm:col-span-2"
        etiqueta="Solo con novedad"
        ayuda="Consumos con justificación o que la requieren."
        activado={filtros.conNovedad}
        alCambiar={(activado) => alCambiar({ ...filtros, conNovedad: activado })}
      />
    </div>
  );
}

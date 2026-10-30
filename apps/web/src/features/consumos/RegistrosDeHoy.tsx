import { Chip, EstadoVacio, FilaRegistro, ListaRegistros, Tarjeta } from '../../components/ui';
import type { ConsumoLocal } from '../../datos';
import { nombreDeMaterial, type RegistroDeHoy } from './consultas';
import {
  accionesDeConsumo,
  chipDeConsumo,
  mensajeErrorSync,
  textoAccionChip,
} from './estado-consumo';

export interface PropsRegistrosDeHoy {
  userId: string;
  codigoOrden: string;
  registros: readonly RegistroDeHoy[] | undefined;
  alAbrir: (consumo: ConsumoLocal) => void;
}

/**
 * "Registros de hoy — Orden …" (Figma, columna derecha). El chip es accionable cuando hay algo que
 * ver o hacer (motivo del rechazo, corrección, justificar la novedad, editar un pendiente).
 */
export function RegistrosDeHoy({ userId, codigoOrden, registros, alAbrir }: PropsRegistrosDeHoy) {
  const titulo = `Registros de hoy — Orden ${codigoOrden}`;
  return (
    <Tarjeta titulo={titulo}>
      {registros === undefined ? (
        <p className="text-ink-500">Cargando registros…</p>
      ) : registros.length === 0 ? (
        <EstadoVacio
          titulo="Todavía no hay registros hoy"
          texto="Los consumos que guarde en esta tablet aparecerán aquí, con su estado de sincronización."
        />
      ) : (
        <ListaRegistros etiqueta={titulo}>
          {registros.map((registro) => {
            const c = registro.consumo;
            const chip = chipDeConsumo(c);
            const acciones = accionesDeConsumo(c, userId);
            const accionable =
              acciones.editar ||
              acciones.corregir ||
              acciones.justificar ||
              acciones.registrarDeNuevo ||
              chip === 'rechazado' ||
              chip === 'conflicto';
            const error =
              c.estado_local === 'rechazado_sync' || c.estado_local === 'conflicto'
                ? mensajeErrorSync(c.error_sync)
                : null;
            return (
              <FilaRegistro
                key={c.id}
                material={nombreDeMaterial(registro)}
                detalle={[
                  registro.material?.codigo,
                  `Lote ${c.lote}`,
                  c.corrige_a ? 'Corrección' : null,
                  error,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                cantidad={c.cantidad}
                unidad={c.unidad}
                fechaHora={c.client_created_at}
                conNovedad={registro.conNovedad}
                estado={
                  <Chip
                    estado={chip}
                    alPresionar={accionable ? () => alAbrir(c) : undefined}
                    textoAccion={`${textoAccionChip(chip)} de ${nombreDeMaterial(registro)}`}
                  />
                }
              />
            );
          })}
        </ListaRegistros>
      )}
    </Tarjeta>
  );
}

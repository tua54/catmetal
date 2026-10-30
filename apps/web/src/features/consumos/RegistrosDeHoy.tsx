import {
  Boton,
  Chip,
  ErrorCarga,
  EstadoVacio,
  FilaRegistro,
  ListaRegistros,
  Tarjeta,
  TextoCargando,
} from '../../components/ui';
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
  /** Error al leer los registros de IndexedDB (`undefined` = sin error). */
  error?: unknown;
  /** "Reintentar" tras un error de lectura. */
  alReintentar?: () => void;
  alAbrir: (consumo: ConsumoLocal) => void;
  /** Acción del estado vacío: llevar el foco al formulario de registro. */
  alIrAlFormulario?: () => void;
}

/**
 * "Registros de hoy — Orden …" (Figma, columna derecha). El chip es accionable cuando hay algo que
 * ver o hacer (motivo del rechazo, corrección, justificar la novedad, editar un pendiente).
 */
export function RegistrosDeHoy({
  userId,
  codigoOrden,
  registros,
  error,
  alReintentar,
  alAbrir,
  alIrAlFormulario,
}: PropsRegistrosDeHoy) {
  const titulo = `Registros de hoy — Orden ${codigoOrden}`;
  let contenido;
  if (error !== undefined) {
    contenido = (
      <ErrorCarga titulo="No se pudieron leer los registros de hoy" alReintentar={alReintentar}>
        Siguen guardados en esta tablet. Si el problema sigue, cierre y vuelva a abrir la
        aplicación.
      </ErrorCarga>
    );
  } else if (registros === undefined) {
    contenido = <TextoCargando texto="Cargando registros…" />;
  } else if (registros.length === 0) {
    contenido = (
      <EstadoVacio
        titulo="Todavía no hay registros hoy"
        texto="Los consumos que guarde en esta tablet aparecerán aquí, con su estado de sincronización."
        accion={
          alIrAlFormulario && (
            <Boton variante="secundario" onClick={alIrAlFormulario}>
              Ir al formulario
            </Boton>
          )
        }
      />
    );
  } else {
    contenido = (
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
            acciones.reenviar ||
            chip === 'rechazado' ||
            chip === 'conflicto';
          const errorSync =
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
                errorSync,
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
    );
  }
  return <Tarjeta titulo={titulo}>{contenido}</Tarjeta>;
}

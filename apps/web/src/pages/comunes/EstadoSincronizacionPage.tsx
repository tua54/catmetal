import { formatearCantidad, formatearFechaHora, MENSAJES_ERROR } from '@catmetal/shared';
import { useCallback, useState } from 'react';
import { useSesion } from '../../auth';
import { useSincronizacion } from '../../app/contexto-sincronizacion';
import { useConsultaLocal } from '../../app/useConsultaLocal';
import {
  Aviso,
  Boton,
  Chip,
  EstadoVacio,
  FilaRegistro,
  ListaRegistros,
  Tarjeta,
  useAvisos,
} from '../../components/ui';
import {
  consumosPendientesDeSync,
  consumosRechazados,
  db,
  leerMetaSync,
  mutacionesConProblema,
  type ConsumoLocal,
  type ErrorSync,
  type MaterialLocal,
  type MutacionOutbox,
} from '../../datos';
import { textoIndicador, useEstadoSync, type ResumenSync } from '../../sync';

const NOMBRE_MUTACION: Readonly<Record<MutacionOutbox['tipo'], string>> = {
  'consumo.crear': 'Registro de consumo',
  'consumo.editar': 'Edición de consumo',
  'novedad.crear': 'Novedad',
  'consumo.aprobar': 'Validación de consumo',
  'consumo.rechazar': 'Rechazo de consumo',
};

/** Mensaje en español de un error de sync: el del contrato si el código es conocido. */
function mensajeErrorSync(error: ErrorSync | null): string {
  if (error === null) {
    return 'Sin detalle del servidor.';
  }
  return error.code !== null ? MENSAJES_ERROR[error.code] : error.message;
}

interface DatosSincronizacion {
  pendientes: ConsumoLocal[];
  rechazadosPorJefe: ConsumoLocal[];
  problemas: MutacionOutbox[];
  /** Consumos afectados por las mutaciones con problema (por id). */
  consumos: Map<string, ConsumoLocal>;
  materiales: Map<string, MaterialLocal>;
  ultimoSync: string | null;
}

async function leerDatos(userId: string): Promise<DatosSincronizacion> {
  const [pendientes, rechazados, problemas, meta] = await Promise.all([
    consumosPendientesDeSync(userId),
    consumosRechazados(userId),
    mutacionesConProblema(userId),
    leerMetaSync(userId),
  ]);
  const idsConsumo = [...new Set(problemas.map((m) => m.consumo_id))];
  const afectados = await db.consumos.bulkGet(idsConsumo.map((id) => [userId, id]));
  const consumos = new Map<string, ConsumoLocal>();
  for (const consumo of [...pendientes, ...rechazados, ...afectados]) {
    if (consumo !== undefined) {
      consumos.set(consumo.id, consumo);
    }
  }
  const idsMaterial = [...new Set([...consumos.values()].map((c) => c.material_id))];
  const materiales = new Map<string, MaterialLocal>();
  for (const material of await db.materiales.bulkGet(idsMaterial.map((id) => [userId, id]))) {
    if (material !== undefined) {
      materiales.set(material.id, material);
    }
  }
  return {
    pendientes,
    // Los rechazos del SERVIDOR al sincronizar ya están en `problemas` (con código y mensaje).
    rechazadosPorJefe: rechazados.filter((c) => c.estado_local === 'rechazado'),
    problemas,
    consumos,
    materiales,
    ultimoSync: meta.ultimo_sync_at,
  };
}

function nombreMaterial(datos: DatosSincronizacion, consumo: ConsumoLocal): string {
  return datos.materiales.get(consumo.material_id)?.nombre ?? 'Material sin catálogo local';
}

function textoMotivoOmision(resumen: ResumenSync): string {
  switch (resumen.omitida) {
    case 'offline':
      return 'No hay conexión. Se sincronizará solo cuando vuelva la señal.';
    case 'requiere_contrasena':
    case 'sin_token':
      return 'Escriba de nuevo su contraseña (aviso de arriba) para poder enviar sus registros.';
    default:
      return 'No hay una sesión activa para sincronizar.';
  }
}

/** Pantalla "Estado de sincronización" (§8, comunes): qué falta enviar, qué se rechazó y por qué. */
export function EstadoSincronizacionPage() {
  const usuario = useSesion((estado) => estado.usuario);
  const requiereContrasena = useSesion((estado) => estado.requiere_contrasena);
  const estadoSync = useEstadoSync();
  const { sincronizarAhora } = useSincronizacion();
  const { mostrar } = useAvisos();
  const [pedida, setPedida] = useState(false);

  const userId = usuario?.id ?? null;
  const consulta = useCallback(
    () => (userId === null ? Promise.resolve(null) : leerDatos(userId)),
    [userId],
  );
  const { datos, cargando, error } = useConsultaLocal(consulta);

  const sincronizando = estadoSync.sincronizando || pedida;
  const sinConexion = estadoSync.conexion === 'sin_conexion';
  const motivoDeshabilitado = sinConexion
    ? 'Sin conexión: se sincronizará solo cuando vuelva la señal.'
    : requiereContrasena
      ? 'Escriba de nuevo su contraseña (aviso de arriba) para poder sincronizar.'
      : undefined;

  async function sincronizar() {
    setPedida(true);
    try {
      const resumen = await sincronizarAhora();
      if (!resumen.ejecutada) {
        mostrar({
          tono: 'advertencia',
          titulo: 'No se sincronizó',
          mensaje: textoMotivoOmision(resumen),
        });
      } else if (resumen.error !== null) {
        mostrar({
          tono: 'error',
          titulo: 'La sincronización no terminó',
          mensaje: `${mensajeErrorSync(resumen.error)} Sus registros siguen guardados en esta tablet.`,
        });
      } else {
        const problemas = resumen.rechazadas + resumen.conflictos;
        mostrar(
          problemas > 0
            ? {
                tono: 'advertencia',
                titulo: 'Sincronización completa con observaciones',
                mensaje: `${problemas === 1 ? '1 registro tiene' : `${problemas} registros tienen`} problemas: revíselos abajo.`,
              }
            : { tono: 'exito', titulo: 'Sincronización completa' },
        );
      }
    } catch {
      mostrar({
        tono: 'error',
        titulo: 'La sincronización no terminó',
        mensaje: 'Ocurrió un error inesperado. Sus registros siguen guardados en esta tablet.',
      });
    } finally {
      setPedida(false);
    }
  }

  const ultimoSync = estadoSync.ultimoSync ?? datos?.ultimoSync ?? null;
  const rechazados = datos?.problemas.filter((m) => m.estado === 'rechazada') ?? [];
  const conflictos = datos?.problemas.filter((m) => m.estado === 'conflicto') ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-ink-950">Estado de sincronización</h1>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-6">
          <Tarjeta titulo="Resumen" acento>
            <p className="cifras text-lg font-semibold text-ink-950">
              {textoIndicador(estadoSync)}
            </p>
            <dl className="cifras mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 text-base">
              <dt className="text-ink-700">Registros por enviar</dt>
              <dd className="text-right font-semibold text-ink-950">{estadoSync.pendientes}</dd>
              <dt className="text-ink-700">Fotos por subir</dt>
              <dd className="text-right font-semibold text-ink-950">
                {estadoSync.fotosPendientes}
              </dd>
              <dt className="text-ink-700">Rechazados</dt>
              <dd className="text-right font-semibold text-ink-950">{estadoSync.rechazados}</dd>
              <dt className="text-ink-700">Conflictos</dt>
              <dd className="text-right font-semibold text-ink-950">{estadoSync.conflictos}</dd>
              <dt className="text-ink-700">Última sincronización</dt>
              <dd className="text-right font-semibold text-ink-950">
                {ultimoSync ? formatearFechaHora(ultimoSync) : 'Todavía no'}
              </dd>
            </dl>
          </Tarjeta>

          {estadoSync.error && (
            <Aviso tono="error" titulo="La última sincronización falló">
              {mensajeErrorSync(estadoSync.error)}
              {estadoSync.error.code && (
                <span className="mt-1 block text-sm">Código: {estadoSync.error.code}</span>
              )}
            </Aviso>
          )}

          <Boton
            tamano="grande"
            anchoCompleto
            cargando={sincronizando}
            textoCargando="Sincronizando…"
            motivoDeshabilitado={sincronizando ? undefined : motivoDeshabilitado}
            onClick={() => void sincronizar()}
          >
            Sincronizar ahora
          </Boton>
        </div>

        <div className="flex flex-col gap-6">
          {error !== undefined && (
            <Aviso tono="error" titulo="No se pudieron leer los registros de esta tablet">
              Cierre y vuelva a abrir la aplicación. Sus registros no se han borrado.
            </Aviso>
          )}
          {cargando && (
            <p role="status" className="text-ink-500">
              Cargando registros…
            </p>
          )}
          {datos && (
            <>
              <Tarjeta
                titulo="Pendientes de enviar"
                acciones={
                  datos.pendientes.length > 0 ? (
                    <Chip estado="pendientes" cantidad={datos.pendientes.length} />
                  ) : undefined
                }
              >
                {datos.pendientes.length === 0 ? (
                  <EstadoVacio
                    titulo="No hay registros pendientes"
                    texto="Todos los consumos de esta tablet ya llegaron al servidor."
                  />
                ) : (
                  <ListaRegistros etiqueta="Pendientes de enviar">
                    {datos.pendientes.map((consumo) => (
                      <FilaRegistro
                        key={consumo.id}
                        material={nombreMaterial(datos, consumo)}
                        detalle={consumo.lote ? `Lote ${consumo.lote}` : undefined}
                        cantidad={consumo.cantidad}
                        unidad={consumo.unidad}
                        fechaHora={consumo.client_created_at}
                        estado={<Chip estado="pendiente_sync" />}
                      />
                    ))}
                  </ListaRegistros>
                )}
              </Tarjeta>

              <Tarjeta titulo="Rechazados">
                {rechazados.length === 0 && datos.rechazadosPorJefe.length === 0 ? (
                  <EstadoVacio titulo="No hay registros rechazados" />
                ) : (
                  <ul aria-label="Rechazados" className="flex flex-col gap-3">
                    {rechazados.map((mutacion) => (
                      <ItemProblema
                        key={mutacion.mutation_id}
                        titulo={NOMBRE_MUTACION[mutacion.tipo]}
                        consumo={datos.consumos.get(mutacion.consumo_id)}
                        datos={datos}
                        motivo={mensajeErrorSync(mutacion.error)}
                        codigo={mutacion.error?.code ?? null}
                        fecha={mutacion.client_created_at}
                      />
                    ))}
                    {datos.rechazadosPorJefe.map((consumo) => (
                      <ItemProblema
                        key={consumo.id}
                        titulo="Rechazado por el jefe"
                        consumo={consumo}
                        datos={datos}
                        motivo={consumo.motivo_rechazo ?? 'Sin motivo registrado.'}
                        codigo={null}
                        fecha={consumo.client_created_at}
                      />
                    ))}
                  </ul>
                )}
              </Tarjeta>

              <Tarjeta titulo="Conflictos">
                {conflictos.length === 0 ? (
                  <EstadoVacio titulo="No hay conflictos" />
                ) : (
                  <ul aria-label="Conflictos" className="flex flex-col gap-3">
                    {conflictos.map((mutacion) => (
                      <ItemProblema
                        key={mutacion.mutation_id}
                        titulo={NOMBRE_MUTACION[mutacion.tipo]}
                        consumo={datos.consumos.get(mutacion.consumo_id)}
                        datos={datos}
                        motivo={mensajeErrorSync(
                          mutacion.error ?? { code: 'CONFLICTO', message: '' },
                        )}
                        codigo={mutacion.error?.code ?? 'CONFLICTO'}
                        fecha={mutacion.client_created_at}
                      />
                    ))}
                  </ul>
                )}
              </Tarjeta>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface PropsItemProblema {
  titulo: string;
  consumo: ConsumoLocal | undefined;
  datos: DatosSincronizacion;
  motivo: string;
  codigo: string | null;
  fecha: string;
}

/** Registro rechazado o en conflicto, con su motivo en texto (no solo color). */
function ItemProblema({ titulo, consumo, datos, motivo, codigo, fecha }: PropsItemProblema) {
  return (
    <li className="rounded-lg border border-l-[6px] border-danger-700 bg-danger-50 p-4 text-ink-700">
      <p className="font-semibold text-ink-950">{titulo}</p>
      {consumo && (
        <p className="cifras text-[0.9375rem]">
          {nombreMaterial(datos, consumo)} · {formatearCantidad(consumo.cantidad)} {consumo.unidad}
          {consumo.lote ? ` · Lote ${consumo.lote}` : ''}
        </p>
      )}
      <p className="cifras text-[0.9375rem] text-ink-700">{formatearFechaHora(fecha)}</p>
      <p className="mt-2">
        <span className="font-semibold">Motivo:</span> {motivo}
      </p>
      {codigo && <p className="cifras mt-1 text-sm">Código: {codigo}</p>}
    </li>
  );
}

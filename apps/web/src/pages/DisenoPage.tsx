import { formatearCOP, formatearCantidad, parsearCantidad } from '@catmetal/shared';
import { useState, type ReactNode } from 'react';
import {
  AreaTexto,
  Aviso,
  Avatar,
  BarraSuperior,
  BloqueNovedad,
  Boton,
  Campo,
  Chip,
  DialogoConfirmacion,
  EstadoVacio,
  FilaRegistro,
  IconoCheck,
  IconoClip,
  Interruptor,
  LineaTiempo,
  ListaRegistros,
  PildoraConexion,
  SelectBuscable,
  SelectCorto,
  Tarjeta,
  VisorImagen,
  useAvisos,
  type EventoLinea,
  type OpcionBuscable,
} from '../components/ui';

/**
 * Página de muestra del sistema visual (ruta /diseno). Reúne los componentes base con datos de
 * ejemplo de fundición para revisión visual y pruebas. No toca datos reales ni la API.
 */

const MATERIALES: OpcionBuscable[] = [
  { valor: 'mp-001', etiqueta: 'Arena sílice', secundario: 'MP-001' },
  { valor: 'mp-002', etiqueta: 'Resina furánica', secundario: 'MP-002' },
  { valor: 'mp-003', etiqueta: 'Catalizador ácido', secundario: 'MP-003' },
  { valor: 'mp-004', etiqueta: 'Chatarra de acero', secundario: 'MP-004' },
  { valor: 'mp-005', etiqueta: 'Ferrosilicio 75 %', secundario: 'MP-005' },
  { valor: 'mp-006', etiqueta: 'Grafito', secundario: 'MP-006' },
  {
    valor: 'mp-007',
    etiqueta: 'Bentonita sódica',
    secundario: 'MP-007 · Agotado',
    deshabilitada: true,
  },
];

const UNIDADES = [
  { valor: 'kg', etiqueta: 'kg' },
  { valor: 'g', etiqueta: 'g' },
  { valor: 'l', etiqueta: 'l' },
  { valor: 'und', etiqueta: 'und' },
];

const TIPOS_NOVEDAD = [
  { valor: 'reproceso', etiqueta: 'Reproceso' },
  { valor: 'merma', etiqueta: 'Merma' },
  { valor: 'dano', etiqueta: 'Daño' },
  { valor: 'error_registro', etiqueta: 'Error de registro' },
  { valor: 'otro', etiqueta: 'Otro' },
];

/** Plan de arena sílice de la orden y tolerancia (5 %) para el ejemplo de novedad obligatoria. */
const PLAN_KG = 120;
const LIMITE_KG = PLAN_KG * 1.05;

// Instantes en UTC; en pantalla se ven en hora de Bogotá (UTC−5): 15:24Z → 10:24 a. m.
const TRAZA_DISPOSITIVO: EventoLinea[] = [
  {
    id: 't1',
    fechaHora: '2026-10-29T15:24:00Z',
    actor: 'Juan S.',
    descripcion: 'registró consumo + novedad',
    tipo: 'novedad',
  },
  {
    id: 't2',
    fechaHora: '2026-10-29T14:47:00Z',
    actor: 'Juan S.',
    descripcion: 'registró consumo (auto-sync)',
    tipo: 'registro',
  },
  {
    id: 't3',
    fechaHora: '2026-10-29T13:20:00Z',
    actor: 'Orden OP-2026-0587',
    descripcion: 'iniciada',
    tipo: 'sistema',
  },
];

const TRAZA_ORDEN: EventoLinea[] = [
  {
    id: 'o1',
    fechaHora: '2026-10-29T15:26:00Z',
    actor: 'Sistema',
    descripcion: 'Registro sincronizado desde la tablet (sin conexión → en línea).',
    tipo: 'sistema',
  },
  {
    id: 'o2',
    fechaHora: '2026-10-29T15:24:00Z',
    actor: 'Juan S.',
    rol: 'supervisor',
    descripcion: 'Registró 125,5 kg de arena sílice + novedad con evidencia.',
    tipo: 'novedad',
  },
  {
    id: 'o3',
    fechaHora: '2026-10-29T14:48:00Z',
    actor: 'Roberto M.',
    rol: 'jefe',
    descripcion: 'Validó el consumo de resina furánica.',
    tipo: 'validacion',
  },
  {
    id: 'o4',
    fechaHora: '2026-10-29T14:30:00Z',
    actor: 'Roberto M.',
    rol: 'jefe',
    descripcion: 'Rechazó el consumo de chatarra de acero: la cantidad no coincide con la báscula.',
    tipo: 'rechazo',
  },
  {
    id: 'o5',
    fechaHora: '2026-10-29T13:20:00Z',
    actor: 'Sistema',
    descripcion: 'Orden OP-2026-0587 iniciada por Roberto M.',
    tipo: 'sistema',
  },
];

/** Imagen de ejemplo para el visor, servida como URL `blob:` (igual que una evidencia offline). */
const SVG_EVIDENCIA = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="#333"/><circle cx="600" cy="400" r="220" fill="#69727d"/><circle cx="600" cy="400" r="120" fill="#c9ced4"/><text x="600" y="740" fill="#fff" font-family="sans-serif" font-size="40" text-anchor="middle">Evidencia de ejemplo · sellado lote 4471</text></svg>`;

function crearUrlEvidencia(): string {
  const respaldo = 'data:image/svg+xml,' + encodeURIComponent(SVG_EVIDENCIA);
  // En el navegador siempre existe; en jsdom/Vitest puede faltar o fallar con su Blob.
  if (typeof URL.createObjectURL !== 'function') {
    return respaldo;
  }
  try {
    return URL.createObjectURL(new Blob([SVG_EVIDENCIA], { type: 'image/svg+xml' }));
  } catch {
    return respaldo;
  }
}

function Seccion({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div>
        <h2 id={id} className="text-sm font-bold tracking-wide text-ink-950 uppercase">
          {titulo}
        </h2>
        <span aria-hidden="true" className="mt-2 block h-[3px] w-12 bg-brand-600" />
      </div>
      {children}
    </section>
  );
}

export function DisenoPage() {
  const avisos = useAvisos();

  // Formulario del supervisor
  const [material, setMaterial] = useState<string | null>('mp-001');
  const [cantidad, setCantidad] = useState('125,5');
  const [unidad, setUnidad] = useState('kg');
  const [lote, setLote] = useState('4471');
  const [novedadElegida, setNovedadElegida] = useState(false);
  const [tipoNovedad, setTipoNovedad] = useState('reproceso');
  const [justificacion, setJustificacion] = useState(
    'Se usaron 5,5 kg adicionales por reproceso de sellado defectuoso en el lote anterior.',
  );
  const [guardando, setGuardando] = useState(false);

  const cantidadNumero = parsearCantidad(cantidad);
  const errorCantidad =
    cantidad.trim() !== '' && cantidadNumero === null
      ? 'Escriba una cantidad válida, con hasta 3 decimales (p. ej. 125,5).'
      : undefined;
  const superaTolerancia = cantidadNumero !== null && unidad === 'kg' && cantidadNumero > LIMITE_KG;
  const novedadActiva = superaTolerancia || novedadElegida;

  // Validación del jefe
  const [dialogo, setDialogo] = useState<'validar' | 'rechazar' | null>(null);
  const [urlEvidencia, setUrlEvidencia] = useState<string | null>(null);
  const [interruptorDemo, setInterruptorDemo] = useState(true);

  function abrirEvidencia() {
    setUrlEvidencia(crearUrlEvidencia());
  }

  function cerrarEvidencia() {
    if (urlEvidencia?.startsWith('blob:')) {
      URL.revokeObjectURL(urlEvidencia);
    }
    setUrlEvidencia(null);
  }

  function guardar() {
    setGuardando(true);
    window.setTimeout(() => {
      setGuardando(false);
      avisos.mostrar({
        tono: 'exito',
        titulo: 'Registro guardado en el dispositivo',
        mensaje: 'Se sincroniza al recuperar señal.',
      });
    }, 900);
  }

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-bold text-ink-950">Sistema visual · Componentes base</h1>
        <span aria-hidden="true" className="mt-3 block h-[3px] w-16 bg-brand-600" />
        <p className="mt-4 max-w-prose text-ink-700">
          Muestra de los componentes con datos de ejemplo de fundición. Revísela en una tablet en
          horizontal (1180 × 820) y en vertical.
        </p>
      </div>

      <Seccion id="sec-barra" titulo="Barra superior y conexión">
        <div className="overflow-hidden rounded-xl border border-line-200">
          <BarraSuperior
            titulo="Registro de Consumo"
            subtitulo="Orden OP-2026-0587 · Línea Moldeo 1"
            conexion={<PildoraConexion estado="sin_conexion" pendientes={3} />}
            usuario={<Avatar nombre="Juan Suárez" rol="supervisor" />}
          />
        </div>
        <div className="overflow-hidden rounded-xl border border-line-200">
          <BarraSuperior
            titulo="Validación de Consumos"
            subtitulo="Panel del jefe · Rol: Aprobador"
            conexion={<PildoraConexion estado="en_linea" pendientes={0} />}
            usuario={<Avatar nombre="Roberto Martínez" rol="jefe" />}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-ink-950 p-4">
          <PildoraConexion estado="sincronizando" pendientes={2} />
          <PildoraConexion
            estado="sin_conexion"
            pendientes={1}
            alPresionar={() =>
              avisos.mostrar({ titulo: 'Estado de sincronización', mensaje: '1 registro en cola.' })
            }
          />
        </div>
      </Seccion>

      <Seccion id="sec-supervisor" titulo="Supervisor · Registro de consumo">
        <div className="grid gap-6 lg:grid-cols-2">
          <Tarjeta
            titulo="Nuevo registro de material"
            pie={
              <Boton
                tamano="grande"
                anchoCompleto
                cargando={guardando}
                textoCargando="Guardando registro"
                onClick={guardar}
              >
                Guardar registro (se sincroniza al recuperar señal)
              </Boton>
            }
          >
            <div className="flex flex-col gap-5">
              <SelectBuscable
                etiqueta="Materia prima"
                opciones={MATERIALES}
                valor={material}
                alCambiar={(valor) => setMaterial(valor)}
                requerido
              />
              <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-4">
                <Campo
                  etiqueta="Cantidad utilizada"
                  numerico
                  requerido
                  value={cantidad}
                  onChange={(evento) => setCantidad(evento.target.value)}
                  error={errorCantidad}
                  ayuda={`Plan: ${formatearCantidad(PLAN_KG)} kg · tolerancia 5 %`}
                />
                <SelectCorto
                  etiqueta="Unidad"
                  opciones={UNIDADES}
                  value={unidad}
                  onChange={(evento) => setUnidad(evento.target.value)}
                />
              </div>
              <Campo
                etiqueta="Lote"
                requerido
                value={lote}
                onChange={(evento) => setLote(evento.target.value)}
              />
              <BloqueNovedad
                titulo={
                  <Interruptor
                    etiqueta="¿Hay una novedad en este consumo?"
                    activado={novedadActiva}
                    alCambiar={setNovedadElegida}
                    bloqueado={superaTolerancia}
                    motivoBloqueo={`El consumo supera el plan más la tolerancia (${formatearCantidad(LIMITE_KG)} kg): la novedad es obligatoria.`}
                  />
                }
              >
                {novedadActiva && (
                  <>
                    <SelectCorto
                      etiqueta="Tipo de novedad"
                      opciones={TIPOS_NOVEDAD}
                      value={tipoNovedad}
                      onChange={(evento) => setTipoNovedad(evento.target.value)}
                    />
                    <AreaTexto
                      etiqueta="Justificación"
                      requerido
                      maxLength={500}
                      mostrarContador
                      value={justificacion}
                      onChange={(evento) => setJustificacion(evento.target.value)}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <Boton variante="secundario" icono={<IconoClip className="size-5" />}>
                        Adjuntar evidencia
                      </Boton>
                      <span className="text-sm font-medium text-ink-700">1 foto adjunta</span>
                    </div>
                  </>
                )}
              </BloqueNovedad>
            </div>
          </Tarjeta>

          <div className="flex flex-col gap-6">
            <Tarjeta titulo="Registros de hoy — Orden OP-2026-0587">
              <ListaRegistros etiqueta="Registros de hoy">
                <FilaRegistro
                  material="Arena sílice"
                  detalle="MP-001 · Lote 4471"
                  cantidad={125.5}
                  unidad="kg"
                  fechaHora="2026-10-29T15:24:00Z"
                  conNovedad
                  estado={<Chip estado="pendiente_sync" />}
                />
                <FilaRegistro
                  material="Resina furánica"
                  cantidad={3.2}
                  unidad="kg"
                  fechaHora="2026-10-29T14:47:00Z"
                  estado={<Chip estado="sincronizado" />}
                />
                <FilaRegistro
                  material="Catalizador ácido"
                  cantidad={0.85}
                  unidad="l"
                  fechaHora="2026-10-29T14:10:00Z"
                  estado={<Chip estado="validado" />}
                />
                <FilaRegistro
                  material="Chatarra de acero"
                  cantidad={1250}
                  unidad="kg"
                  fechaHora="2026-10-29T13:52:00Z"
                  estado={<Chip estado="rechazado" />}
                  alPresionar={() =>
                    avisos.mostrar({
                      tono: 'error',
                      titulo: 'Rechazado por Roberto M.',
                      mensaje:
                        'Motivo: la cantidad no coincide con la báscula. Cree una corrección.',
                    })
                  }
                />
                <FilaRegistro
                  material="Ferrosilicio 75 %"
                  cantidad={18}
                  unidad="kg"
                  fechaHora="2026-10-29T13:40:00Z"
                  estado={<Chip estado="falta_novedad" />}
                />
              </ListaRegistros>
            </Tarjeta>
            <Tarjeta titulo="Trazabilidad — este dispositivo">
              <LineaTiempo
                etiqueta="Trazabilidad de este dispositivo"
                eventos={TRAZA_DISPOSITIVO}
                variante="compacta"
              />
            </Tarjeta>
          </div>
        </div>
      </Seccion>

      <Seccion id="sec-jefe" titulo="Jefe · Validación de consumos">
        <div className="grid gap-6 lg:grid-cols-2">
          <Tarjeta
            titulo="Por validar — Orden OP-2026-0587"
            acciones={<Chip estado="pendientes" cantidad={3} />}
          >
            <ul aria-label="Consumos por validar" className="flex flex-col gap-4">
              <li className="rounded-lg border-2 border-brand-600 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink-950">Arena sílice</p>
                    <p className="cifras text-[0.9375rem] text-ink-700">
                      125,5 kg · Juan S. · 10:24 a. m.
                    </p>
                  </div>
                  <Chip estado="con_novedad" />
                </div>
                <BloqueNovedad titulo="Justificación del supervisor:" className="mt-3">
                  <p className="text-base">
                    Se usaron 5,5 kg adicionales por reproceso de sellado defectuoso en el lote
                    anterior.
                  </p>
                  <div>
                    <Boton
                      variante="fantasma"
                      icono={<IconoClip className="size-5" />}
                      className="-ml-3 underline"
                      onClick={abrirEvidencia}
                    >
                      evidencia_sellado_4471.jpg
                    </Boton>
                  </div>
                </BloqueNovedad>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Boton
                    variante="exito"
                    icono={<IconoCheck className="size-5" />}
                    onClick={() => setDialogo('validar')}
                  >
                    Validar gasto
                  </Boton>
                  <Boton variante="peligro" onClick={() => setDialogo('rechazar')}>
                    Rechazar
                  </Boton>
                </div>
              </li>
              <li className="rounded-lg border border-line-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink-950">Ferrosilicio 75 %</p>
                    <p className="cifras text-[0.9375rem] text-ink-700">
                      18 kg · Juan S. · 8:40 a. m.
                    </p>
                  </div>
                  <Chip estado="falta_novedad" />
                </div>
                <div className="mt-4 flex flex-wrap items-start gap-3">
                  <Boton
                    variante="exito"
                    icono={<IconoCheck className="size-5" />}
                    motivoDeshabilitado="Supera la tolerancia y el supervisor aún no registra la novedad."
                  >
                    Validar gasto
                  </Boton>
                  <Boton variante="peligro" onClick={() => setDialogo('rechazar')}>
                    Rechazar
                  </Boton>
                </div>
              </li>
            </ul>
          </Tarjeta>

          <div className="flex flex-col gap-6">
            <Tarjeta titulo="Resumen de la orden">
              <dl className="cifras grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 text-[0.9375rem]">
                <dt className="text-ink-700">Materiales consumidos</dt>
                <dd className="text-right font-semibold text-ink-950">5 registros</dd>
                <dt className="text-ink-700">Costo total reportado</dt>
                <dd className="text-right font-semibold whitespace-nowrap text-ink-950">
                  {formatearCOP(4182300)}
                </dd>
                <dt className="text-ink-700">Novedades abiertas</dt>
                <dd className="text-right font-semibold text-warning-800">1 por sustentar</dd>
                <dt className="text-ink-700">Estado de la orden</dt>
                <dd className="text-right font-semibold text-ink-950">En proceso</dd>
              </dl>
            </Tarjeta>
            <Tarjeta titulo="Trazabilidad completa de la orden">
              <LineaTiempo etiqueta="Trazabilidad completa de la orden" eventos={TRAZA_ORDEN} />
            </Tarjeta>
          </div>
        </div>
      </Seccion>

      <Seccion id="sec-catalogo" titulo="Catálogo">
        <div className="grid gap-6 lg:grid-cols-2">
          <Tarjeta titulo="Botones" acento>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-3">
                <Boton>Primario</Boton>
                <Boton variante="exito">Éxito</Boton>
                <Boton variante="peligro">Peligro</Boton>
                <Boton variante="peligroRelleno">Peligro relleno</Boton>
                <Boton variante="secundario">Secundario</Boton>
                <Boton variante="fantasma">Fantasma</Boton>
              </div>
              <div className="flex flex-wrap gap-3">
                <Boton tamano="grande">Grande (56 px)</Boton>
                <Boton cargando textoCargando="Sincronizando">
                  Sincronizar ahora
                </Boton>
                <Boton disabled>Deshabilitado</Boton>
              </div>
            </div>
          </Tarjeta>

          <Tarjeta titulo="Chips de estado" acento>
            <div className="flex flex-wrap items-center gap-2">
              <Chip estado="pendiente_sync" />
              <Chip estado="sincronizado" />
              <Chip estado="validado" />
              <Chip estado="rechazado" />
              <Chip estado="falta_novedad" />
              <Chip estado="con_novedad" />
              <Chip estado="pendientes" cantidad={3} />
              <Chip
                estado="rechazado"
                textoAccion="ver motivo"
                alPresionar={() =>
                  avisos.mostrar({
                    tono: 'error',
                    titulo: 'Motivo del rechazo',
                    mensaje: 'La cantidad no coincide con la báscula.',
                  })
                }
              />
            </div>
          </Tarjeta>

          <Tarjeta titulo="Avisos" acento>
            <div className="flex flex-col gap-3">
              <Aviso tono="info" titulo="Hay una versión nueva">
                Se instalará al cerrar la sesión.
              </Aviso>
              <Aviso tono="exito" titulo="Todo sincronizado" />
              <Aviso tono="advertencia" titulo="3 registros sin sincronizar">
                Se envían al recuperar señal.
              </Aviso>
              <Aviso tono="error" titulo="No se pudo sincronizar" alCerrar={() => undefined}>
                Revise la conexión e intente de nuevo.
              </Aviso>
              <div className="flex flex-wrap gap-3">
                <Boton
                  variante="secundario"
                  onClick={() => avisos.mostrar({ tono: 'exito', titulo: 'Consumo validado' })}
                >
                  Mostrar toast de éxito
                </Boton>
                <Boton
                  variante="secundario"
                  onClick={() =>
                    avisos.mostrar({
                      tono: 'error',
                      titulo: 'Operación rechazada por el servidor',
                      mensaje: 'Su usuario ya no está asignado a la orden.',
                    })
                  }
                >
                  Mostrar toast de error
                </Boton>
              </div>
            </div>
          </Tarjeta>

          <Tarjeta titulo="Interruptor y estado vacío" acento>
            <div className="flex flex-col gap-5">
              <Interruptor
                etiqueta="Mostrar solo con novedad"
                activado={interruptorDemo}
                alCambiar={setInterruptorDemo}
                ayuda="Filtra la cola de validación."
              />
              <Interruptor
                etiqueta="Novedad obligatoria"
                activado
                alCambiar={() => undefined}
                bloqueado
                motivoBloqueo="El consumo supera la tolerancia de la orden."
              />
              <EstadoVacio
                titulo="No hay consumos por validar"
                texto="Cuando un supervisor registre un consumo en esta orden, aparecerá aquí."
                accion={<Boton variante="secundario">Ver otras órdenes</Boton>}
              />
            </div>
          </Tarjeta>
        </div>
      </Seccion>

      <DialogoConfirmacion
        abierto={dialogo === 'validar'}
        titulo="¿Validar este gasto?"
        descripcion="Arena sílice · 125,5 kg. La validación queda registrada en la auditoría y no se puede deshacer."
        textoConfirmar="Validar gasto"
        tono="exito"
        alCancelar={() => setDialogo(null)}
        alConfirmar={() => {
          setDialogo(null);
          avisos.mostrar({ tono: 'exito', titulo: 'Consumo validado' });
        }}
      />
      <DialogoConfirmacion
        abierto={dialogo === 'rechazar'}
        titulo="Rechazar consumo"
        descripcion="El supervisor verá el motivo y podrá crear una corrección."
        textoConfirmar="Rechazar"
        tono="peligro"
        motivo={{
          etiqueta: 'Motivo del rechazo',
          ayuda: 'Entre 3 y 500 caracteres.',
          placeholder: 'Ej.: la cantidad no coincide con la báscula',
        }}
        alCancelar={() => setDialogo(null)}
        alConfirmar={(motivo) => {
          setDialogo(null);
          avisos.mostrar({
            tono: 'info',
            titulo: 'Consumo rechazado',
            mensaje: `Motivo: ${motivo ?? ''}`,
          });
        }}
      />
      <VisorImagen
        abierto={urlEvidencia !== null}
        src={urlEvidencia ?? ''}
        alt="Foto de evidencia del sellado defectuoso del lote 4471"
        titulo="evidencia_sellado_4471.jpg"
        alCerrar={cerrarEvidencia}
      />
    </div>
  );
}

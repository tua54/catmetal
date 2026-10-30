import {
  diaBogota,
  formatearCantidad,
  formatearFechaHora,
  formatearHora,
  type ElementoCola,
} from '@catmetal/shared';
import {
  BloqueNovedad,
  Boton,
  Chip,
  IconoCheck,
  IconoClip,
  IconoGiro,
  IconoReloj,
  Tarjeta,
} from '../../components/ui';
import { nombreCorto } from '../../datos';
import { ETIQUETAS_TIPO_NOVEDAD } from '../consumos/reglas';

/** Motivos por los que "Validar gasto" queda deshabilitado (Figma + S9). */
export const MOTIVO_FALTA_NOVEDAD =
  'Falta la justificación de la novedad: el supervisor debe registrarla';
export const MOTIVO_PROPIO = 'Registrado por usted: requiere otro jefe';

export interface PropsTarjetaConsumo {
  elemento: ElementoCola;
  seleccionada: boolean;
  alSeleccionar: () => void;
  /** Decisión guardada en esta tablet y aún sin confirmar por el servidor. */
  decisionLocal?: 'aprobado' | 'rechazado';
  /** Hay una decisión en curso para este consumo. */
  ocupada: boolean;
  alValidar: () => void;
  alRechazar: () => void;
  alAbrirEvidencia: (evidencia: { id: string; titulo: string; alt: string }) => void;
  cargandoEvidenciaId: string | null;
  ahora?: Date;
}

const EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** "10:24 a. m." si es de hoy (Bogotá); si no, con la fecha. */
function momento(iso: string, ahora: Date): string {
  return diaBogota(iso) === diaBogota(ahora.toISOString())
    ? formatearHora(iso)
    : formatearFechaHora(iso);
}

/** Etiqueta neutra "Registro tardío" (llegó al servidor mucho después de registrarse). */
function EtiquetaTardio() {
  return (
    <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-ink-400 bg-surface-200 px-3 py-1 text-sm font-semibold whitespace-nowrap text-ink-700">
      <IconoReloj className="size-4 shrink-0" />
      <span>Registro tardío</span>
    </span>
  );
}

/** Tarjeta de un consumo por validar (Figma "Jefe · Validación de Consumos", columna izquierda). */
export function TarjetaConsumo({
  elemento,
  seleccionada,
  alSeleccionar,
  decisionLocal,
  ocupada,
  alValidar,
  alRechazar,
  alAbrirEvidencia,
  cargandoEvidenciaId,
  ahora = new Date(),
}: PropsTarjetaConsumo) {
  const material = elemento.material.nombre;
  const conNovedad = elemento.novedades.length > 0;
  const motivoValidar = elemento.propio
    ? MOTIVO_PROPIO
    : elemento.falta_novedad
      ? MOTIVO_FALTA_NOVEDAD
      : undefined;
  // Numeración de las fotos del consumo (todas sus novedades): "evidencia_1.jpg", "evidencia_2.jpg"…
  const numeroDe = new Map(
    elemento.novedades.flatMap((n) => n.evidencias).map((e, indice) => [e.id, indice + 1]),
  );

  return (
    <Tarjeta
      nivelTitulo={3}
      resaltada={seleccionada}
      titulo={
        <button
          type="button"
          aria-pressed={seleccionada}
          onClick={alSeleccionar}
          className="-mx-1 min-h-11 rounded-md px-1 text-left"
        >
          {material}
          {elemento.material.codigo !== '' && (
            <span className="cifras ml-2 text-base font-normal text-ink-500">
              {elemento.material.codigo}
            </span>
          )}
        </button>
      }
      acciones={
        <div className="flex flex-wrap justify-end gap-2">
          {decisionLocal !== undefined && <Chip estado="pendiente_sync" />}
          {elemento.falta_novedad && <Chip estado="falta_novedad" />}
          {conNovedad && <Chip estado="con_novedad" />}
          {elemento.registro_tardio && <EtiquetaTardio />}
        </div>
      }
    >
      <div className="-mt-3 flex flex-col gap-4">
        <p className="cifras text-[0.9375rem] text-ink-700">
          <span className="font-semibold text-ink-950">
            {formatearCantidad(elemento.cantidad)} {elemento.unidad}
          </span>
          {' · '}Lote {elemento.lote}
          {' · '}
          {nombreCorto(elemento.supervisor.nombre)}
          {' · '}
          <time dateTime={elemento.client_created_at}>
            {momento(elemento.client_created_at, ahora)}
          </time>
          {' · '}Orden {elemento.orden.codigo}
        </p>
        {elemento.corrige_a !== null && (
          <p className="text-[0.9375rem] text-ink-700">
            Corrección de un consumo rechazado anteriormente.
          </p>
        )}

        {elemento.novedades.map((novedad) => (
          <BloqueNovedad key={novedad.id} titulo="Justificación del supervisor:">
            <p className="font-normal">
              <span className="font-semibold">{ETIQUETAS_TIPO_NOVEDAD[novedad.tipo]}:</span>{' '}
              {novedad.descripcion}
            </p>
            {novedad.evidencias.length > 0 && (
              <ul aria-label="Evidencias" className="flex flex-wrap gap-2">
                {novedad.evidencias.map((evidencia) => {
                  const numeroEvidencia = numeroDe.get(evidencia.id) ?? 1;
                  const nombre = `evidencia_${numeroEvidencia}.${EXTENSION[evidencia.mime] ?? 'jpg'}`;
                  const alt = `Evidencia ${numeroEvidencia} de ${material}: ${novedad.descripcion}`;
                  const cargando = cargandoEvidenciaId === evidencia.id;
                  return (
                    <li key={evidencia.id}>
                      {evidencia.subido ? (
                        <button
                          type="button"
                          aria-busy={cargando || undefined}
                          onClick={() =>
                            alAbrirEvidencia({ id: evidencia.id, titulo: nombre, alt })
                          }
                          className="inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-semibold text-brand-600 underline underline-offset-4"
                        >
                          {cargando ? (
                            <IconoGiro className="size-5 shrink-0 motion-safe:animate-spin" />
                          ) : (
                            <IconoClip className="size-5 shrink-0" />
                          )}
                          <span>{nombre}</span>
                          <span className="sr-only">
                            {cargando ? ' (descargando…)' : ' (abrir evidencia)'}
                          </span>
                        </button>
                      ) : (
                        <span className="inline-flex min-h-11 items-center gap-2 text-[0.9375rem] text-ink-700">
                          <IconoClip className="size-5 shrink-0" />
                          {nombre}: la foto aún no se ha subido desde la tablet del supervisor.
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </BloqueNovedad>
        ))}

        {decisionLocal !== undefined ? (
          <p className="text-[0.9375rem] font-semibold text-warning-800">
            {decisionLocal === 'aprobado' ? 'Validado' : 'Rechazado'} en esta tablet: se enviará al
            servidor cuando vuelva la conexión.
          </p>
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            <Boton
              variante="exito"
              icono={<IconoCheck className="size-5 shrink-0" />}
              motivoDeshabilitado={motivoValidar}
              cargando={ocupada && motivoValidar === undefined}
              textoCargando="Guardando decisión…"
              aria-label={`Validar gasto de ${material}`}
              onClick={alValidar}
            >
              Validar gasto
            </Boton>
            <Boton
              variante="peligro"
              motivoDeshabilitado={elemento.propio ? 'Solo otro jefe puede rechazarlo' : undefined}
              disabled={ocupada}
              aria-label={`Rechazar ${material}`}
              onClick={alRechazar}
            >
              Rechazar
            </Boton>
          </div>
        )}
      </div>
    </Tarjeta>
  );
}

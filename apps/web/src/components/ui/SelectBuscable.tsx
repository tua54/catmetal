import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { clasesControl, cx, normalizarBusqueda, unirIds } from './clases';
import { EnvolturaCampo } from './EnvolturaCampo';
import { IconoCheck, IconoChevronAbajo } from './iconos';

export interface OpcionBuscable {
  valor: string;
  /** Texto principal, p. ej. "Resina furánica". */
  etiqueta: string;
  /** Texto secundario, p. ej. el código "MP-002" o el lote. También se busca en él. */
  secundario?: string;
  deshabilitada?: boolean;
}

export interface PropsSelectBuscable {
  etiqueta: ReactNode;
  opciones: readonly OpcionBuscable[];
  /** Valor seleccionado (`null` = sin selección). Componente controlado. */
  valor: string | null;
  alCambiar: (valor: string, opcion: OpcionBuscable) => void;
  ayuda?: ReactNode;
  error?: ReactNode;
  requerido?: boolean;
  deshabilitado?: boolean;
  placeholder?: string;
  textoSinResultados?: string;
  /** Si se pasa, agrega un `<input type="hidden">` con el valor para formularios nativos. */
  name?: string;
  id?: string;
  etiquetaOculta?: boolean;
  className?: string;
  /** Se llama al perder el foco (útil para `onBlur` de react-hook-form). */
  alSalir?: () => void;
}

/** Texto que muestra el campo con una opción elegida: "Resina furánica — MP-002". */
function textoOpcion(opcion: OpcionBuscable): string {
  return opcion.secundario ? `${opcion.etiqueta} — ${opcion.secundario}` : opcion.etiqueta;
}

/**
 * Select con buscador: patrón ARIA "combobox" editable con autocompletado de lista
 * (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/). El foco DOM se queda en el campo y la
 * opción activa se comunica con `aria-activedescendant`.
 *
 * Teclado: ↓/↑ abren y recorren (con vuelta), Enter elige, Escape cierra y restaura el texto,
 * Tab sale sin cambiar la selección. Táctil: tocar el campo o el chevron abre la lista; las
 * opciones miden ≥ 48 px. Busca sin distinguir tildes ni mayúsculas, en el texto y en el secundario.
 */
export function SelectBuscable({
  etiqueta,
  opciones,
  valor,
  alCambiar,
  ayuda,
  error,
  requerido,
  deshabilitado = false,
  placeholder = 'Escriba para buscar…',
  textoSinResultados = 'No hay coincidencias.',
  name,
  id,
  etiquetaOculta,
  className,
  alSalir,
}: PropsSelectBuscable) {
  const idGenerado = useId();
  const idControl = id ?? `combo-${idGenerado}`;
  const idEtiqueta = `${idControl}-etiqueta`;
  const idLista = `${idControl}-lista`;
  const idAyuda = `${idControl}-ayuda`;
  const idError = `${idControl}-error`;
  const idOpcion = (indice: number) => `${idControl}-opcion-${indice}`;

  const refCampo = useRef<HTMLInputElement>(null);
  const refLista = useRef<HTMLUListElement>(null);
  const [abierto, setAbierto] = useState(false);
  /** Texto escrito por el usuario; `null` = mostrar la opción seleccionada. */
  const [consulta, setConsulta] = useState<string | null>(null);
  const [activo, setActivo] = useState(-1);

  const seleccionada = opciones.find((opcion) => opcion.valor === valor) ?? null;
  const textoCampo = consulta ?? (seleccionada ? textoOpcion(seleccionada) : '');

  const filtradas = useMemo(() => {
    const termino = normalizarBusqueda(consulta ?? '');
    if (termino === '') {
      return opciones;
    }
    return opciones.filter((opcion) =>
      normalizarBusqueda(`${opcion.etiqueta} ${opcion.secundario ?? ''}`).includes(termino),
    );
  }, [opciones, consulta]);

  const listaVisible = abierto && filtradas.length > 0;
  const sinResultados = abierto && filtradas.length === 0;

  useEffect(() => {
    if (!listaVisible || activo < 0) {
      return;
    }
    const elemento = refLista.current?.querySelector<HTMLElement>(`[data-indice="${activo}"]`);
    // jsdom no implementa scrollIntoView; en navegadores siempre existe.
    if (elemento && typeof elemento.scrollIntoView === 'function') {
      elemento.scrollIntoView({ block: 'nearest' });
    }
  }, [activo, listaVisible]);

  function siguienteHabilitada(desde: number, paso: 1 | -1): number {
    const total = filtradas.length;
    for (let i = 1; i <= total; i++) {
      const indice = (((desde + paso * i) % total) + total) % total;
      if (!filtradas[indice]?.deshabilitada) {
        return indice;
      }
    }
    return -1;
  }

  function abrir(posicion: 'seleccionada' | 'primera' | 'ultima') {
    setAbierto(true);
    const indiceSeleccionada = filtradas.findIndex((opcion) => opcion.valor === valor);
    if (posicion === 'seleccionada' && indiceSeleccionada >= 0) {
      setActivo(indiceSeleccionada);
    } else if (posicion === 'ultima') {
      setActivo(siguienteHabilitada(0, -1));
    } else {
      setActivo(siguienteHabilitada(-1, 1));
    }
  }

  function cerrar() {
    setAbierto(false);
    setConsulta(null);
    setActivo(-1);
  }

  function elegir(opcion: OpcionBuscable | undefined) {
    if (!opcion || opcion.deshabilitada) {
      return;
    }
    alCambiar(opcion.valor, opcion);
    cerrar();
  }

  function manejarCambio(evento: ChangeEvent<HTMLInputElement>) {
    const texto = evento.target.value;
    setConsulta(texto);
    setAbierto(true);
    const termino = normalizarBusqueda(texto);
    // Selección automática: la primera coincidencia queda activa para elegirla con Enter.
    const primera =
      termino === ''
        ? -1
        : opciones
            .filter((opcion) =>
              normalizarBusqueda(`${opcion.etiqueta} ${opcion.secundario ?? ''}`).includes(termino),
            )
            .findIndex((opcion) => !opcion.deshabilitada);
    setActivo(primera);
  }

  function manejarTecla(evento: KeyboardEvent<HTMLInputElement>) {
    switch (evento.key) {
      case 'ArrowDown':
        evento.preventDefault();
        if (!abierto) {
          abrir('seleccionada');
        } else {
          setActivo((actual) => siguienteHabilitada(actual, 1));
        }
        break;
      case 'ArrowUp':
        evento.preventDefault();
        if (!abierto) {
          abrir('ultima');
        } else {
          setActivo((actual) => siguienteHabilitada(actual < 0 ? 0 : actual, -1));
        }
        break;
      case 'Enter':
        if (abierto) {
          // Evita enviar el formulario mientras la lista está abierta.
          evento.preventDefault();
          if (activo >= 0) {
            elegir(filtradas[activo]);
          }
        }
        break;
      case 'Escape':
        if (abierto || consulta !== null) {
          // No deja que el Escape cierre también un diálogo contenedor.
          evento.preventDefault();
          evento.stopPropagation();
          cerrar();
        }
        break;
      case 'Tab':
        cerrar();
        break;
      default:
        break;
    }
  }

  return (
    <EnvolturaCampo
      idControl={idControl}
      idAyuda={idAyuda}
      idError={idError}
      idEtiqueta={idEtiqueta}
      etiqueta={etiqueta}
      ayuda={ayuda}
      error={error}
      requerido={requerido}
      etiquetaOculta={etiquetaOculta}
      className={className}
    >
      <div className="relative">
        <input
          ref={refCampo}
          id={idControl}
          type="text"
          role="combobox"
          aria-expanded={listaVisible}
          aria-controls={idLista}
          aria-autocomplete="list"
          aria-activedescendant={listaVisible && activo >= 0 ? idOpcion(activo) : undefined}
          aria-required={requerido ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={unirIds(ayuda && idAyuda, error && idError)}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={deshabilitado}
          placeholder={placeholder}
          value={textoCampo}
          onChange={manejarCambio}
          onKeyDown={manejarTecla}
          onClick={() => {
            if (!abierto) {
              abrir('seleccionada');
            }
          }}
          onFocus={(evento) => {
            // Al enfocar se selecciona el texto: escribir reemplaza la opción mostrada.
            evento.currentTarget.select();
          }}
          onBlur={() => {
            cerrar();
            alSalir?.();
          }}
          className={cx(clasesControl(Boolean(error)), 'min-h-12 py-2 pr-14')}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Mostrar opciones"
          aria-controls={idLista}
          aria-expanded={listaVisible}
          disabled={deshabilitado}
          // Evita que el campo pierda el foco al tocar el botón.
          onMouseDown={(evento) => evento.preventDefault()}
          onClick={() => {
            if (abierto) {
              cerrar();
            } else {
              abrir('seleccionada');
            }
            refCampo.current?.focus();
          }}
          className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-ink-700 disabled:text-ink-500"
        >
          <IconoChevronAbajo
            className={cx('size-5 transition-transform', listaVisible && 'rotate-180')}
          />
        </button>

        <ul
          ref={refLista}
          id={idLista}
          role="listbox"
          aria-labelledby={idEtiqueta}
          hidden={!listaVisible}
          // El foco se queda en el campo mientras se toca una opción.
          onMouseDown={(evento) => evento.preventDefault()}
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-ink-400 bg-white py-1 shadow-lg"
        >
          {filtradas.map((opcion, indice) => {
            const esActiva = indice === activo;
            const esSeleccionada = opcion.valor === valor;
            return (
              <li
                key={opcion.valor}
                id={idOpcion(indice)}
                data-indice={indice}
                role="option"
                aria-selected={esSeleccionada}
                aria-disabled={opcion.deshabilitada ? true : undefined}
                onClick={() => elegir(opcion)}
                className={cx(
                  'flex min-h-12 cursor-pointer items-center gap-3 border-l-4 px-3 py-2',
                  esActiva ? 'border-brand-600 bg-brand-100' : 'border-transparent',
                  opcion.deshabilitada && 'cursor-not-allowed opacity-60',
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cx(
                      'text-base text-ink-950',
                      esSeleccionada ? 'font-semibold' : 'font-medium',
                    )}
                  >
                    {opcion.etiqueta}
                  </span>
                  {opcion.secundario && (
                    <span className="cifras text-sm text-ink-700">{opcion.secundario}</span>
                  )}
                </span>
                {esSeleccionada && <IconoCheck className="size-5 shrink-0 text-brand-600" />}
              </li>
            );
          })}
        </ul>

        {/* Región viva persistente: anuncia cuando la búsqueda no encuentra nada. */}
        <p
          role="status"
          className={
            sinResultados
              ? 'absolute top-full right-0 left-0 z-30 mt-1 rounded-lg border border-ink-400 bg-white px-4 py-3 text-base text-ink-700 shadow-lg'
              : 'sr-only'
          }
        >
          {sinResultados ? textoSinResultados : ''}
        </p>
      </div>
      {name !== undefined && <input type="hidden" name={name} value={valor ?? ''} />}
    </EnvolturaCampo>
  );
}

import { cx, iniciales } from './clases';

export interface PropsAvatar {
  /** Nombre completo del usuario; se muestran sus iniciales ("Juan Suárez" → "JS"). */
  nombre: string;
  /** Rol opcional para el nombre accesible ("Juan Suárez, supervisor"). */
  rol?: string;
  /** Si se pasa, el avatar es un botón (p. ej. para abrir el menú de la cuenta). */
  alPresionar?: () => void;
  className?: string;
}

/** Avatar con iniciales, 44 px. Pensado para la barra superior oscura (blanco sobre navy-800). */
export function Avatar({ nombre, rol, alPresionar, className }: PropsAvatar) {
  const nombreAccesible = rol ? `${nombre}, ${rol}` : nombre;
  const clases = cx(
    // white / navy-800 = 11,35:1
    'inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-white/30 bg-navy-800 text-sm font-semibold text-white',
    className,
  );

  if (alPresionar) {
    return (
      <button
        type="button"
        onClick={alPresionar}
        aria-label={`Cuenta de ${nombreAccesible}`}
        className={cx(clases, 'active:bg-brand-700')}
      >
        <span aria-hidden="true">{iniciales(nombre)}</span>
      </button>
    );
  }

  return (
    <span
      role="img"
      aria-label={`Usuario: ${nombreAccesible}`}
      title={nombreAccesible}
      className={clases}
    >
      <span aria-hidden="true">{iniciales(nombre)}</span>
    </span>
  );
}

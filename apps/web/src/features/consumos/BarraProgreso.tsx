import { cx } from '../../components/ui/clases';

export interface PropsBarraProgreso {
  /** Nombre accesible ("Arena sílice"). */
  etiqueta: string;
  /** Porcentaje (puede pasar de 100). */
  porcentaje: number;
  /** Texto completo para lectores de pantalla y visible bajo la barra: "130 kg de 120 kg (108 %)". */
  texto: string;
  /** Supera lo planeado más la tolerancia: barra roja y aviso en texto. */
  excede?: boolean;
  className?: string;
}

/**
 * Barra de avance planeado vs consumido (`role="progressbar"`). ARIA exige que `aria-valuenow`
 * esté entre el mínimo y el máximo: se topa en 100 y el valor real (que puede superar lo planeado)
 * va en `aria-valuetext`. El exceso se dice con texto, no solo con el color.
 */
export function BarraProgreso({
  etiqueta,
  porcentaje,
  texto,
  excede = false,
  className,
}: PropsBarraProgreso) {
  const visible = Math.max(0, Math.min(100, porcentaje));
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <div
        role="progressbar"
        aria-label={etiqueta}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(visible)}
        aria-valuetext={`${texto}${excede ? '. Supera la tolerancia' : ''}`}
        className="h-3 w-full overflow-hidden rounded-full border border-ink-400 bg-surface-200"
      >
        <div
          className={cx('h-full rounded-full', excede ? 'bg-danger-700' : 'bg-brand-600')}
          // Ancho dinámico: Tailwind no genera clases para valores arbitrarios en tiempo de
          // ejecución. `style` en un atributo de React no es un estilo en línea del HTML servido
          // (lo aplica el DOM con CSSOM), así que no lo bloquea la CSP `style-src 'self'`.
          style={{ width: `${visible}%` }}
        />
      </div>
      <p aria-hidden="true" className="cifras flex flex-wrap gap-x-2 text-[0.9375rem] text-ink-700">
        <span>{texto}</span>
        {excede && <span className="font-semibold text-danger-700">· Supera la tolerancia</span>}
      </p>
    </div>
  );
}

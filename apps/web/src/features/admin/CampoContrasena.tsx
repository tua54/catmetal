import { useId, useState } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { Campo } from '../../components/ui';
import { cx } from '../../components/ui/clases';
import { indicadorContrasena, type NivelContrasena } from './formato';

/** Segmentos llenos y su color por nivel (barra de 3 segmentos, sin estilos en línea). */
const SEGMENTOS: Readonly<Record<NivelContrasena, { llenos: number; color: string }>> = {
  vacia: { llenos: 0, color: '' },
  corta: { llenos: 1, color: 'bg-danger-700' },
  aceptable: { llenos: 2, color: 'bg-warning-500' },
  robusta: { llenos: 3, color: 'bg-success-700' },
};

export interface PropsCampoContrasena {
  etiqueta: string;
  /** Valor actual (para el indicador de longitud). */
  valor: string;
  error?: string;
  registro: UseFormRegisterReturn;
}

/**
 * Contraseña nueva con indicador de longitud (P17: mínimo 10, sin reglas de composición). El
 * indicador es texto + barra (no depende solo del color) y se enlaza con `aria-describedby`.
 */
export function CampoContrasena({ etiqueta, valor, error, registro }: PropsCampoContrasena) {
  const id = useId();
  const idIndicador = `${id}-indicador`;
  const idMostrar = `${id}-mostrar`;
  const [visible, setVisible] = useState(false);
  const indicador = indicadorContrasena(valor);
  const segmentos = SEGMENTOS[indicador.nivel];

  return (
    <div className="flex flex-col gap-2">
      <Campo
        etiqueta={etiqueta}
        requerido
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        error={error}
        aria-describedby={idIndicador}
        {...registro}
      />
      <div id={idIndicador} className="flex flex-col gap-1">
        <div aria-hidden="true" className="grid grid-cols-3 gap-1">
          {[0, 1, 2].map((indice) => (
            <span
              key={indice}
              className={cx(
                'h-2 rounded-full',
                indice < segmentos.llenos ? segmentos.color : 'bg-surface-200',
              )}
            />
          ))}
        </div>
        <p className="text-sm text-ink-700">{indicador.texto}</p>
      </div>
      <label
        htmlFor={idMostrar}
        className="flex min-h-11 items-center gap-3 text-base text-ink-700"
      >
        <input
          id={idMostrar}
          type="checkbox"
          checked={visible}
          onChange={(evento) => setVisible(evento.target.checked)}
          className="size-6 accent-brand-600"
        />
        Mostrar la contraseña
      </label>
    </div>
  );
}

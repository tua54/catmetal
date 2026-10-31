// Reglas del registro de consumo que se evalúan EN LA TABLET, como orientación (docs/spec.md S7,
// S11, P10). La autoridad es el servidor: offline no se ven los consumos de otros supervisores, así
// que si el servidor calcula otra cosa marca `requiere_novedad` y la UI pide justificarla.

import {
  convertir,
  excedeTolerancia,
  formatearCantidad,
  redondear6,
  sonConvertibles,
  UNIDADES,
  type TipoNovedad,
  type Unidad,
} from '@catmetal/shared';
import type { PlaneadoVsConsumidoLocal } from '../../datos';

export const ETIQUETAS_TIPO_NOVEDAD: Readonly<Record<TipoNovedad, string>> = {
  reproceso: 'Reproceso',
  merma: 'Merma',
  dano: 'Daño',
  error_registro: 'Error de registro',
  otro: 'Otro',
};

/** Unidades de la misma magnitud que la de referencia (S11: kg↔g, l↔ml; `und` y `m` solas). */
export function unidadesConvertibles(referencia: Unidad): Unidad[] {
  return UNIDADES.filter((unidad) => sonConvertibles(unidad, referencia));
}

export interface ConsumoEnEvaluacion {
  material_id: string | null;
  /** Cantidad ya interpretada (`parsearCantidad`); `null` si aún no es válida. */
  cantidad: number | null;
  unidad: Unidad;
}

export interface EvaluacionNovedad {
  /** La novedad es obligatoria: el interruptor se activa y se bloquea. */
  obligatoria: boolean;
  /** Explicación para el usuario (también es el `motivoBloqueo` del interruptor). */
  motivo: string | null;
  /** El material no está en el plan de la orden (P10). */
  fueraDelPlan: boolean;
  /** Plan del material, en su unidad, para la ayuda del campo de cantidad. */
  plan: {
    unidad: Unidad;
    planeada: number;
    consumido: number;
    limite: number;
    toleranciaPct: number;
  } | null;
}

const SIN_EVALUAR: EvaluacionNovedad = {
  obligatoria: false,
  motivo: null,
  fueraDelPlan: false,
  plan: null,
};

/**
 * ¿El consumo (sumado a lo que ESTA tablet ya registró en la orden) supera lo planeado más la
 * tolerancia? `excluir` descuenta el consumo que se está editando, para no contarlo dos veces.
 */
export function evaluarNovedad(
  avance: PlaneadoVsConsumidoLocal,
  consumo: ConsumoEnEvaluacion,
  excluir?: { material_id: string; cantidad: number; unidad: Unidad },
): EvaluacionNovedad {
  if (consumo.material_id === null) {
    return SIN_EVALUAR;
  }
  const plan = avance.materiales.find((m) => m.material_id === consumo.material_id);
  if (plan === undefined) {
    return {
      obligatoria: true,
      fueraDelPlan: true,
      plan: null,
      motivo:
        'Este material no está en el plan de la orden: la novedad es obligatoria para explicar su uso.',
    };
  }
  const limite = redondear6(plan.cantidad_planeada * (1 + avance.tolerancia_pct / 100));
  let consumido = plan.consumido;
  if (excluir !== undefined && excluir.material_id === plan.material_id) {
    consumido = redondear6(
      consumido - (convertir(excluir.cantidad, excluir.unidad, plan.unidad) ?? 0),
    );
  }
  const datosPlan = {
    unidad: plan.unidad,
    planeada: plan.cantidad_planeada,
    consumido,
    limite,
    toleranciaPct: avance.tolerancia_pct,
  };
  const convertida =
    consumo.cantidad === null ? null : convertir(consumo.cantidad, consumo.unidad, plan.unidad);
  if (convertida === null) {
    return { ...SIN_EVALUAR, plan: datosPlan };
  }
  const acumulado = redondear6(consumido + convertida);
  const obligatoria = excedeTolerancia({
    planeada: plan.cantidad_planeada,
    consumidaAcumulada: acumulado,
    toleranciaPct: avance.tolerancia_pct,
  });
  const u = plan.unidad;
  return {
    obligatoria,
    fueraDelPlan: false,
    plan: datosPlan,
    motivo: obligatoria
      ? `Con este registro la orden llevaría ${formatearCantidad(acumulado)} ${u} de este material; ` +
        `lo planeado más la tolerancia (${formatearCantidad(avance.tolerancia_pct)} %) es ` +
        `${formatearCantidad(limite)} ${u}. La novedad es obligatoria.`
      : null,
  };
}

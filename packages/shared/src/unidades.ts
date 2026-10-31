// Conversión de unidades y tolerancia (docs/spec.md S7 y S11).
// Solo se convierte dentro de la misma magnitud: kg↔g y l↔ml. `und` y `m` no tienen conversión.

import type { Unidad } from './dominio';

export type Magnitud = 'masa' | 'volumen' | 'conteo' | 'longitud';

export const MAGNITUD: Readonly<Record<Unidad, Magnitud>> = {
  kg: 'masa',
  g: 'masa',
  l: 'volumen',
  ml: 'volumen',
  und: 'conteo',
  m: 'longitud',
};

/** Cuántas unidades base de su magnitud tiene cada unidad (base: g, ml, und, m). */
const FACTOR_A_BASE: Readonly<Record<Unidad, number>> = {
  kg: 1000,
  g: 1,
  l: 1000,
  ml: 1,
  und: 1,
  m: 1,
};

const DECIMALES_REDONDEO = 6;

/** Redondea a 6 decimales para absorber errores de coma flotante (0,1 kg → 100 g exacto). */
export function redondear6(valor: number): number {
  const redondeado = Number(valor.toFixed(DECIMALES_REDONDEO));
  // Evita -0, que JSON serializa como 0 pero Object.is distingue.
  return redondeado === 0 ? 0 : redondeado;
}

export function sonConvertibles(de: Unidad, a: Unidad): boolean {
  return MAGNITUD[de] === MAGNITUD[a];
}

/**
 * Convierte `cantidad` de la unidad `de` a la unidad `a`.
 * Devuelve `null` si las unidades no son de la misma magnitud (código UNIDAD_INCOMPATIBLE)
 * o si la cantidad no es un número finito. El resultado se redondea a 6 decimales.
 */
export function convertir(cantidad: number, de: Unidad, a: Unidad): number | null {
  if (!Number.isFinite(cantidad) || !sonConvertibles(de, a)) {
    return null;
  }
  if (de === a) {
    return cantidad;
  }
  const factorDe = FACTOR_A_BASE[de];
  const factorA = FACTOR_A_BASE[a];
  // Multiplicar o dividir por un entero exacto (1000) da menos error que multiplicar por 0,001.
  const convertida =
    factorDe >= factorA ? cantidad * (factorDe / factorA) : cantidad / (factorA / factorDe);
  return redondear6(convertida);
}

export interface ParametrosTolerancia {
  /** Cantidad planeada, en la unidad del plan. */
  planeada: number;
  /** Consumo acumulado del material en la orden (incluido el nuevo), en la unidad del plan. */
  consumidaAcumulada: number;
  /** Tolerancia en porcentaje (5 = 5 %). */
  toleranciaPct: number;
}

/**
 * Indica si el consumo acumulado supera lo planeado más la tolerancia (S7):
 * `consumidaAcumulada > planeada × (1 + toleranciaPct / 100)`, estrictamente mayor.
 * Justo en el límite no excede. Si no hay nada planeado (planeada ≤ 0), cualquier consumo excede.
 * Ambos lados se redondean a 6 decimales para que el límite no dependa de la coma flotante.
 */
export function excedeTolerancia({
  planeada,
  consumidaAcumulada,
  toleranciaPct,
}: ParametrosTolerancia): boolean {
  if (planeada <= 0) {
    return consumidaAcumulada > 0;
  }
  const limite = redondear6(planeada + (planeada * toleranciaPct) / 100);
  return redondear6(consumidaAcumulada) > limite;
}

// Reglas de presentación y de entrada de la administración (sin React, para probarlas aisladas).

import {
  formatearFechaHora,
  parsearCantidad,
  ROLES,
  toleranciaSchema,
  type EstadoOrden,
  type Unidad,
  type Usuario,
} from '@catmetal/shared';
import { NOMBRE_ROL } from '../../rutas/acceso';

/** Política de contraseñas (P17): mínimo 10 caracteres, sin reglas de composición (NIST 800-63B). */
export const MINIMO_CONTRASENA = 10;
const CONTRASENA_ROBUSTA = 16;

/** Opciones del selector de rol, con el nombre visible de cada rol. */
export const OPCIONES_ROL = ROLES.map((rol) => ({ valor: rol, etiqueta: NOMBRE_ROL[rol] }));

export const NOMBRE_ESTADO_ORDEN: Readonly<Record<EstadoOrden, string>> = {
  planeada: 'Planeada',
  en_proceso: 'En proceso',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

export const NOMBRE_UNIDAD: Readonly<Record<Unidad, string>> = {
  kg: 'kg (kilogramos)',
  g: 'g (gramos)',
  l: 'l (litros)',
  ml: 'ml (mililitros)',
  und: 'und (unidades)',
  m: 'm (metros)',
};

export const MENSAJE_COSTO = 'Escriba el costo en pesos, sin decimales (por ejemplo 4182 o 4.182).';

/**
 * Lee un costo en pesos colombianos ENTERO. Acepta dígitos solos (`4182`) o con punto de miles en
 * grupos de 3 (`4.182`, `1.250.000`); ignora espacios y un `$` inicial. Rechaza decimales, comas y
 * negativos: en COP `4.182` son cuatro mil ciento ochenta y dos pesos, nunca 4,182.
 */
export function parsearCostoCop(texto: string): number | null {
  const limpio = texto.trim().replace(/^\$/, '').replace(/\s+/g, '');
  if (/^\d+$/.test(limpio)) {
    return Number(limpio);
  }
  if (/^\d{1,3}(\.\d{3})+$/.test(limpio)) {
    return Number(limpio.replaceAll('.', ''));
  }
  return null;
}

export type NivelContrasena = 'vacia' | 'corta' | 'aceptable' | 'robusta';

export interface IndicadorContrasena {
  nivel: NivelContrasena;
  texto: string;
}

/** Indicador de longitud de la contraseña (texto + barra de 3 segmentos: no depende solo del color). */
export function indicadorContrasena(contrasena: string): IndicadorContrasena {
  const largo = contrasena.length;
  if (largo === 0) {
    return {
      nivel: 'vacia',
      texto: `Mínimo ${MINIMO_CONTRASENA} caracteres.`,
    };
  }
  if (largo < MINIMO_CONTRASENA) {
    const faltan = MINIMO_CONTRASENA - largo;
    return {
      nivel: 'corta',
      texto: `Muy corta: ${faltan === 1 ? 'falta 1 carácter' : `faltan ${faltan} caracteres`}.`,
    };
  }
  if (largo < CONTRASENA_ROBUSTA) {
    return {
      nivel: 'aceptable',
      texto: 'Longitud aceptable. Una frase más larga es aún más segura.',
    };
  }
  return { nivel: 'robusta', texto: 'Longitud robusta.' };
}

/** El usuario está bloqueado por intentos fallidos en este momento. */
export function estaBloqueado(usuario: Usuario, ahora: Date = new Date()): boolean {
  return usuario.bloqueado_hasta !== null && Date.parse(usuario.bloqueado_hasta) > ahora.getTime();
}

/** "Bloqueado hasta 29/10/2026, 10:24 a. m." o `null` si no está bloqueado. */
export function textoBloqueo(usuario: Usuario, ahora: Date = new Date()): string | null {
  if (!estaBloqueado(usuario, ahora) || usuario.bloqueado_hasta === null) {
    return null;
  }
  return `Bloqueado hasta ${formatearFechaHora(usuario.bloqueado_hasta)}`;
}

const MENSAJE_TOLERANCIA =
  'Escriba un porcentaje entre 0 y 100, con hasta 2 decimales (por ejemplo 7,5).';

/** Lee la tolerancia escrita (coma o punto decimal, P18): el porcentaje o el mensaje de error. */
export function leerTolerancia(texto: string): { valor: number } | { error: string } {
  if (texto.trim() === '') {
    return { error: 'Escriba la nueva tolerancia.' };
  }
  const numero = parsearCantidad(texto);
  if (numero === null) {
    return { error: MENSAJE_TOLERANCIA };
  }
  const resultado = toleranciaSchema.safeParse({ tolerancia_pct: numero });
  return resultado.success
    ? { valor: resultado.data.tolerancia_pct }
    : { error: resultado.error.issues[0]?.message ?? MENSAJE_TOLERANCIA };
}

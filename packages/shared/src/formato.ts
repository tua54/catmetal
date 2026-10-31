// Formatos para Colombia (es-CO, America/Bogota, COP) y lectura de cantidades escritas por el usuario.
//
// Espacios: según el motor (Node, Chrome, Safari) y su versión de ICU, Intl usa espacio normal,
// espacio duro (U+00A0) o espacio fino duro (U+202F); por ejemplo, Node 24 produce "$\u00A04.182.300".
// Para que la salida sea idéntica en el navegador, en el Worker y en las pruebas, todas las funciones
// de este módulo normalizan esos espacios a un espacio normal (U+0020). Si la UI necesita evitar que
// "$" quede separado del número al partir la línea, debe usar `white-space: nowrap`.

import { ZONA_HORARIA } from './dominio';

const LOCALE = 'es-CO';

const formatoCOP = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'COP',
  // Se fijan ambos: algunos motores lanzan RangeError si max < min por defecto de la moneda (2).
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const formatoCantidad = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

const formatoHora = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONA_HORARIA,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const formatoFechaHora = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONA_HORARIA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const formatoDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ESPACIOS_ESPECIALES = /[\u00A0\u202F]/g;

function normalizarEspacios(texto: string): string {
  return texto.replace(ESPACIOS_ESPECIALES, ' ');
}

function aFecha(iso: string): Date | null {
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** Pesos colombianos sin decimales: `formatearCOP(4182300)` → `"$ 4.182.300"`. */
export function formatearCOP(valor: number): string {
  return normalizarEspacios(formatoCOP.format(valor));
}

/** Hora de Bogotá en 12 h: `"10:24 a. m."`. Devuelve `""` si la fecha no es válida. */
export function formatearHora(iso: string): string {
  const fecha = aFecha(iso);
  return fecha === null ? '' : normalizarEspacios(formatoHora.format(fecha));
}

/** Fecha y hora de Bogotá: `"29/10/2026, 10:24 a. m."`. Devuelve `""` si la fecha no es válida. */
export function formatearFechaHora(iso: string): string {
  const fecha = aFecha(iso);
  return fecha === null ? '' : normalizarEspacios(formatoFechaHora.format(fecha));
}

/** Cantidad con hasta 3 decimales, coma decimal y punto de miles: `1234.5` → `"1.234,5"`. */
export function formatearCantidad(valor: number): string {
  return normalizarEspacios(formatoCantidad.format(valor));
}

/**
 * Día calendario de Bogotá (`AAAA-MM-DD`) de un instante ISO. Define "registros del día".
 * Lanza RangeError si la fecha no es válida, porque un día equivocado agruparía mal los registros.
 */
export function diaBogota(iso: string): string {
  const fecha = aFecha(iso);
  if (fecha === null) {
    throw new RangeError(`Fecha no válida: ${iso}`);
  }
  const partes = formatoDia.formatToParts(fecha);
  const valor = (tipo: Intl.DateTimeFormatPartTypes): string =>
    partes.find((parte) => parte.type === tipo)?.value ?? '';
  return `${valor('year')}-${valor('month')}-${valor('day')}`;
}

const MAX_DECIMALES_CANTIDAD = 3;
const SOLO_DIGITOS = /^\d+$/;

/** Valida una parte entera con separador de miles: grupos de 3 dígitos (`1.234.567`). */
function parteEnteraConMiles(texto: string, separador: '.' | ','): string | null {
  const grupos = texto.split(separador);
  const [primero, ...resto] = grupos;
  if (primero === undefined || !/^\d{1,3}$/.test(primero) || resto.length === 0) {
    return null;
  }
  return resto.every((grupo) => /^\d{3}$/.test(grupo)) ? grupos.join('') : null;
}

/**
 * Lee una cantidad escrita por el usuario. Devuelve `null` si no es una cantidad válida.
 *
 * Reglas (docs/adr: formato de cantidades):
 * - Se aceptan solo dígitos, `.` y `,` (se ignoran los espacios al inicio y al final). Sin signo.
 * - Un solo separador, una sola vez: es el decimal, sea `.` o `,` → `"125,5"` = 125,5 y `"1.234"` = 1,234.
 * - El mismo separador varias veces: son separadores de miles → `"1.234.567"` = 1234567.
 * - Ambos separadores: el último es el decimal y el otro el de miles → `"1.234,5"` = 1234,5 y
 *   `"1,234.5"` = 1234,5.
 * - Los separadores de miles deben formar grupos de 3 dígitos; si no, `null`.
 * - Más de 3 decimales, separador al inicio o al final, o texto vacío → `null`.
 */
export function parsearCantidad(texto: string): number | null {
  const limpio = texto.trim();
  if (limpio === '' || !/^[\d.,]+$/.test(limpio)) {
    return null;
  }

  const ultimoPunto = limpio.lastIndexOf('.');
  const ultimaComa = limpio.lastIndexOf(',');
  const cuentaPuntos = limpio.split('.').length - 1;
  const cuentaComas = limpio.split(',').length - 1;

  let entero: string | null;
  let decimales = '';

  if (cuentaPuntos === 0 && cuentaComas === 0) {
    entero = limpio;
  } else if (cuentaPuntos > 0 && cuentaComas > 0) {
    const decimal: '.' | ',' = ultimoPunto > ultimaComa ? '.' : ',';
    const miles: '.' | ',' = decimal === '.' ? ',' : '.';
    const posicionDecimal = limpio.lastIndexOf(decimal);
    if ((decimal === '.' ? cuentaPuntos : cuentaComas) !== 1) {
      return null;
    }
    entero = parteEnteraConMiles(limpio.slice(0, posicionDecimal), miles);
    decimales = limpio.slice(posicionDecimal + 1);
    if (decimales === '') {
      return null;
    }
  } else {
    const separador: '.' | ',' = cuentaPuntos > 0 ? '.' : ',';
    const cuenta = Math.max(cuentaPuntos, cuentaComas);
    if (cuenta === 1) {
      const [parteEntera = '', parteDecimal = ''] = limpio.split(separador);
      entero = parteEntera;
      decimales = parteDecimal;
      if (decimales === '') {
        return null;
      }
    } else {
      entero = parteEnteraConMiles(limpio, separador);
    }
  }

  if (entero === null || !SOLO_DIGITOS.test(entero)) {
    return null;
  }
  if (
    decimales !== '' &&
    (!SOLO_DIGITOS.test(decimales) || decimales.length > MAX_DECIMALES_CANTIDAD)
  ) {
    return null;
  }

  const valor = Number(decimales === '' ? entero : `${entero}.${decimales}`);
  return Number.isFinite(valor) ? valor : null;
}

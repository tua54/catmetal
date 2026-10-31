/** Une clases de Tailwind ignorando valores vacíos (sin dependencias externas). */
export function cx(...clases: (string | false | null | undefined)[]): string {
  return clases.filter(Boolean).join(' ');
}

/** Une ids para `aria-describedby`, omitiendo los vacíos. Devuelve `undefined` si no queda ninguno. */
export function unirIds(...ids: unknown[]): string | undefined {
  const validos = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return validos.length > 0 ? validos.join(' ') : undefined;
}

/**
 * Normaliza texto para búsquedas: minúsculas y sin tildes ("Resina furánica" ≈ "resina furanica").
 * Así en planta se encuentra un material aunque se escriba sin tildes.
 */
export function normalizarBusqueda(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es-CO').trim();
}

/** Iniciales para el avatar: "Juan Suárez" → "JS"; "roberto" → "R". */
export function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  const primera = partes[0]?.[0] ?? '';
  const ultima = partes.length > 1 ? (partes[partes.length - 1]?.[0] ?? '') : '';
  return `${primera}${ultima}`.toLocaleUpperCase('es-CO');
}

/**
 * Nombre accesible del botón de la cuenta: "Cuenta de Juan Suárez, Supervisor, iniciales JS".
 * Incluye, como palabra aparte, las iniciales que se ven en el avatar (WCAG 2.5.3: el nombre contiene
 * el texto visible; axe ignora lo que va entre paréntesis) y empieza por "Cuenta de" para que se
 * reconozca la acción.
 */
export function nombreBotonCuenta(nombre: string, rol?: string): string {
  return `Cuenta de ${nombre}${rol ? `, ${rol}` : ''}, iniciales ${iniciales(nombre)}`;
}

/** Clases compartidas por inputs, textareas y selects: borde ink-400 (3,74:1 sobre blanco). */
export function clasesControl(conError: boolean): string {
  return cx(
    'block w-full rounded-lg border bg-white px-4 text-base text-ink-950 placeholder:text-ink-500',
    'disabled:cursor-not-allowed disabled:bg-surface-200 disabled:text-ink-500',
    conError ? 'border-2 border-danger-700' : 'border-ink-400',
  );
}

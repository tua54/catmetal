// Formato único de fechas del sistema: ISO-8601 UTC con milisegundos y `Z`, siempre 24 caracteres
// (`2026-10-29T20:55:00.000Z`). Es el formato de las columnas de fecha de D1 (CHECK length = 24).

/** Instante actual en el formato único. Úselo en el Worker y en la PWA en lugar de `Date` suelto. */
export function ahoraIso(): string {
  return new Date().toISOString();
}

// Descripción técnica de un error para los logs del cron (sin datos personales; ADR 0014 y 0020).
// Vive aparte de `ejecutar.ts` para que `backup.ts` la use (motivo de una tabla `incompleta`) sin
// una importación circular.

const MAX_MENSAJE_ERROR = 300;

export function describirError(error: unknown): string {
  const texto = error instanceof Error ? `${error.name}: ${error.message}` : 'Error desconocido';
  return texto.slice(0, MAX_MENSAJE_ERROR);
}

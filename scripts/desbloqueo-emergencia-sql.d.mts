// Tipos de desbloqueo-emergencia-sql.mjs, para que la prueba del Worker (TypeScript) lo importe.

export interface OpcionesDesbloqueo {
  email: string;
  ahora?: Date;
}

export function normalizarEmail(email: unknown): string | null;
export function generarSqlDesbloqueo(opciones: OpcionesDesbloqueo): string[];
export function archivoSqlDesbloqueo(opciones: OpcionesDesbloqueo): string;

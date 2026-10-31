// Logs estructurados (Workers Logs). Una línea JSON por evento.
//
// Regla: nunca se registran datos personales (correo, nombre), tokens, contraseñas, cuerpos de
// petición ni query strings. Solo identificadores técnicos (ids, rutas sin query, códigos).

export type NivelLog = 'info' | 'aviso' | 'error';

export type DatosLog = Record<string, string | number | boolean | null | undefined>;

export function registrar(nivel: NivelLog, evento: string, datos: DatosLog = {}): void {
  console.log(JSON.stringify({ nivel, evento, hora: new Date().toISOString(), ...datos }));
}

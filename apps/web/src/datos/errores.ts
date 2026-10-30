// Errores de la capa de datos local. Usan los mismos códigos que la API cuando la regla es la misma
// (la PWA los muestra con `MENSAJES_ERROR`), más `PENDIENTES_LOCALES`, que es solo del dispositivo.

import { MENSAJES_ERROR, type CodigoError } from '@catmetal/shared';

export type CodigoErrorLocal = CodigoError | 'PENDIENTES_LOCALES';

const MENSAJES_LOCALES: Readonly<Record<'PENDIENTES_LOCALES', string>> = {
  PENDIENTES_LOCALES:
    'Hay registros sin sincronizar en este dispositivo. Sincronice antes de borrar los datos.',
};

export class ErrorDatosLocales extends Error {
  override readonly name = 'ErrorDatosLocales';
  readonly code: CodigoErrorLocal;

  constructor(code: CodigoErrorLocal, message?: string) {
    super(
      message ?? (code === 'PENDIENTES_LOCALES' ? MENSAJES_LOCALES[code] : MENSAJES_ERROR[code]),
    );
    this.code = code;
  }
}

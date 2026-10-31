// Retención de datos en la tablet (ADR 0017 §5, F4-04; Ley 1581). Corre al arrancar la app:
//
// 1. La purga de mutaciones aplicadas y de bytes de fotos subidas (`purgarAplicadasAntiguas`) se
//    aplica a TODAS las particiones del dispositivo, no solo a la del usuario que sincroniza.
// 2. Los perfiles sin acceso en 30 días y SIN pendientes se borran con su partición (perfil,
//    verificador, catálogos, entidades y trazabilidad). Se conserva lo que la ADR 0012 nunca borra
//    sola (mutaciones `rechazada`/`conflicto` y las aplicadas dentro de la retención, con sus
//    entidades) y `meta.epoca`, igual que al cerrar sesión (`borrarDatosDeUsuario`).
// 3. El admin no trabaja offline (ADR 0017 §3): se borra cualquier verificador de un admin que haya
//    quedado de una versión anterior.

import { db } from './db';
import { ErrorDatosLocales } from './errores';
import { borrarDatosDeUsuario, puedeBorrarDatosDeUsuario, purgarAplicadasAntiguas } from './outbox';

/** Días sin acceso tras los que caduca un perfil sin pendientes (ADR 0017 §5). */
export const DIAS_CADUCIDAD_PERFIL = 30;
const MS_POR_DIA = 86_400_000;

export interface ResultadoRetencion {
  /** Particiones revisadas por la purga de aplicadas. */
  particiones: number;
  mutaciones_purgadas: number;
  fotos_liberadas: number;
  /** Perfiles caducados y borrados con su partición. */
  perfiles_caducados: string[];
  /** Verificadores de admin borrados. */
  verificadores_admin: number;
}

export interface OpcionesRetencion {
  ahora?: Date;
  /** Usuario de la sesión activa: nunca caduca. */
  excluir?: string | null;
}

/** Aplica la retención de la tablet a todas las particiones (ver el encabezado). */
export async function aplicarRetencionDelDispositivo(
  opciones: OpcionesRetencion = {},
): Promise<ResultadoRetencion> {
  const ahora = opciones.ahora ?? new Date();
  const resultado: ResultadoRetencion = {
    particiones: 0,
    mutaciones_purgadas: 0,
    fotos_liberadas: 0,
    perfiles_caducados: [],
    verificadores_admin: 0,
  };

  const ids = new Set<string>([
    ...(await db.perfiles.toCollection().primaryKeys()),
    ...(await db.meta.toCollection().primaryKeys()),
  ]);
  for (const userId of ids) {
    const purga = await purgarAplicadasAntiguas(userId, ahora);
    resultado.particiones += 1;
    resultado.mutaciones_purgadas += purga.mutaciones;
    resultado.fotos_liberadas += purga.fotos_liberadas;
  }

  const limite = new Date(ahora.getTime() - DIAS_CADUCIDAD_PERFIL * MS_POR_DIA).toISOString();
  for (const perfil of await db.perfiles.toArray()) {
    if (perfil.user_id === opciones.excluir) {
      continue;
    }
    const ultimoUso = perfil.ultimo_acceso_at ?? perfil.actualizado_at;
    if (ultimoUso < limite && (await puedeBorrarDatosDeUsuario(perfil.user_id)).puede) {
      try {
        await borrarDatosDeUsuario(perfil.user_id, { conservarPerfil: false, ahora });
        resultado.perfiles_caducados.push(perfil.user_id);
        continue;
      } catch (error) {
        // Llegó un pendiente entre la comprobación y el borrado: el perfil se queda.
        if (!(error instanceof ErrorDatosLocales && error.code === 'PENDIENTES_LOCALES')) {
          throw error;
        }
      }
    }
    if (perfil.perfil.rol === 'admin' && perfil.verificador !== null) {
      await db.perfiles.update(perfil.user_id, {
        verificador: null,
        intentos_offline: 0,
        espera_hasta: null,
      });
      resultado.verificadores_admin += 1;
    }
  }
  return resultado;
}

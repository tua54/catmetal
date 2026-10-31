// Lectura defensiva de las entidades que devuelve el servidor (`servidor` del push y `datos` del
// pull). El contrato de shared las tipa como `Record<string, unknown>`; aquí se comprueba la forma
// mínima antes de guardarlas, para que un dato malformado no corrompa la base local.
//
// TODO(shared): `resultadoMutacionSchema.servidor` no está tipado por tipo de mutación. Formas
// reconocidas (código del Worker, Fase 2): `consumo.crear`/`consumo.editar` → `Consumo`;
// `novedad.crear` → `Novedad & { evidencias: Evidencia[] }`; `conflicto` → `Consumo` o
// `{ consumo: Consumo, version_servidor }`; `consumo.aprobar`/`consumo.rechazar` → `Validacion`,
// `Consumo` o `{ consumo, validacion }`. Se reconoce cada entidad por su forma, no por el tipo.

import {
  DECISIONES,
  ESTADOS_CONSUMO,
  ESTADOS_ORDEN,
  MIMES_EVIDENCIA,
  ROLES,
  TIPOS_NOVEDAD,
  UNIDADES,
  type Consumo,
  type Evidencia,
  type Material,
  type Novedad,
  type Orden,
  type Rol,
  type Validacion,
} from '@catmetal/shared';

type Objeto = Record<string, unknown>;

export function esObjeto(valor: unknown): valor is Objeto {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(o: Objeto, campo: string): boolean {
  return typeof o[campo] === 'string';
}

function textoONulo(o: Objeto, campo: string): boolean {
  return o[campo] === null || o[campo] === undefined || typeof o[campo] === 'string';
}

function numero(o: Objeto, campo: string): boolean {
  return typeof o[campo] === 'number' && Number.isFinite(o[campo]);
}

function enLista(o: Objeto, campo: string, lista: readonly string[]): boolean {
  return typeof o[campo] === 'string' && lista.includes(o[campo]);
}

/** Booleano de la API (o 0/1 si llegara con el formato de D1). */
export function booleano(valor: unknown): boolean {
  return valor === true || valor === 1;
}

export function esConsumo(valor: unknown): valor is Consumo {
  return (
    esObjeto(valor) &&
    texto(valor, 'id') &&
    texto(valor, 'order_id') &&
    texto(valor, 'material_id') &&
    numero(valor, 'cantidad') &&
    enLista(valor, 'unidad', UNIDADES) &&
    texto(valor, 'lote') &&
    texto(valor, 'registrado_por') &&
    texto(valor, 'client_created_at') &&
    enLista(valor, 'estado', ESTADOS_CONSUMO) &&
    numero(valor, 'version')
  );
}

export function esNovedad(valor: unknown): valor is Novedad {
  return (
    esObjeto(valor) &&
    texto(valor, 'id') &&
    texto(valor, 'consumption_id') &&
    enLista(valor, 'tipo', TIPOS_NOVEDAD) &&
    texto(valor, 'descripcion') &&
    texto(valor, 'registrado_por') &&
    texto(valor, 'client_created_at')
  );
}

export function esEvidencia(valor: unknown): valor is Evidencia {
  return (
    esObjeto(valor) &&
    texto(valor, 'id') &&
    texto(valor, 'incident_id') &&
    enLista(valor, 'mime', MIMES_EVIDENCIA) &&
    numero(valor, 'tamano_bytes') &&
    texto(valor, 'sha256')
  );
}

export function esValidacion(valor: unknown): valor is Validacion {
  return (
    esObjeto(valor) &&
    texto(valor, 'id') &&
    texto(valor, 'consumption_id') &&
    enLista(valor, 'decision', DECISIONES) &&
    textoONulo(valor, 'motivo') &&
    texto(valor, 'validado_por') &&
    texto(valor, 'client_created_at')
  );
}

export function esOrden(valor: unknown): valor is Orden {
  return (
    esObjeto(valor) &&
    texto(valor, 'id') &&
    texto(valor, 'codigo') &&
    texto(valor, 'linea') &&
    enLista(valor, 'estado', ESTADOS_ORDEN)
  );
}

export function esMaterial(valor: unknown): valor is Material {
  return (
    esObjeto(valor) &&
    texto(valor, 'id') &&
    texto(valor, 'codigo') &&
    texto(valor, 'nombre') &&
    enLista(valor, 'unidad', UNIDADES) &&
    numero(valor, 'costo_unitario_cop')
  );
}

export function esRol(valor: unknown): valor is Rol {
  return typeof valor === 'string' && (ROLES as readonly string[]).includes(valor);
}

/** Entidades reconocidas dentro de una respuesta del servidor. */
export interface EntidadesServidor {
  consumos: Consumo[];
  novedades: Novedad[];
  evidencias: Evidencia[];
  validaciones: Validacion[];
}

/**
 * Recorre `servidor` (y sus claves `consumo`, `novedad`, `validacion`, `evidencias`) y clasifica cada
 * objeto por su forma. Ignora lo que no reconoce.
 */
export function extraerEntidades(servidor: unknown): EntidadesServidor {
  const salida: EntidadesServidor = {
    consumos: [],
    novedades: [],
    evidencias: [],
    validaciones: [],
  };
  if (!esObjeto(servidor)) {
    return salida;
  }
  const candidatos: unknown[] = [servidor, servidor.consumo, servidor.novedad, servidor.validacion];
  if (Array.isArray(servidor.evidencias)) {
    candidatos.push(...(servidor.evidencias as unknown[]));
  }
  for (const candidato of candidatos) {
    if (esConsumo(candidato)) {
      salida.consumos.push(candidato);
    } else if (esValidacion(candidato)) {
      salida.validaciones.push(candidato);
    } else if (esNovedad(candidato)) {
      // Las evidencias anidadas se guardan aparte; la novedad queda con la forma de `Novedad`.
      const novedad: Novedad & { evidencias?: unknown } = { ...candidato };
      delete novedad.evidencias;
      salida.novedades.push(novedad);
    } else if (esEvidencia(candidato)) {
      salida.evidencias.push(candidato);
    }
  }
  return salida;
}

/**
 * Devuelve el más reciente de dos estados del servidor de la misma entidad: mayor `version` y, a
 * igual versión, mayor o igual `updated_at` (gana `nuevo` en el empate). Evita que una respuesta
 * vieja haga retroceder la vista local.
 *
 * Solo compara estados de la MISMA época (ADR 0022): las versiones de antes y después de una
 * restauración no son comparables. Por eso el reemplazo del snapshot no la usa (el servidor manda)
 * y un `servidor` marcado `servidor_obsoleto` se reemplaza sin comparar (ver `adoptarServidor`).
 */
export function masReciente<T extends { version?: number; updated_at?: string }>(
  actual: T | null,
  nuevo: T | null,
): T | null {
  if (actual === null) {
    return nuevo;
  }
  if (nuevo === null) {
    return actual;
  }
  const vActual = actual.version ?? 0;
  const vNuevo = nuevo.version ?? 0;
  if (vNuevo !== vActual) {
    return vNuevo > vActual ? nuevo : actual;
  }
  return (nuevo.updated_at ?? '') >= (actual.updated_at ?? '') ? nuevo : actual;
}

/**
 * Estado que queda en `servidor` al recibir `nuevo` de una fuente de la época actual (pull o push
 * `aplicada`): si el actual es de antes de un reinicio (`obsoleto`, ADR 0022), gana `nuevo` sin
 * comparar versiones; si no, el más reciente.
 */
export function adoptarServidor<T extends { version?: number; updated_at?: string }>(
  actual: T | null,
  obsoleto: boolean | undefined,
  nuevo: T,
): T {
  return obsoleto === true ? nuevo : (masReciente(actual, nuevo) ?? nuevo);
}

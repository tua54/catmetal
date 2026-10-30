// Esquemas Zod 4 de las entradas de la API y del protocolo de sincronización (docs/spec.md §5–§7).
// Son el contrato entre la PWA y el Worker: el Worker valida TODAS las entradas con ellos.
//
// - Los objetos usan el modo por defecto de Zod (descarta claves desconocidas), así una clave extra
//   como `password_hash` o `estado` nunca llega a la lógica de negocio.
// - Los mensajes de las reglas propias están en español; los genéricos de Zod (tipo incorrecto,
//   clave faltante, etc.) también, porque este módulo activa el locale `es` de Zod al importarse.

import { z } from 'zod';
import {
  MAX_EVIDENCIA_BYTES,
  MAX_EVIDENCIAS_POR_NOVEDAD,
  MAX_MUTACIONES_POR_LOTE,
  MIMES_EVIDENCIA,
  RESULTADOS_MUTACION,
  ROLES,
  TIPOS_NOVEDAD,
  UNIDADES,
} from './dominio';
import { esCaracterRepetido, esContrasenaComun } from './contrasenas';
import { CODIGOS_ERROR } from './errores';
import { esUuidV7, REGEX_UUID_V7 } from './uuid';

// Efecto global intencional: todos los mensajes genéricos de Zod en español, en la PWA y en el Worker.
// `jitless`: Zod 4 compila los objetos con `new Function`; la CSP de la PWA (`script-src 'self'`, sin
// `unsafe-eval`) y el runtime de Workers lo bloquean y Zod recurre a su respaldo, pero el intento deja
// una violación de CSP en la consola (Lighthouse, Best Practices). Se desactiva la compilación JIT.
z.config({ ...z.locales.es(), jitless: true });

// ---------------------------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------------------------

export const uuidV7Schema = z
  .string({ error: 'El identificador es obligatorio.' })
  .regex(REGEX_UUID_V7, { error: 'El identificador no es un UUID v7 válido.' });

const MENSAJE_FECHA = 'La fecha debe estar en formato ISO-8601 UTC (terminada en Z).';

/**
 * Instante ISO-8601 en UTC con `Z`, sin desfases horarios. Se **normaliza** con `toISOString()`
 * al formato único de D1: 24 caracteres con milisegundos (`2026-10-29T20:55:00Z` →
 * `2026-10-29T20:55:00.000Z`). Más de 3 decimales de segundo se truncan a milisegundos.
 * Rechaza fechas inexistentes en el calendario.
 */
// z.iso.datetime ya valida el calendario (rechaza 2026-02-29, 24:00, segundos 60), así que
// toISOString() nunca recibe una fecha inválida.
export const isoFechaSchema = z.iso
  .datetime({ error: MENSAJE_FECHA })
  .transform((valor) => new Date(valor).toISOString());

/**
 * Cabecera con la hora del dispositivo AL ENVIAR, en las peticiones REST que escriben (método
 * distinto de GET/HEAD/OPTIONS). Mismo formato que `client_created_at` (ADR 0019, spec §6 "Reloj").
 */
export const CABECERA_HORA_DISPOSITIVO = 'X-Hora-Dispositivo';

/**
 * Hora de envío del dispositivo (`enviado_at` del push o la cabecera `X-Hora-Dispositivo`),
 * normalizada al formato único. Un valor ausente o con formato inválido devuelve `null`: **nunca
 * rechaza la petición**, solo se ignora y la alerta de reloj queda en 0 (ADR 0019).
 */
export function horaDeEnvio(valor: unknown): string | null {
  const resultado = isoFechaSchema.safeParse(valor);
  return resultado.success ? resultado.data : null;
}

/**
 * Versión de contrato del cliente (B5, ADR 0026). Es un entero que se sube solo cuando un cambio
 * del contrato exige que los clientes viejos se actualicen. La v1.0 no mandaba la cabecera y cuenta
 * como 1; la v1.1 es la 2.
 */
export const VERSION_CLIENTE = 2;

/** Cabecera con `VERSION_CLIENTE` en toda petición del cliente a `/api/v1` (REST y `/sync/*`). */
export const CABECERA_VERSION_CLIENTE = 'X-Version-Cliente';

/** Mayor versión aceptada; un valor más grande es inválido y cuenta como 1. */
const MAX_VERSION_CLIENTE = 999_999;

/** Entero positivo en decimal, sin signo, sin ceros a la izquierda y con hasta 6 cifras. */
const VERSION_DECIMAL = /^[1-9]\d{0,5}$/;

/**
 * Versión de la cabecera `X-Version-Cliente` o de la variable `VERSION_MINIMA_CLIENTE`. Un valor
 * ausente o inválido (no entero, cero, negativo o fuera de rango) cuenta como **1**: nunca rechaza
 * la petición por formato (ADR 0026).
 */
export function versionClienteDe(valor: unknown): number {
  if (typeof valor === 'number') {
    return Number.isSafeInteger(valor) && valor >= 1 && valor <= MAX_VERSION_CLIENTE ? valor : 1;
  }
  if (typeof valor === 'string' && VERSION_DECIMAL.test(valor)) {
    return Number(valor);
  }
  return 1;
}

/** Tiene como máximo 3 decimales (el número es el double más cercano a un decimal de 3 cifras). */
function tieneMaximo3Decimales(valor: number): boolean {
  return Number(valor.toFixed(3)) === valor;
}

export const cantidadSchema = z
  .number({ error: 'La cantidad debe ser un número.' })
  .positive({ error: 'La cantidad debe ser mayor que cero.' })
  .max(1e9, { error: 'La cantidad es demasiado grande.' })
  .refine(tieneMaximo3Decimales, { error: 'La cantidad admite máximo 3 decimales.' });

const TAB = 0x09;
const SALTO_DE_LINEA = 0x0a;

/**
 * `true` si el texto tiene caracteres de control C0 (U+0000–U+001F) o DEL (U+007F). Con
 * `multilinea`, se permiten el salto de línea (U+000A) y el tabulador (U+0009), para descripciones
 * y motivos escritos en un área de texto. Se recorre por código y no con una expresión regular para
 * no escribir caracteres de control en el código fuente.
 */
export function tieneCaracteresDeControl(texto: string, multilinea = false): boolean {
  for (let i = 0; i < texto.length; i += 1) {
    const codigo = texto.charCodeAt(i);
    const esControl = codigo <= 0x1f || codigo === 0x7f;
    const permitido = multilinea && (codigo === SALTO_DE_LINEA || codigo === TAB);
    if (esControl && !permitido) {
      return true;
    }
  }
  return false;
}

function mensajeControl(campo: string, multilinea: boolean): string {
  return multilinea
    ? `${campo} tiene caracteres no permitidos (solo se admiten saltos de línea y tabuladores).`
    : `${campo} tiene caracteres no permitidos.`;
}

export const loteSchema = z
  .string({ error: 'El lote es obligatorio.' })
  .trim()
  .min(1, { error: 'El lote es obligatorio.' })
  .max(64, { error: 'El lote admite máximo 64 caracteres.' })
  .refine((valor) => !tieneCaracteresDeControl(valor), {
    error: mensajeControl('El lote', false),
  });

export const emailSchema = z
  .string({ error: 'El correo es obligatorio.' })
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email({ error: 'El correo no es válido.' })
      .max(254, { error: 'El correo admite máximo 254 caracteres.' }),
  );

/**
 * Contraseña al crear un usuario o restablecerla (NO en el login, ver `loginSchema`): 10–128
 * caracteres, no está en la lista de contraseñas comunes ni es un mismo carácter repetido (F6-07,
 * ver contrasenas.ts). Las dos últimas reglas solo se evalúan con la longitud mínima cumplida, para
 * que una contraseña corta reciba un único mensaje.
 */
export const passwordSchema = z
  .string({ error: 'La contraseña es obligatoria.' })
  .min(10, { error: 'La contraseña debe tener al menos 10 caracteres.' })
  .max(128, { error: 'La contraseña admite máximo 128 caracteres.' })
  .refine((valor) => valor.length < 10 || !esCaracterRepetido(valor), {
    error: 'La contraseña no puede ser un mismo carácter repetido.',
  })
  .refine((valor) => valor.length < 10 || !esContrasenaComun(valor), {
    error: 'La contraseña es demasiado común y fácil de adivinar. Elija otra.',
  });

const unidadSchema = z.enum(UNIDADES, { error: 'La unidad no es válida.' });
const rolSchema = z.enum(ROLES, { error: 'El rol no es válido.' });

/**
 * Texto libre recortado, con longitud entre `min` y `max` y sin caracteres de control (salvo
 * salto de línea y tabulador si `multilinea`).
 */
function textoSchema(campo: string, min: number, max: number, multilinea = false) {
  return z
    .string({ error: `${campo} es obligatorio.` })
    .trim()
    .min(min, {
      error:
        min <= 1 ? `${campo} es obligatorio.` : `${campo} debe tener al menos ${min} caracteres.`,
    })
    .max(max, { error: `${campo} admite máximo ${max} caracteres.` })
    .refine((valor) => !tieneCaracteresDeControl(valor, multilinea), {
      error: mensajeControl(campo, multilinea),
    });
}

function sinRepetidos<T>(valores: readonly T[]): boolean {
  return new Set(valores).size === valores.length;
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  // En el login no se aplica la política de longitud: cualquier contraseña incorrecta debe
  // responder CREDENCIALES_INVALIDAS, no un error de validación distinto.
  password: z
    .string({ error: 'La contraseña es obligatoria.' })
    .min(1, { error: 'La contraseña es obligatoria.' })
    .max(128, { error: 'La contraseña admite máximo 128 caracteres.' }),
  /** Propuesto por el cliente: uno por usuario y navegador (ADR 0008 punto 7). */
  device_id: uuidV7Schema,
  device_nombre: textoSchema('El nombre del dispositivo', 1, 100).optional(),
  /** Uno por navegador, compartido entre los usuarios de la misma tablet (ADR 0008 punto 7). */
  instalacion_id: uuidV7Schema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------------------------

export const crearUsuarioSchema = z.object({
  nombre: textoSchema('El nombre', 1, 120),
  email: emailSchema,
  rol: rolSchema,
  password: passwordSchema,
});

export const editarUsuarioSchema = z
  .object({
    nombre: textoSchema('El nombre', 1, 120).optional(),
    rol: rolSchema.optional(),
    activo: z.boolean({ error: 'El campo activo debe ser verdadero o falso.' }).optional(),
    password: passwordSchema.optional(),
    /** Reinicia `intentos_fallidos` y `bloqueado_hasta` (desbloqueo por el admin, ADR 0008). */
    desbloquear: z.literal(true, { error: 'El campo desbloquear solo admite true.' }).optional(),
  })
  .refine((datos) => Object.values(datos).some((valor) => valor !== undefined), {
    error: 'Indique al menos un campo para modificar.',
  });

const costoUnitarioSchema = z
  .number({ error: 'El costo unitario debe ser un número.' })
  .int({ error: 'El costo unitario debe ser un valor entero en pesos.' })
  .min(0, { error: 'El costo unitario no puede ser negativo.' })
  .max(1e12, { error: 'El costo unitario es demasiado grande.' });

export const crearMaterialSchema = z.object({
  codigo: textoSchema('El código', 1, 32),
  nombre: textoSchema('El nombre', 1, 120),
  unidad: unidadSchema,
  costo_unitario_cop: costoUnitarioSchema,
});

/**
 * El código y la unidad de un material no se editan: la unidad la usan los planes y los consumos
 * ya registrados, y cambiarla alteraría la conversión de datos históricos.
 */
export const editarMaterialSchema = z
  .object({
    nombre: textoSchema('El nombre', 1, 120).optional(),
    costo_unitario_cop: costoUnitarioSchema.optional(),
    activo: z.boolean({ error: 'El campo activo debe ser verdadero o falso.' }).optional(),
  })
  .refine((datos) => Object.values(datos).some((valor) => valor !== undefined), {
    error: 'Indique al menos un campo para modificar.',
  });

export const toleranciaSchema = z.object({
  tolerancia_pct: z
    .number({ error: 'La tolerancia debe ser un número.' })
    .min(0, { error: 'La tolerancia no puede ser negativa.' })
    .max(100, { error: 'La tolerancia no puede superar 100 %.' })
    .refine((valor) => Number(valor.toFixed(2)) === valor, {
      error: 'La tolerancia admite máximo 2 decimales.',
    }),
});

export const asignarSupervisoresSchema = z.object({
  supervisores: z
    .array(uuidV7Schema, { error: 'La lista de supervisores es obligatoria.' })
    .max(50, { error: 'Máximo 50 supervisores por orden.' })
    .refine(sinRepetidos, { error: 'Hay supervisores repetidos.' }),
});

// ---------------------------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------------------------

export const materialPlaneadoSchema = z.object({
  material_id: uuidV7Schema,
  cantidad_planeada: cantidadSchema,
  unidad: unidadSchema,
});

export const crearOrdenSchema = z.object({
  id: uuidV7Schema.optional(),
  codigo: z
    .string({ error: 'El código de la orden es obligatorio.' })
    .trim()
    .regex(/^OP-\d{4}-\d{4}$/, {
      error: 'El código de la orden debe tener el formato OP-AAAA-NNNN.',
    }),
  linea: textoSchema('La línea', 1, 80),
  materiales: z
    .array(materialPlaneadoSchema, { error: 'Los materiales planeados son obligatorios.' })
    .min(1, { error: 'La orden debe tener al menos un material planeado.' })
    .max(50, { error: 'Máximo 50 materiales por orden.' })
    .refine((materiales) => sinRepetidos(materiales.map((m) => m.material_id)), {
      error: 'Hay materiales repetidos en la orden.',
    }),
});

export const finalizarOrdenSchema = z.object({
  force: z.boolean({ error: 'El campo force debe ser verdadero o falso.' }).optional(),
});

// ---------------------------------------------------------------------------------------------
// Consumos
// ---------------------------------------------------------------------------------------------

export const crearConsumoSchema = z.object({
  id: uuidV7Schema,
  order_id: uuidV7Schema,
  material_id: uuidV7Schema,
  cantidad: cantidadSchema,
  unidad: unidadSchema,
  lote: loteSchema,
  client_created_at: isoFechaSchema,
  /** Consumo rechazado que este corrige (S3). */
  corrige_a: uuidV7Schema.nullable().optional(),
});

/** Versión de un consumo que conoce el cliente (empieza en 1; control de concurrencia optimista). */
const versionConsumoSchema = z
  .number({ error: 'La versión es obligatoria.' })
  .int({ error: 'La versión debe ser un entero.' })
  .min(1, { error: 'La versión debe ser mayor o igual a 1.' });

/** Edición de un consumo propio pendiente (S4). `version` es la que el cliente conoce (empieza en 1). */
export const editarConsumoSchema = z
  .object({
    id: uuidV7Schema,
    version: versionConsumoSchema,
    material_id: uuidV7Schema.optional(),
    cantidad: cantidadSchema.optional(),
    unidad: unidadSchema.optional(),
    lote: loteSchema.optional(),
    client_created_at: isoFechaSchema,
  })
  .refine(
    (datos) =>
      datos.material_id !== undefined ||
      datos.cantidad !== undefined ||
      datos.unidad !== undefined ||
      datos.lote !== undefined,
    { error: 'Indique al menos un campo para modificar.' },
  );

// ---------------------------------------------------------------------------------------------
// Novedades y evidencias
// ---------------------------------------------------------------------------------------------

export const evidenciaMetaSchema = z.object({
  id: uuidV7Schema,
  mime: z.enum(MIMES_EVIDENCIA, { error: 'La foto debe ser una imagen JPG, PNG o WEBP.' }),
  tamano_bytes: z
    .number({ error: 'El tamaño de la foto es obligatorio.' })
    .int({ error: 'El tamaño de la foto debe ser un entero.' })
    .min(1, { error: 'La foto está vacía.' })
    .max(MAX_EVIDENCIA_BYTES, { error: 'La foto es demasiado grande. El máximo es 5 MB.' }),
  sha256: z.string({ error: 'El sha256 de la foto es obligatorio.' }).regex(/^[0-9a-f]{64}$/, {
    error: 'El sha256 debe tener 64 caracteres hexadecimales en minúscula.',
  }),
});

export const crearNovedadSchema = z.object({
  id: uuidV7Schema,
  consumption_id: uuidV7Schema,
  tipo: z.enum(TIPOS_NOVEDAD, { error: 'El tipo de novedad no es válido.' }),
  descripcion: textoSchema('La descripción', 1, 2000, true),
  client_created_at: isoFechaSchema,
  evidencias: z
    .array(evidenciaMetaSchema, { error: 'La lista de evidencias es obligatoria.' })
    .max(MAX_EVIDENCIAS_POR_NOVEDAD, {
      error: `Máximo ${MAX_EVIDENCIAS_POR_NOVEDAD} fotos por novedad.`,
    })
    .refine((evidencias) => sinRepetidos(evidencias.map((e) => e.id)), {
      error: 'Hay fotos repetidas en la novedad.',
    }),
});

// ---------------------------------------------------------------------------------------------
// Validación del jefe
// ---------------------------------------------------------------------------------------------

/**
 * `id` es el id de la validación (UUID v7 generado por el cliente). `version` es la versión del
 * consumo que vio el jefe: si cambió mientras decidía, el servidor responde 409 CONFLICTO (ADR 0010).
 */
export const aprobarSchema = z.object({
  id: uuidV7Schema,
  version: versionConsumoSchema,
  client_created_at: isoFechaSchema,
});

export const rechazarSchema = z.object({
  id: uuidV7Schema,
  version: versionConsumoSchema,
  motivo: textoSchema('El motivo del rechazo', 3, 500, true),
  client_created_at: isoFechaSchema,
});

// ---------------------------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------------------------

const baseMutacion = {
  mutation_id: uuidV7Schema,
  client_created_at: isoFechaSchema,
};

export const mutacionSchema = z.discriminatedUnion(
  'tipo',
  [
    z.object({ ...baseMutacion, tipo: z.literal('consumo.crear'), payload: crearConsumoSchema }),
    z.object({ ...baseMutacion, tipo: z.literal('consumo.editar'), payload: editarConsumoSchema }),
    z.object({ ...baseMutacion, tipo: z.literal('novedad.crear'), payload: crearNovedadSchema }),
    z.object({
      ...baseMutacion,
      tipo: z.literal('consumo.aprobar'),
      payload: aprobarSchema.extend({ consumption_id: uuidV7Schema }),
    }),
    z.object({
      ...baseMutacion,
      tipo: z.literal('consumo.rechazar'),
      payload: rechazarSchema.extend({ consumption_id: uuidV7Schema }),
    }),
  ],
  { error: 'El tipo de mutación no es válido.' },
);

/**
 * Sobre de `POST /sync/push` (ADR 0009). Es **laxo** a propósito: las mutaciones no se validan aquí,
 * sino una por una con `mutacionSchema.safeParse`, para que una sola mutación inválida (por ejemplo,
 * de una PWA vieja) no atasque el lote entero.
 * - `user_id` es el autor del outbox; debe coincidir con el `sub` de la sesión (si no,
 *   403 `AUTOR_NO_COINCIDE` y no se procesa nada).
 * - No lleva `device_id`: el servidor usa el `did` de la sesión.
 */
export const syncPushRequestSchema = z.object({
  user_id: uuidV7Schema,
  /**
   * Época de sync que conoce el cliente (ADR 0009/0016). Si no coincide con la del servidor, el push
   * responde 409 `EPOCA_CAMBIADA` sin procesar ni guardar nada. Ausente = cliente viejo o primer
   * arranque (se procesa).
   */
  epoca: z.string().min(1).max(64).optional(),
  /**
   * Hora del dispositivo justo antes de enviar este push (también en cada reintento), ISO-8601 UTC
   * (ADR 0019). Con ella se calcula `alerta_reloj` de toda la petición. Ausente (cliente viejo) o
   * inválida → `undefined`: se ignora sin rechazar el sobre.
   */
  enviado_at: z
    .unknown()
    .transform((valor) => horaDeEnvio(valor) ?? undefined)
    .optional(),
  mutaciones: z
    .array(z.unknown(), { error: 'La lista de mutaciones es obligatoria.' })
    .min(1, { error: 'Envíe al menos una mutación.' })
    .max(MAX_MUTACIONES_POR_LOTE, {
      error: `Máximo ${MAX_MUTACIONES_POR_LOTE} mutaciones por envío.`,
    }),
});

/**
 * Resultado de una mutación del lote. `indice` es su posición en `mutaciones` (siempre presente);
 * `mutation_id` falta cuando no se pudo leer de la mutación recibida. Las mutaciones sin resultado
 * (por un error transitorio del servidor) siguen pendientes y se reenvían.
 */
export const resultadoMutacionSchema = z.object({
  indice: z.number().int().min(0),
  mutation_id: uuidV7Schema.optional(),
  resultado: z.enum(RESULTADOS_MUTACION),
  code: z.enum(CODIGOS_ERROR).optional(),
  message: z.string().optional(),
  /** En `conflicto`: la versión actual del registro en el servidor. */
  servidor: z.record(z.string(), z.unknown()).optional(),
});

export const syncPushResponseSchema = z.object({
  resultados: z.array(resultadoMutacionSchema),
});

/** Query de `GET /sync/pull`. Llega como texto; si falta, el cursor es 0. */
export const syncPullQuerySchema = z.object({
  cursor: z
    .string({ error: 'El cursor debe ser un entero mayor o igual a 0.' })
    .regex(/^(0|[1-9]\d{0,15})$/, { error: 'El cursor debe ser un entero mayor o igual a 0.' })
    .transform(Number)
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
    .default(0),
});

/**
 * Tipos de cambio de `/sync/pull` (ADR 0005, regla 6):
 * - `upsert`: estado actual de una entidad visible; el cliente la crea o la reemplaza.
 * - `revocar`: la entidad dejó de ser visible (por ejemplo, desasignación de una orden); el cliente
 *   borra sus datos locales, salvo los suyos pendientes de enviar.
 * - `hidratar`: el usuario ganó visibilidad sobre una entidad (asignación a `production_orders`);
 *   el cliente pide un snapshot paginado de ella, porque su cursor ya pasó su histórico.
 * - `reiniciar`: cambió el alcance del usuario (rol o reactivación); el cliente reinicia su estado
 *   sincronizado con un snapshot completo.
 * `hidratar` y `reiniciar` se atienden dentro del mismo candado de sync.
 */
export const TIPOS_CAMBIO_SYNC = ['upsert', 'revocar', 'hidratar', 'reiniciar'] as const;

export const cambioSyncSchema = z.object({
  seq: z.number().int().min(1),
  tipo: z.enum(TIPOS_CAMBIO_SYNC),
  /**
   * Nombre de tabla (`ENTIDADES_SYNC`). Se valida como texto para que un cliente viejo no falle
   * si un servidor nuevo agrega una entidad; el cliente ignora las que no conoce.
   */
  entidad: z.string().min(1),
  id: z.string().min(1),
  datos: z.record(z.string(), z.unknown()).nullable(),
});

export const syncPullResponseSchema = z.object({
  /**
   * Época de sync (`settings.sync_epoca`, ADR 0009). Cambia tras una restauración; si el cliente
   * recibe una distinta de la suya, reinicia cursor y estado y reenvía sus mutaciones aplicadas.
   */
  epoca: z.string().min(1),
  /** Último `seq` revisado (no el último devuelto); el cliente lo envía en el siguiente pull. */
  cursor: z.number().int().min(0),
  hay_mas: z.boolean(),
  cambios: z.array(cambioSyncSchema),
});

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------

export interface DetalleValidacion {
  /** Ruta del campo con puntos, por ejemplo `materiales.0.cantidad_planeada`. Vacía si es del objeto. */
  campo: string;
  mensaje: string;
}

/** Problema de validación mínimo: lo cumplen `ZodError` y el `$ZodError` de zod core. */
export interface ProblemaValidacion {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
}

/**
 * Convierte un error de Zod en `details` para el error `VALIDACION` (sin incluir los valores
 * recibidos). Acepta `ZodError` y el `$ZodError` de zod core (hook de @hono/zod-validator).
 */
export function detallesValidacion(error: {
  readonly issues: readonly ProblemaValidacion[];
}): DetalleValidacion[] {
  return error.issues.map((issue) => ({
    campo: issue.path.map(String).join('.'),
    mensaje: issue.message,
  }));
}

/**
 * Extrae un `mutation_id` UUID v7 válido de una mutación recibida, aunque el resto sea inválido.
 * Permite responder `rechazada` con `VALIDACION` identificando la mutación. Devuelve `null` si no
 * hay uno legible.
 */
export function leerMutationId(mutacion: unknown): string | null {
  if (typeof mutacion !== 'object' || mutacion === null || Array.isArray(mutacion)) {
    return null;
  }
  if (!Object.hasOwn(mutacion, 'mutation_id')) {
    return null;
  }
  const id: unknown = (mutacion as { mutation_id: unknown }).mutation_id;
  return esUuidV7(id) ? id : null;
}

// ---------------------------------------------------------------------------------------------
// Tipos inferidos (salida ya validada y normalizada)
// ---------------------------------------------------------------------------------------------

export type Login = z.infer<typeof loginSchema>;
export type CrearUsuario = z.infer<typeof crearUsuarioSchema>;
export type EditarUsuario = z.infer<typeof editarUsuarioSchema>;
export type CrearMaterial = z.infer<typeof crearMaterialSchema>;
export type EditarMaterial = z.infer<typeof editarMaterialSchema>;
export type Tolerancia = z.infer<typeof toleranciaSchema>;
export type AsignarSupervisores = z.infer<typeof asignarSupervisoresSchema>;
export type MaterialPlaneadoEntrada = z.infer<typeof materialPlaneadoSchema>;
export type CrearOrden = z.infer<typeof crearOrdenSchema>;
export type FinalizarOrden = z.infer<typeof finalizarOrdenSchema>;
export type CrearConsumo = z.infer<typeof crearConsumoSchema>;
export type EditarConsumo = z.infer<typeof editarConsumoSchema>;
export type EvidenciaMeta = z.infer<typeof evidenciaMetaSchema>;
export type CrearNovedad = z.infer<typeof crearNovedadSchema>;
export type Aprobar = z.infer<typeof aprobarSchema>;
export type Rechazar = z.infer<typeof rechazarSchema>;
export type Mutacion = z.infer<typeof mutacionSchema>;
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;
export type ResultadoMutacion = z.infer<typeof resultadoMutacionSchema>;
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;
export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;
export type TipoCambioSync = (typeof TIPOS_CAMBIO_SYNC)[number];
export type CambioSync = z.infer<typeof cambioSyncSchema>;
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;
/** Mutación de un tipo concreto, por ejemplo `MutacionDe<'consumo.crear'>`. */
export type MutacionDe<T extends Mutacion['tipo']> = Extract<Mutacion, { tipo: T }>;

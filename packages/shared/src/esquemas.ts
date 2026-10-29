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
import { CODIGOS_ERROR } from './errores';
import { REGEX_UUID_V7 } from './uuid';

// Efecto global intencional: todos los mensajes genéricos de Zod en español, en la PWA y en el Worker.
z.config(z.locales.es());

// ---------------------------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------------------------

export const uuidV7Schema = z
  .string({ error: 'El identificador es obligatorio.' })
  .regex(REGEX_UUID_V7, { error: 'El identificador no es un UUID v7 válido.' });

/** Instante ISO-8601 en UTC con `Z` (por ejemplo `2026-10-29T20:55:00.000Z`). Sin desfases horarios. */
export const isoFechaSchema = z.iso.datetime({
  error: 'La fecha debe estar en formato ISO-8601 UTC (terminada en Z).',
});

/** Tiene como máximo 3 decimales (el número es el double más cercano a un decimal de 3 cifras). */
function tieneMaximo3Decimales(valor: number): boolean {
  return Number(valor.toFixed(3)) === valor;
}

export const cantidadSchema = z
  .number({ error: 'La cantidad debe ser un número.' })
  .positive({ error: 'La cantidad debe ser mayor que cero.' })
  .max(1e9, { error: 'La cantidad es demasiado grande.' })
  .refine(tieneMaximo3Decimales, { error: 'La cantidad admite máximo 3 decimales.' });

export const loteSchema = z
  .string({ error: 'El lote es obligatorio.' })
  .trim()
  .min(1, { error: 'El lote es obligatorio.' })
  .max(64, { error: 'El lote admite máximo 64 caracteres.' });

export const emailSchema = z
  .string({ error: 'El correo es obligatorio.' })
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email({ error: 'El correo no es válido.' })
      .max(254, { error: 'El correo admite máximo 254 caracteres.' }),
  );

export const passwordSchema = z
  .string({ error: 'La contraseña es obligatoria.' })
  .min(10, { error: 'La contraseña debe tener al menos 10 caracteres.' })
  .max(128, { error: 'La contraseña admite máximo 128 caracteres.' });

const unidadSchema = z.enum(UNIDADES, { error: 'La unidad no es válida.' });
const rolSchema = z.enum(ROLES, { error: 'El rol no es válido.' });

function textoSchema(campo: string, min: number, max: number) {
  return z
    .string({ error: `${campo} es obligatorio.` })
    .trim()
    .min(min, {
      error:
        min <= 1 ? `${campo} es obligatorio.` : `${campo} debe tener al menos ${min} caracteres.`,
    })
    .max(max, { error: `${campo} admite máximo ${max} caracteres.` });
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
  device_id: uuidV7Schema,
  device_nombre: textoSchema('El nombre del dispositivo', 1, 100).optional(),
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

/** Edición de un consumo propio pendiente (S4). `version` es la que el cliente conoce (empieza en 1). */
export const editarConsumoSchema = z
  .object({
    id: uuidV7Schema,
    version: z
      .number({ error: 'La versión es obligatoria.' })
      .int({ error: 'La versión debe ser un entero.' })
      .min(1, { error: 'La versión debe ser mayor o igual a 1.' }),
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
  descripcion: textoSchema('La descripción', 1, 2000),
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

/** `id` es el id de la validación (UUID v7 generado por el cliente). */
export const aprobarSchema = z.object({
  id: uuidV7Schema,
  client_created_at: isoFechaSchema,
});

export const rechazarSchema = z.object({
  id: uuidV7Schema,
  motivo: textoSchema('El motivo del rechazo', 3, 500),
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

export const syncPushRequestSchema = z.object({
  device_id: uuidV7Schema,
  mutaciones: z
    .array(mutacionSchema, { error: 'La lista de mutaciones es obligatoria.' })
    .min(1, { error: 'Envíe al menos una mutación.' })
    .max(MAX_MUTACIONES_POR_LOTE, {
      error: `Máximo ${MAX_MUTACIONES_POR_LOTE} mutaciones por envío.`,
    }),
});

export const resultadoMutacionSchema = z.object({
  mutation_id: uuidV7Schema,
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

export const cambioSyncSchema = z.object({
  seq: z.number().int().min(1),
  tipo: z.enum(['upsert', 'revocar']),
  entidad: z.string().min(1),
  id: z.string().min(1),
  datos: z.record(z.string(), z.unknown()).nullable(),
});

export const syncPullResponseSchema = z.object({
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

/** Convierte un error de Zod en `details` para el error `VALIDACION` (sin incluir los valores recibidos). */
export function detallesValidacion(error: z.ZodError): DetalleValidacion[] {
  return error.issues.map((issue) => ({
    campo: issue.path.map(String).join('.'),
    mensaje: issue.message,
  }));
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
export type CambioSync = z.infer<typeof cambioSyncSchema>;
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;
/** Mutación de un tipo concreto, por ejemplo `MutacionDe<'consumo.crear'>`. */
export type MutacionDe<T extends Mutacion['tipo']> = Extract<Mutacion, { tipo: T }>;

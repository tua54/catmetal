// Esquema y conversiones del formulario "Nueva orden de producción" (`crearOrdenSchema` del
// contrato adaptado a la captura en la tablet) y lectura de los errores del servidor por campo.

import {
  cantidadSchema,
  crearOrdenSchema,
  parsearCantidad,
  UNIDADES,
  type CrearOrden,
} from '@catmetal/shared';
import type { FieldPath } from 'react-hook-form';
import { z } from 'zod';
import type { ErrorApi } from '../../auth';

const MENSAJE_CANTIDAD = 'Escriba una cantidad válida, con hasta 3 decimales (por ejemplo 125,5).';

/** `crearOrdenSchema` adaptado al formulario (la cantidad se escribe con coma o punto). */
export const esquemaFormulario = z.object({
  codigo: crearOrdenSchema.shape.codigo,
  linea: crearOrdenSchema.shape.linea,
  materiales: z
    .array(
      z.object({
        material_id: z.string().min(1, { error: 'Elija el material.' }),
        cantidad: z.string().superRefine((texto, ctx) => {
          if (texto.trim() === '') {
            ctx.addIssue({ code: 'custom', message: 'Escriba la cantidad planeada.' });
            return;
          }
          const numero = parsearCantidad(texto);
          const valida = numero === null ? null : cantidadSchema.safeParse(numero);
          if (valida === null || !valida.success) {
            ctx.addIssue({
              code: 'custom',
              message: valida?.error?.issues[0]?.message ?? MENSAJE_CANTIDAD,
            });
          }
        }),
        unidad: z.enum(UNIDADES, { error: 'Elija la unidad.' }),
      }),
    )
    .min(1, { error: 'La orden debe tener al menos un material planeado.' })
    .max(50, { error: 'Máximo 50 materiales por orden.' })
    .superRefine((filas, ctx) => {
      const vistos = new Set<string>();
      filas.forEach((fila, indice) => {
        if (fila.material_id !== '' && vistos.has(fila.material_id)) {
          ctx.addIssue({
            code: 'custom',
            path: [indice, 'material_id'],
            message: 'Este material ya está en la orden.',
          });
        }
        vistos.add(fila.material_id);
      });
    }),
});

export type ValoresOrden = z.infer<typeof esquemaFormulario>;
export type FilaMaterial = ValoresOrden['materiales'][number];

export const FILA_VACIA: FilaMaterial = { material_id: '', cantidad: '', unidad: 'kg' };

/** Valores del formulario → cuerpo de `POST /orders` (validado con el esquema del contrato). */
export function aCuerpoOrden(id: string, valores: ValoresOrden): CrearOrden {
  return crearOrdenSchema.parse({
    id,
    codigo: valores.codigo,
    linea: valores.linea,
    materiales: valores.materiales.map((m) => ({
      material_id: m.material_id,
      cantidad_planeada: parsearCantidad(m.cantidad),
      unidad: m.unidad,
    })),
  });
}

/** Campo del formulario al que apunta el `details` de un error del servidor, si se puede saber. */
export function campoDelError(
  error: ErrorApi,
): { campo: FieldPath<ValoresOrden>; mensaje: string }[] {
  const detalles = error.details;
  if (error.code === 'CONFLICTO') {
    const campos =
      typeof detalles === 'object' && detalles !== null && 'campos' in detalles
        ? detalles.campos
        : null;
    if (Array.isArray(campos) && campos.includes('codigo')) {
      return [{ campo: 'codigo', mensaje: 'Ya existe una orden con este código.' }];
    }
    return [];
  }
  const lista = Array.isArray(detalles) ? detalles : [detalles];
  return lista.flatMap((detalle) => {
    if (typeof detalle !== 'object' || detalle === null || !('campo' in detalle)) {
      return [];
    }
    const campo = (detalle as { campo: unknown }).campo;
    if (
      typeof campo !== 'string' ||
      !/^(codigo|linea|materiales\.\d+\.(material_id|unidad|cantidad_planeada))$/.test(campo)
    ) {
      return [];
    }
    const mensaje =
      'mensaje' in detalle && typeof (detalle as { mensaje: unknown }).mensaje === 'string'
        ? (detalle as { mensaje: string }).mensaje
        : error.message;
    return [
      {
        campo: campo.replace('cantidad_planeada', 'cantidad') as FieldPath<ValoresOrden>,
        mensaje,
      },
    ];
  });
}

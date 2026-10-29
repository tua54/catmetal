// Rutas de evidencias en R2 (docs/spec.md §6 punto 5, §7 y §9; tarea 2.2). El bucket es privado:
// las fotos solo salen por aquí, con verificación de permisos. Reglas en `dominio/evidencias.ts`.
//
// Esta sub-app se monta en la RAÍZ de `/api/v1` (app.ts) y declara sus rutas completas, con los
// middlewares POR RUTA.

import { idParamSchema, MAX_EVIDENCIA_BYTES } from '@catmetal/shared';
import { Hono } from 'hono';
import { contextoDesdeHono } from '../dominio/contexto';
import {
  buscarEvidencia,
  evidenciaPublica,
  leerCuerpoLimitado,
  planMarcarSubida,
  sha256Hex,
  tipoDeContenido,
  validarArchivo,
} from '../dominio/evidencias';
import { ejecutarPlan } from '../dominio/plan';
import { puedeVerConsumo } from '../dominio/visibilidad';
import { ErrorApi } from '../errores';
import { autenticar, requierePermiso } from '../middleware/autenticar';
import type { AppEnv } from '../tipos';
import { validar } from '../validacion';

export function crearRutasEvidencias(): Hono<AppEnv> {
  const rutas = new Hono<AppEnv>();

  rutas.put(
    '/evidences/:id',
    autenticar,
    requierePermiso('novedades.registrar'),
    validar('param', idParamSchema),
    async (c) => {
      // Si la cabecera ya anuncia más de 5 MB, se rechaza sin leer el cuerpo.
      const anunciado = Number(c.req.header('Content-Length') ?? '0');
      if (anunciado > MAX_EVIDENCIA_BYTES) {
        throw new ErrorApi('EVIDENCIA_DEMASIADO_GRANDE');
      }
      const ctx = contextoDesdeHono(c);
      const evidencia = await buscarEvidencia(ctx.db, c.req.valid('param').id);
      if (evidencia === null) {
        throw new ErrorApi('EVIDENCIA_DESCONOCIDA');
      }
      if (evidencia.novedad_registrada_por !== ctx.actor.id) {
        throw new ErrorApi('PERMISO_DENEGADO');
      }
      const bytes = await leerCuerpoLimitado(c.req.raw.body);
      if (bytes === null) {
        throw new ErrorApi('EVIDENCIA_DEMASIADO_GRANDE');
      }
      if (evidencia.subido === 1) {
        // Idempotente: la misma foto otra vez responde 200 sin reescribir R2; otra distinta, 409.
        if ((await sha256Hex(bytes)) === evidencia.sha256) {
          return c.json(evidenciaPublica(evidencia));
        }
        throw new ErrorApi('EVIDENCIA_YA_SUBIDA');
      }
      const tipo = tipoDeContenido(c.req.header('Content-Type'));
      const sha256 = await validarArchivo(evidencia, bytes, tipo);
      await c.env.EVIDENCE.put(evidencia.storage_key, bytes, {
        sha256,
        httpMetadata: { contentType: evidencia.mime },
        customMetadata: { sha256 },
      });
      const plan = planMarcarSubida(ctx, evidencia);
      try {
        return c.json(await ejecutarPlan(ctx.db, plan));
      } catch (error) {
        // Otra subida de la misma foto (mismo sha256, ya verificado) ganó la carrera: idempotente.
        const actual =
          error === plan.siNoAplica ? await buscarEvidencia(ctx.db, evidencia.id) : null;
        if (actual?.subido === 1) {
          return c.json(evidenciaPublica(actual));
        }
        throw error;
      }
    },
  );

  rutas.get('/evidences/:id', autenticar, validar('param', idParamSchema), async (c) => {
    const ctx = contextoDesdeHono(c);
    const evidencia = await buscarEvidencia(ctx.db, c.req.valid('param').id);
    const visible =
      evidencia !== null &&
      evidencia.subido === 1 &&
      (await puedeVerConsumo(ctx, {
        order_id: evidencia.order_id,
        registrado_por: evidencia.consumo_registrado_por,
      }));
    const objeto = visible ? await c.env.EVIDENCE.get(evidencia.storage_key) : null;
    if (evidencia === null || objeto === null) {
      throw new ErrorApi('NO_ENCONTRADO');
    }
    return new Response(objeto.body, {
      headers: {
        // El tipo es el guardado en D1 (verificado por magic bytes al subir), nunca uno del cliente.
        'Content-Type': evidencia.mime,
        'Content-Length': String(objeto.size),
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
      },
    });
  });

  return rutas;
}
